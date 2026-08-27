import { randomBytes, randomInt } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';

const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 15 * 1000;
const MAX_QUEUE = 20;
const MAX_BODY = 16 * 1024;

const pairingCodes = new Map();
const sessions = new Map();

const ACTIONS = Object.freeze({
  wave: { label: '🌊 Próxima wave', action: 'wave_next' },
  copper: { label: '🟠 +100 cobre', action: 'copper_100' },
  heal: { label: '💚 Curar núcleo', action: 'heal_core' },
});

const actionChoices = Object.entries(ACTIONS).map(([value, data]) => ({ name: data.label, value }));

export const mindustryCommandBuilder = new SlashCommandBuilder()
  .setName('mindustry')
  .setDescription('Controla o Mindustry Game Interactive.')
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra o status da conexão com o Mindustry.'))
  .addSubcommand((sub) => sub.setName('vincular').setDescription('Gera um código privado para vincular o mod.'))
  .addSubcommand((sub) => sub.setName('abrir').setDescription('Abre as interações da comunidade.'))
  .addSubcommand((sub) => sub.setName('fechar').setDescription('Fecha as interações da comunidade.'))
  .addSubcommand((sub) => sub
    .setName('acao')
    .setDescription('Envia uma interação segura ao Mindustry.')
    .addStringOption((option) => option
      .setName('tipo')
      .setDescription('Escolha a ação.')
      .setRequired(true)
      .addChoices(...actionChoices)));

export const mindustryCommandData = mindustryCommandBuilder.toJSON();

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function cleanupPairCodes(now = Date.now()) {
  for (const [code, pair] of pairingCodes) {
    if (pair.expiresAt <= now) pairingCodes.delete(code);
  }
}

function activeSessionForGuild(guildId, now = Date.now()) {
  for (const session of sessions.values()) {
    if (session.guildId === guildId && now - session.lastSeenAt <= ONLINE_TTL_MS) return session;
  }
  return null;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

export async function handleMindustryHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/mindustry/')) return false;

  if (url.pathname === '/mindustry/pair' && req.method === 'POST') {
    cleanupPairCodes();
    try {
      const body = await readJson(req);
      const code = String(body.code || '').trim();
      const pair = pairingCodes.get(code);
      if (!pair || pair.expiresAt <= Date.now()) {
        json(res, 401, { ok: false, error: 'invalid_or_expired_code' });
        return true;
      }

      pairingCodes.delete(code);
      for (const [token, session] of sessions) {
        if (session.guildId === pair.guildId && session.ownerId === pair.ownerId) sessions.delete(token);
      }

      const token = randomBytes(32).toString('base64url');
      sessions.set(token, {
        guildId: pair.guildId,
        ownerId: pair.ownerId,
        linkedAt: Date.now(),
        lastSeenAt: Date.now(),
        interactionsOpen: false,
        queue: [],
      });
      json(res, 200, { ok: true, token, pollAfterMs: 1500 });
      return true;
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
      return true;
    }
  }

  if (url.pathname === '/mindustry/pull' && req.method === 'GET') {
    const token = bearer(req);
    const session = sessions.get(token);
    if (!session) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    session.lastSeenAt = Date.now();
    const action = session.queue.shift() || null;
    json(res, 200, {
      ok: true,
      action,
      interactionsOpen: session.interactionsOpen,
      pollAfterMs: 1500,
    });
    return true;
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}

export function mindustryStatus(guildId) {
  const session = guildId ? activeSessionForGuild(guildId) : null;
  return {
    connected: Boolean(session),
    interactionsOpen: Boolean(session?.interactionsOpen),
    linkedAt: session?.linkedAt ? new Date(session.linkedAt).toISOString() : null,
    lastSeenAt: session?.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : null,
  };
}

export async function handleMindustryCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'mindustry' || !interaction.guild) return false;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const session = activeSessionForGuild(guildId);

  if (sub === 'status') {
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🎮 Mindustry Game Interactive',
        description: [
          `🎮 **Mindustry:** ${session ? '🟢 conectado' : '🔴 desconectado'}`,
          `🎛️ **Interações:** ${session?.interactionsOpen ? '🟢 abertas' : '🔒 fechadas'}`,
          '',
          session
            ? 'O mod está falando com o bot por HTTPS.'
            : 'O dono usa `/mindustry vincular` e digita o código dentro do mod.',
        ].join('\n'),
        color: session ? CHARACTER.palette.success : CHARACTER.palette.warning,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'vincular') {
    if (!ownerOnly(interaction)) {
      await interaction.reply({ content: 'Somente o dono real do servidor pode vincular o Mindustry.', flags: MessageFlags.Ephemeral });
      return true;
    }

    cleanupPairCodes();
    let code;
    do code = String(randomInt(100000, 1000000)); while (pairingCodes.has(code));
    pairingCodes.set(code, {
      guildId,
      ownerId: interaction.user.id,
      expiresAt: Date.now() + PAIR_TTL_MS,
    });

    await interaction.reply({
      content: `🎮 Código privado do **MiojoPlays Interactive**: **${code}**\n\nAbra o Mindustry com o mod instalado e digite esse código quando ele pedir. Expira em 10 minutos.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'abrir' || sub === 'fechar') {
    if (!ownerOnly(interaction)) {
      await interaction.reply({ content: 'Somente o dono real do servidor pode abrir ou fechar as interações.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!session) {
      await interaction.reply({ content: '❌ O Mindustry ainda não está conectado.', flags: MessageFlags.Ephemeral });
      return true;
    }
    session.interactionsOpen = sub === 'abrir';
    await interaction.reply({ content: session.interactionsOpen ? '🟢 Mindustry Interactive **ABERTO**.' : '🔒 Mindustry Interactive **FECHADO**.' });
    return true;
  }

  if (sub === 'acao') {
    if (!session) {
      await interaction.reply({ content: '🎮 O Mindustry não está conectado agora.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!session.interactionsOpen) {
      await interaction.reply({ content: '🔒 As interações estão fechadas pelo dono.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const id = interaction.options.getString('tipo', true);
    const selected = ACTIONS[id];
    if (!selected) {
      await interaction.reply({ content: 'Ação inválida.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (session.queue.length >= MAX_QUEUE) session.queue.shift();
    session.queue.push({ id: randomBytes(8).toString('hex'), type: selected.action, by: interaction.user.username });
    await interaction.reply({ content: `${selected.label} enviado para a fila do jogo. ✅` });
    return true;
  }

  return false;
}
