import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { DATA_CHANNEL_NAME, getProfile, mutateProfile } from './communityStore.js';

const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 30 * 1000;
const ACTION_LEASE_MS = 12 * 1000;
const MAX_QUEUE = 30;
const MAX_BODY = 16 * 1024;
const TOKEN_PREFIX = 'mioTerraria1';

const pairingCodes = new Map();
const sessions = new Map();

const ACTIONS = Object.freeze({
  boss: { label: '👁️ Boss', action: 'boss_eye' },
  horde: { label: '🧟 Horda', action: 'horde_zombie' },
  meteor: { label: '☄️ Meteoro', action: 'meteor' },
  bloodmoon: { label: '🌕 Lua de Sangue', action: 'blood_moon' },
  kill: { label: '💀 Matar jogador', action: 'kill_player' },
  heal: { label: '💚 Curar jogador', action: 'heal_player' },
  day: { label: '☀️ Virar dia', action: 'time_day' },
  night: { label: '🌙 Virar noite', action: 'time_night' },
  rain: { label: '🌧️ Chuva', action: 'rain_toggle' },
  butcher: { label: '🧹 Limpar inimigos', action: 'butcher_hostile' },
});

const actionChoices = Object.entries(ACTIONS).map(([value, data]) => ({ name: data.label, value }));

export const terrariaCommandBuilder = new SlashCommandBuilder()
  .setName('terraria')
  .setDescription('Controla o Terraria Game Interactive.')
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra o status da ponte com o Terraria/TShock.'))
  .addSubcommand((sub) => sub.setName('vincular').setDescription('Gera um código privado para vincular a ponte Terraria.'))
  .addSubcommand((sub) => sub.setName('abrir').setDescription('Abre as interações da comunidade.'))
  .addSubcommand((sub) => sub.setName('fechar').setDescription('Fecha as interações da comunidade.'))
  .addSubcommand((sub) => sub
    .setName('acao')
    .setDescription('Envia uma ação de teste para o Terraria.')
    .addStringOption((option) => option
      .setName('tipo')
      .setDescription('Escolha a ação.')
      .setRequired(true)
      .addChoices(...actionChoices)));

