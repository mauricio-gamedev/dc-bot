import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { DATA_CHANNEL_NAME, getProfile, mutateProfile } from './communityStore.js';

const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 30 * 1000;
const MAX_QUEUE = 20;
const MAX_BODY = 16 * 1024;
const TOKEN_PREFIX = 'mio1';

const pairingCodes = new Map();
const sessions = new Map();

const ACTIONS = Object.freeze({
  wave: { label: '🌊 Próxima wave', action: 'wave_next' },
  horde: { label: '👹 Horda: +3 waves', action: 'wave_horde' },
  copper: { label: '🟠 +100 cobre', action: 'copper_100' },
  lead: { label: '⚙️ +100 chumbo', action: 'lead_100' },
  graphite: { label: '⬛ +75 grafite', action: 'graphite_75' },
  silicon: { label: '🔷 +75 silício', action: 'silicon_75' },
  titanium: { label: '🔹 +50 titânio', action: 'titanium_50' },
  thorium: { label: '🟣 +30 tório', action: 'thorium_30' },
  heal: { label: '💚 Curar núcleo', action: 'heal_core' },
  boost: { label: '⚡ Boost do jogador', action: 'player_boost' },
  slow: { label: '🐌 Lentidão no jogador', action: 'player_slow' },
  freeze: { label: '❄️ Congelar jogador', action: 'player_freeze' },
  burn: { label: '🔥 Incendiar jogador', action: 'player_burn' },
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

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function createPersistentToken(guildId, ownerId) {
  const secret = randomBytes(32).toString('base64url');
  return `${TOKEN_PREFIX}.${guildId}.${ownerId}.${secret}`;
}

function parsePersistentToken(token) {
  const match = new RegExp(`^${TOKEN_PREFIX}\\.(\\d{15,22})\\.(\\d{15,22})\\.([A-Za-z0-9_-]{40,80})$`).exec(token || '');
  if (!match) return null;
  return { guildId: match[1], ownerId: match[2] };
}

async function resolveGuild(client, guildId) {
  if (!client?.guilds) return null;
  return client.guilds.cache.get(guildId) ?? client.guilds.fetch(guildId).catch(() => null);
}

function hasPersistenceChannel(guild) {
  return guild.channels.cache.some(
    (channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased(),
  );
}

function createRuntimeSession({ guildId, ownerId, linkedAt = Date.now() }) {
  return {
    guildId,
    ownerId,
    linkedAt,
    lastSeenAt: Date.now(),
    interactionsOpen: false,
    queue: [],
  };
}

function replaceRuntimeSession(token, session) {
  for (const [existingToken, existing] of sessions) {
    if (existing.guildId === session.guildId && existing.ownerId === session.ownerId && existingToken !== token) {
      sessions.delete(existingToken);
    }
  }
  sessions.set(token, session);
  return session;
}

async function restorePersistentSession(client, token) {
  const parsed = parsePersistentToken(token);
  if (!parsed) return null;

  const guild = await resolveGuild(client, parsed.guildId);
  if (!guild || guild.ownerId !== parsed.ownerId) return null;

  const profile = await getProfile(guild, parsed.ownerId);
  if (!safeHashEqual(profile.mindustryLinkHash, tokenHash(token))) return null;

  const linkedAt = Math.max(0, Number(profile.mindustryLinkedAt) || 0) || Date.now();
  return replaceRuntimeSession(token, createRuntimeSession({
    guildId: parsed.guildId,
    ownerId: parsed.ownerId,
    linkedAt,
  }));
}

export async function handleMindustryHttp(req, res, client = null) {
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

      const guild = await resolveGuild(client, pair.guildId);
      if (!guild || guild.ownerId !== pair.ownerId) {
        json(res, 409, { ok: false, error: 'guild_owner_mismatch' });
        return true;
      }

      await guild.channels.fetch().catch(() => {});
      if (!hasPersistenceChannel(guild)) {
        json(res, 503, { ok: false, error: 'persistence_unavailable' });
        return true;
      }

      const token = createPersistentToken(pair.guildId, pair.ownerId);
      const linkedAt = Date.now();
      await mutateProfile(guild, pair.ownerId, (profile) => {
        profile.mindustryLinkHash = tokenHash(token);
        profile.mindustryLinkedAt = linkedAt;
      }, { immediate: true });

      pairingCodes.delete(code);
      replaceRuntimeSession(token, createRuntimeSession({
        guildId: pair.guildId,
        ownerId: pair.ownerId,
        linkedAt,
      }));

      json(res, 200, { ok: true, token, pollAfterMs: 1500 });
      return true;
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
      return true;
    }
  }

  if (url.pathname === '/mindustry/pull' && req.method === 'GET') {
    const token = bearer(req);
    let session = sessions.get(token);
    if (!session) session = await restorePersistentSession(client, token);

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

export function enqueueMindustryAction(guildId, actionId, by = 'viewer') {
  const session = guildId ? activeSessionForGuild(guildId) : null;
  if (!session) return { ok: false, error: 'disconnected' };
  if (!session.interactionsOpen) return { ok: false, error: 'closed' };

  const selected = ACTIONS[actionId];
  if (!selected) return { ok: false, error: 'invalid_action' };

  if (session.queue.length >= MAX_QUEUE) session.queue.shift();
  session.queue.push({
    id: randomBytes(8).toString('hex'),
    type: selected.action,
    by: String(by || 'viewer').slice(0, 80),
  });
  return { ok: true, label: selected.label, action: selected.action };
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
            ? 'O mod está falando com o bot por HTTPS e pode se reconectar após reinícios.'
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
      content: `🎮 Código privado do **MiojoPlays Interactive**: **${code}**\n\nAbra o Mindustry com o mod instalado e digite esse código quando ele pedir. Expira em 10 minutos. Depois do vínculo, o mod poderá se reconectar sozinho após reinícios do bot.`,
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
    const id = interaction.options.getString('tipo', true);
    const result = enqueueMindustryAction(guildId, id, interaction.user.username);
    if (!result.ok) {
      const messages = {
        disconnected: '🎮 O Mindustry não está conectado agora.',
        closed: '🔒 As interações estão fechadas pelo dono.',
        invalid_action: 'Ação inválida.',
      };
      await interaction.reply({ content: messages[result.error] || 'Não foi possível enviar a ação.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({ content: `${result.label} enviado para a fila do jogo. ✅` });
    return true;
  }

  return false;
}
