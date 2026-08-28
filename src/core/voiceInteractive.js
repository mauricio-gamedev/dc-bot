import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { DATA_CHANNEL_NAME, getProfile, mutateProfile } from './communityStore.js';

const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_TTL_MS = 30 * 1000;
const MAX_BODY = 8 * 1024;
const TOKEN_PREFIX = 'mvoice1';
const POLL_AFTER_MS = 1000;

const pairingCodes = new Map();
const sessions = new Map();

export const VOICE_PRESETS = Object.freeze({
  normal: {
    label: '🎙️ Normal',
    description: 'Sem transformação; mantém apenas o pipeline de baixa latência.',
    dsp: { pitch: 0, formant: 0, bass: 0, presence: 0, drive: 0, reverb: 0, robot: 0 },
  },
  shonen: {
    label: '⚡ Herói Shonen',
    description: 'Voz mais jovem, aberta e energética, inspirada em protagonistas de anime.',
    dsp: { pitch: 1.5, formant: 1.0, bass: -1, presence: 3, drive: 0.04, reverb: 0.03, robot: 0 },
  },
  rival: {
    label: '🔥 Rival Anime',
    description: 'Voz firme, agressiva e com presença maior.',
    dsp: { pitch: -0.5, formant: -0.5, bass: 2, presence: 4, drive: 0.10, reverb: 0.02, robot: 0 },
  },
  dark_villain: {
    label: '🌑 Vilão Sombrio',
    description: 'Grave, densa e ameaçadora sem depender de IA pesada.',
    dsp: { pitch: -4.0, formant: -2.5, bass: 5, presence: -1, drive: 0.16, reverb: 0.08, robot: 0 },
  },
  masked_ninja: {
    label: '🥷 Ninja Mascarado',
    description: 'Baixa, fechada e discreta, com timbre de personagem mascarado.',
    dsp: { pitch: -2.0, formant: -1.2, bass: 2, presence: -2, drive: 0.05, reverb: 0.03, robot: 0 },
  },
  spirit: {
    label: '👻 Espírito',
    description: 'Leve, aérea e sobrenatural com ambiência controlada.',
    dsp: { pitch: 3.0, formant: 2.0, bass: -3, presence: 2, drive: 0, reverb: 0.30, robot: 0 },
  },
  chibi: {
    label: '✨ Chibi',
    description: 'Mais aguda e pequena, mantendo inteligibilidade.',
    dsp: { pitch: 5.0, formant: 3.4, bass: -4, presence: 2, drive: 0, reverb: 0.02, robot: 0 },
  },
  giant: {
    label: '👹 Colosso',
    description: 'Muito grave e encorpada para personagens gigantes ou demônios.',
    dsp: { pitch: -6.0, formant: -4.0, bass: 6, presence: -2, drive: 0.12, reverb: 0.10, robot: 0 },
  },
  android: {
    label: '🤖 Androide',
    description: 'Timbre sintético com componente robótico leve.',
    dsp: { pitch: -1.0, formant: 0, bass: 1, presence: 2, drive: 0.06, reverb: 0.04, robot: 0.32 },
  },
});

const presetChoices = Object.entries(VOICE_PRESETS).map(([value, preset]) => ({
  name: preset.label,
  value,
}));

export const voiceCommandBuilder = new SlashCommandBuilder()
  .setName('voz')
  .setDescription('Controla o Mio Voice System no seu Android.')
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra conexão, preset e rota de áudio atual.'))
  .addSubcommand((sub) => sub.setName('personagens').setDescription('Lista os estilos de personagem disponíveis.'))
  .addSubcommand((sub) => sub.setName('vincular').setDescription('Gera um código privado para vincular o Android.'))
  .addSubcommand((sub) => sub.setName('desvincular').setDescription('Revoga o Android vinculado ao Voice System.'))
  .addSubcommand((sub) => sub
    .setName('escolher')
    .setDescription('Seleciona o estilo de voz ativo.')
    .addStringOption((option) => option
      .setName('personagem')
      .setDescription('Estilo de personagem.')
      .setRequired(true)
      .addChoices(...presetChoices)))
  .addSubcommand((sub) => sub
    .setName('intensidade')
    .setDescription('Ajusta quanto do efeito é aplicado.')
    .addIntegerOption((option) => option
      .setName('valor')
      .setDescription('0 a 100.')
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true)))
  .addSubcommand((sub) => sub.setName('normal').setDescription('Volta imediatamente para a voz normal.'));