export const terrariaCommandData = terrariaCommandBuilder.toJSON();

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
  const escapedPrefix = TOKEN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escapedPrefix}\\.(\\d{15,22})\\.(\\d{15,22})\\.([A-Za-z0-9_-]{40,80})$`).exec(token || '');
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
    lastActionAt: null,
    lastError: null,
    interactionsOpen: false,
    tshockReady: false,
    playerName: '',
    bridgeVersion: '',
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
  if (!safeHashEqual(profile.terrariaLinkHash, tokenHash(token))) return null;

  const linkedAt = Math.max(0, Number(profile.terrariaLinkedAt) || 0) || Date.now();
  return replaceRuntimeSession(token, createRuntimeSession({
    guildId: parsed.guildId,
    ownerId: parsed.ownerId,
    linkedAt,
  }));
}

function nextLeasableAction(session, now = Date.now()) {
  const action = session.queue.find((item) => !item.leasedAt || now - item.leasedAt >= ACTION_LEASE_MS);
  if (!action) return null;
  action.leasedAt = now;
  action.attempts += 1;
  return {
    id: action.id,
    type: action.type,
    by: action.by,
    attempts: action.attempts,
    createdAt: action.createdAt,
  };
}

function updateBridgeMetadata(session, url) {
  session.lastSeenAt = Date.now();
  session.tshockReady = url.searchParams.get('tshock') === '1';
  session.playerName = String(url.searchParams.get('player') || session.playerName || '').trim().slice(0, 32);
  session.bridgeVersion = String(url.searchParams.get('version') || session.bridgeVersion || '').trim().slice(0, 32);
}

export async function handleTerrariaHttp(req, res, client = null) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/terraria/')) return false;

  if (url.pathname === '/terraria/pair' && req.method === 'POST') {
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
        profile.terrariaLinkHash = tokenHash(token);
        profile.terrariaLinkedAt = linkedAt;
      }, { immediate: true });

      pairingCodes.delete(code);
      const session = createRuntimeSession({
        guildId: pair.guildId,
        ownerId: pair.ownerId,
        linkedAt,
      });
      session.playerName = String(body.playerName || '').trim().slice(0, 32);
      session.bridgeVersion = String(body.version || '').trim().slice(0, 32);
      replaceRuntimeSession(token, session);

      json(res, 200, { ok: true, token, pollAfterMs: 1200 });
      return true;
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
      return true;
    }
  }

  if (url.pathname === '/terraria/pull' && req.method === 'GET') {
    const token = bearer(req);
    let session = sessions.get(token);
    if (!session) session = await restorePersistentSession(client, token);

    if (!session) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    updateBridgeMetadata(session, url);
    const action = nextLeasableAction(session);
    json(res, 200, {
      ok: true,
      action,
      interactionsOpen: session.interactionsOpen,
      pollAfterMs: 1200,
    });
    return true;
  }

  if (url.pathname === '/terraria/ack' && req.method === 'POST') {
    const token = bearer(req);
    let session = sessions.get(token);
    if (!session) session = await restorePersistentSession(client, token);
    if (!session) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    try {
      const body = await readJson(req);
      const id = String(body.id || '').trim();
      const index = session.queue.findIndex((item) => item.id === id);
      if (index < 0) {
        json(res, 404, { ok: false, error: 'action_not_found' });
        return true;
      }

      const [action] = session.queue.splice(index, 1);
      session.lastSeenAt = Date.now();
      session.lastActionAt = new Date().toISOString();
      session.lastError = body.ok === false ? String(body.error || 'bridge_action_failed').slice(0, 240) : null;
      json(res, 200, { ok: true, actionId: action.id });
      return true;
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
      return true;
    }
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}

export function terrariaStatus(guildId) {
  const session = guildId ? activeSessionForGuild(guildId) : null;
  return {
    connected: Boolean(session),
    tshockReady: Boolean(session?.tshockReady),
    interactionsOpen: Boolean(session?.interactionsOpen),
    linkedAt: session?.linkedAt ? new Date(session.linkedAt).toISOString() : null,
    lastSeenAt: session?.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : null,
    lastActionAt: session?.lastActionAt || null,
    lastError: session?.lastError || null,
    playerName: session?.playerName || null,
    bridgeVersion: session?.bridgeVersion || null,
    queued: session?.queue.length || 0,
  };
}

export function enqueueTerrariaAction(guildId, actionId, by = 'viewer') {
  const session = guildId ? activeSessionForGuild(guildId) : null;
  if (!session) return { ok: false, error: 'disconnected' };
  if (!session.tshockReady) return { ok: false, error: 'tshock_unavailable' };
  if (!session.interactionsOpen) return { ok: false, error: 'closed' };

  const selected = ACTIONS[actionId];
  if (!selected) return { ok: false, error: 'invalid_action' };

  while (session.queue.length >= MAX_QUEUE) session.queue.shift();
  session.queue.push({
    id: randomBytes(8).toString('hex'),
    type: selected.action,
    by: String(by || 'viewer').slice(0, 80),
    attempts: 0,
    leasedAt: 0,
    createdAt: new Date().toISOString(),
  });
  return { ok: true, label: selected.label, action: selected.action };
}

export async function handleTerrariaCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'terraria' || !interaction.guild) return false;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const session = activeSessionForGuild(guildId);

  if (sub === 'status') {
    const status = terrariaStatus(guildId);
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🌳 Terraria Game Interactive',
        description: [
          `🔌 **Ponte:** ${status.connected ? '🟢 conectada' : '🔴 desconectada'}`,
          `🛠️ **TShock:** ${status.tshockReady ? '🟢 pronto' : '🔴 indisponível'}`,
          `🎛️ **Interações:** ${status.interactionsOpen ? '🟢 abertas' : '🔒 fechadas'}`,
          `👤 **Jogador alvo:** ${status.playerName || 'não informado'}`,
          `📦 **Fila:** ${status.queued}`,
          '',
          status.lastError ? `⚠️ Último erro: ${status.lastError}` : 'Nenhum erro recente registrado.',
        ].join('\n'),
        color: status.connected && status.tshockReady ? CHARACTER.palette.success : CHARACTER.palette.warning,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'vincular') {
    if (!ownerOnly(interaction)) {
      await interaction.reply({ content: 'Somente o dono real do servidor pode vincular o Terraria.', flags: MessageFlags.Ephemeral });
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
      content: `🌳 Código privado do **Terraria Interactive**: **${code}**\n\nDigite esse código na ponte do Terraria. Expira em 10 minutos. O vínculo fica persistido para reconectar depois de reinícios.`,
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
      await interaction.reply({ content: '❌ A ponte do Terraria ainda não está conectada.', flags: MessageFlags.Ephemeral });
      return true;
    }
    session.interactionsOpen = sub === 'abrir';
    await interaction.reply({ content: session.interactionsOpen ? '🟢 Terraria Interactive **ABERTO**.' : '🔒 Terraria Interactive **FECHADO**.' });
    return true;
  }

  if (sub === 'acao') {
    const id = interaction.options.getString('tipo', true);
    const result = enqueueTerrariaAction(guildId, id, interaction.user.username);
    if (!result.ok) {
      const messages = {
        disconnected: '🌳 A ponte do Terraria não está conectada agora.',
        tshock_unavailable: '🛠️ A ponte está online, mas o TShock não respondeu.',
        closed: '🔒 As interações estão fechadas pelo dono.',
        invalid_action: 'Ação inválida.',
      };
      await interaction.reply({ content: messages[result.error] || 'Não foi possível enviar a ação.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({ content: `${result.label} enviado para a fila do Terraria. ✅` });
    return true;
  }

  return false;
}