export const voiceCommandData = voiceCommandBuilder.toJSON();

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function cleanupPairCodes(now = Date.now()) {
  for (const [code, pair] of pairingCodes) {
    if (pair.expiresAt <= now) pairingCodes.delete(code);
  }
}

function clampIntensity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 70;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normalizePreset(value) {
  return Object.hasOwn(VOICE_PRESETS, value) ? value : 'normal';
}

function configFromProfile(profile) {
  const preset = normalizePreset(profile.voicePreset);
  return {
    preset,
    intensity: clampIntensity(profile.voiceIntensity),
  };
}

function buildEngineConfig(config) {
  const preset = VOICE_PRESETS[normalizePreset(config.preset)];
  const intensity = clampIntensity(config.intensity);
  const mix = intensity / 100;
  return {
    preset: normalizePreset(config.preset),
    label: preset.label,
    intensity,
    mix,
    dsp: preset.dsp,
  };
}

function activeSessionForGuild(guildId, now = Date.now()) {
  for (const session of sessions.values()) {
    if (session.guildId === guildId && now - session.lastSeenAt <= ONLINE_TTL_MS) return session;
  }
  return null;
}

function anySessionForGuild(guildId) {
  for (const session of sessions.values()) {
    if (session.guildId === guildId) return session;
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

function createRuntimeSession({ guildId, ownerId, linkedAt, config }) {
  return {
    guildId,
    ownerId,
    linkedAt,
    lastSeenAt: Date.now(),
    revision: 1,
    config: { ...config },
    device: {
      name: '',
      engine: '',
      route: 'unknown',
      latencyMs: null,
      androidVersion: '',
    },
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
  if (!safeHashEqual(profile.voiceLinkHash, tokenHash(token))) return null;

  return replaceRuntimeSession(token, createRuntimeSession({
    guildId: parsed.guildId,
    ownerId: parsed.ownerId,
    linkedAt: Math.max(0, Number(profile.voiceLinkedAt) || 0) || Date.now(),
    config: configFromProfile(profile),
  }));
}

async function authenticatedSession(req, client) {
  const token = bearer(req);
  if (!token) return null;
  const existing = sessions.get(token);
  if (existing) return existing;
  return restorePersistentSession(client, token);
}

function safeDeviceReport(body) {
  const routeOptions = new Set(['unknown', 'monitor', 'headset', 'experimental-game', 'unsupported']);
  const latency = Number(body.latencyMs);
  return {
    name: String(body.deviceName || '').slice(0, 80),
    engine: String(body.engine || '').slice(0, 80),
    route: routeOptions.has(body.route) ? body.route : 'unknown',
    latencyMs: Number.isFinite(latency) ? Math.min(5000, Math.max(0, Math.round(latency))) : null,
    androidVersion: String(body.androidVersion || '').slice(0, 40),
  };
}

function updateRuntimeConfig(guildId, config) {
  const session = anySessionForGuild(guildId);
  if (!session) return;
  session.config = { ...config };
  session.revision += 1;
}

function revokeGuildSessions(guildId, ownerId) {
  for (const [token, session] of sessions) {
    if (session.guildId === guildId && session.ownerId === ownerId) sessions.delete(token);
  }
}

export async function handleVoiceHttp(req, res, client = null) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/voice/')) return false;

  if (url.pathname === '/voice/pair' && req.method === 'POST') {
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
      const profile = await mutateProfile(guild, pair.ownerId, (target) => {
        target.voiceLinkHash = tokenHash(token);
        target.voiceLinkedAt = linkedAt;
        target.voicePreset = normalizePreset(target.voicePreset);
        target.voiceIntensity = clampIntensity(target.voiceIntensity);
      }, { immediate: true });

      pairingCodes.delete(code);
      const session = replaceRuntimeSession(token, createRuntimeSession({
        guildId: pair.guildId,
        ownerId: pair.ownerId,
        linkedAt,
        config: configFromProfile(profile),
      }));
      session.device = safeDeviceReport(body);

      json(res, 200, {
        ok: true,
        token,
        pollAfterMs: POLL_AFTER_MS,
        config: buildEngineConfig(session.config),
      });
      return true;
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
      return true;
    }
  }

  if (url.pathname === '/voice/pull' && req.method === 'GET') {
    const session = await authenticatedSession(req, client);
    if (!session) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    session.lastSeenAt = Date.now();
    json(res, 200, {
      ok: true,
      revision: session.revision,
      config: buildEngineConfig(session.config),
      pollAfterMs: POLL_AFTER_MS,
      note: 'O Android aplica o DSP localmente; o Render nunca recebe áudio do microfone.',
    });
    return true;
  }

  if (url.pathname === '/voice/report' && req.method === 'POST') {
    const session = await authenticatedSession(req, client);
    if (!session) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    try {
      const body = await readJson(req);
      session.lastSeenAt = Date.now();
      session.device = safeDeviceReport(body);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
    }
    return true;
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}

export function voiceStatus(guildId) {
  const session = guildId ? activeSessionForGuild(guildId) : null;
  return {
    connected: Boolean(session),
    linkedAt: session?.linkedAt ? new Date(session.linkedAt).toISOString() : null,
    lastSeenAt: session?.lastSeenAt ? new Date(session.lastSeenAt).toISOString() : null,
    preset: session?.config?.preset || null,
    intensity: session?.config?.intensity ?? null,
    device: session?.device || null,
  };
}

export async function handleVoiceCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'voz' || !interaction.guild) return false;

  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const guildId = guild.id;
  const profile = await getProfile(guild, guild.ownerId);
  const savedConfig = configFromProfile(profile);
  const session = activeSessionForGuild(guildId);

  if (sub === 'status') {
    const preset = VOICE_PRESETS[savedConfig.preset];
    const route = session?.device?.route || 'offline';
    const latency = session?.device?.latencyMs == null ? '—' : `${session.device.latencyMs} ms`;
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🎙️ Mio Voice System',
        description: [
          `📱 **Android:** ${session ? '🟢 conectado' : '🔴 desconectado'}`,
          `🎭 **Voz:** ${preset.label}`,
          `🎚️ **Intensidade:** ${savedConfig.intensity}%`,
          `🔊 **Rota:** ${route}`,
          `⏱️ **Latência reportada:** ${latency}`,
          '',
          'O bot controla o preset; o áudio é processado localmente no Android e não passa pelo Render.',
        ].join('\n'),
        color: session ? CHARACTER.palette.success : CHARACTER.palette.warning,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'personagens') {
    const lines = Object.values(VOICE_PRESETS).map((preset) => `**${preset.label}** — ${preset.description}`);
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🎭 Vozes de personagem',
        description: lines.join('\n'),
        color: CHARACTER.palette.accent,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!ownerOnly(interaction)) {
    await interaction.reply({
      content: 'Somente o dono real do servidor pode controlar ou vincular o Mio Voice System.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'vincular') {
    cleanupPairCodes();
    let code;
    do code = String(randomInt(100000, 1000000)); while (pairingCodes.has(code));
    pairingCodes.set(code, {
      guildId,
      ownerId: interaction.user.id,
      expiresAt: Date.now() + PAIR_TTL_MS,
    });

    await interaction.reply({
      content: `🎙️ Código privado do **Mio Voice System**: **${code}**\n\nDigite esse código no cliente Android. Ele expira em 10 minutos e o token final nunca é publicado no Discord.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'desvincular') {
    revokeGuildSessions(guildId, interaction.user.id);
    await mutateProfile(guild, interaction.user.id, (target) => {
      target.voiceLinkHash = '';
      target.voiceLinkedAt = 0;
    }, { immediate: true });
    await interaction.reply({ content: '🔒 Mio Voice System desvinculado. O token anterior foi revogado.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (sub === 'escolher') {
    const presetId = normalizePreset(interaction.options.getString('personagem', true));
    const updated = await mutateProfile(guild, interaction.user.id, (target) => {
      target.voicePreset = presetId;
      target.voiceIntensity = clampIntensity(target.voiceIntensity);
    }, { immediate: true });
    const config = configFromProfile(updated);
    updateRuntimeConfig(guildId, config);
    await interaction.reply({
      content: `${VOICE_PRESETS[presetId].label} selecionado. 🎙️ O Android recebe a mudança no próximo polling.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'intensidade') {
    const intensity = clampIntensity(interaction.options.getInteger('valor', true));
    const updated = await mutateProfile(guild, interaction.user.id, (target) => {
      target.voiceIntensity = intensity;
      target.voicePreset = normalizePreset(target.voicePreset);
    }, { immediate: true });
    updateRuntimeConfig(guildId, configFromProfile(updated));
    await interaction.reply({ content: `🎚️ Intensidade da voz ajustada para **${intensity}%**.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (sub === 'normal') {
    const updated = await mutateProfile(guild, interaction.user.id, (target) => {
      target.voicePreset = 'normal';
    }, { immediate: true });
    updateRuntimeConfig(guildId, configFromProfile(updated));
    await interaction.reply({ content: '🎙️ Voz normal selecionada.', flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}
