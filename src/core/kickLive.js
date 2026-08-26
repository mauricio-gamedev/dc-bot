import {
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { characterEmbed, characterLine, CHARACTER } from './character.js';
import { mutateProfile } from './communityStore.js';

const KICK_API = 'https://api.kick.com';
const KICK_OAUTH = 'https://id.kick.com/oauth/token';
const DEFAULT_INTERVAL_MS = 90_000;
const LIVE_ATTENDANCE_REWARD = 100;
const MAX_ATTENDANCE_HISTORY = 100;

let appToken = null;
let appTokenExpiresAt = 0;
let pollTimer = null;
let polling = false;
let lastState = null;
let lastCheckedAt = null;
let lastError = null;

function parsePollInterval(value) {
  const parsed = Number(value || DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.max(60_000, Math.floor(parsed));
}

function config() {
  return {
    clientId: process.env.KICK_CLIENT_ID?.trim(),
    clientSecret: process.env.KICK_CLIENT_SECRET?.trim(),
    slug: process.env.KICK_CHANNEL_SLUG?.trim() || 'MiojoPlays',
    broadcasterUserId: process.env.KICK_BROADCASTER_USER_ID?.trim(),
    enabled: String(process.env.KICK_LIVE_ENABLED ?? 'false').toLowerCase() === 'true',
    intervalMs: parsePollInterval(process.env.KICK_LIVE_POLL_MS),
  };
}

function stateSessionKey(state) {
  const startedAt = state?.startedAt ? new Date(state.startedAt).getTime() : Number.NaN;
  if (Number.isFinite(startedAt) && startedAt > 0) {
    return `t${Math.floor(startedAt / 1000).toString(36)}`;
  }

  const identity = String(state?.broadcasterUserId || state?.slug || 'live')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24) || 'live';
  const window = Math.floor(Date.now() / (6 * 60 * 60_000)).toString(36);
  return `f${identity}-${window}`;
}

export function kickLiveStatus() {
  const current = config();
  return {
    enabled: current.enabled,
    configured: Boolean(current.clientId && current.clientSecret && current.slug),
    slug: current.slug,
    polling: Boolean(pollTimer),
    lastCheckedAt,
    lastError,
    sessionKey: lastState?.isLive ? stateSessionKey(lastState) : null,
    lastState,
  };
}

function clearAppToken() {
  appToken = null;
  appTokenExpiresAt = 0;
}

async function getAppToken() {
  const current = config();
  if (!current.clientId || !current.clientSecret) {
    throw new Error('KICK_CLIENT_ID/KICK_CLIENT_SECRET não configurados.');
  }

  if (appToken && Date.now() < appTokenExpiresAt) return appToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: current.clientId,
    client_secret: current.clientSecret,
  });

  const response = await fetch(KICK_OAUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`Kick OAuth respondeu HTTP ${response.status}.`);
  }

  const json = await response.json();
  if (!json?.access_token) throw new Error('Kick OAuth não retornou access_token.');

  appToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);
  appTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
  return appToken;
}

async function fetchKickJson(path) {
  let token = await getAppToken();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${KICK_API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    });

    if (response.status === 401 && attempt === 0) {
      clearAppToken();
      token = await getAppToken();
      continue;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail ? ` • ${detail.slice(0, 180)}` : '';
      throw new Error(`Kick API respondeu HTTP ${response.status}${suffix}`);
    }

    return response.json();
  }

  throw new Error('Kick API recusou o App Access Token após renovação.');
}

async function fetchChannelState() {
  const current = config();
  const params = new URLSearchParams();
  if (current.broadcasterUserId) params.append('broadcaster_user_id', current.broadcasterUserId);
  else params.append('slug', current.slug);

  const json = await fetchKickJson(`/public/v1/channels?${params.toString()}`);
  const channel = Array.isArray(json?.data) ? json.data[0] : json?.data;
  if (!channel) {
    return {
      isLive: false,
      slug: current.slug,
      broadcasterUserId: current.broadcasterUserId ?? null,
    };
  }

  const stream = channel.stream ?? null;
  const isLive = Boolean(stream?.is_live);

  return {
    isLive,
    slug: channel.slug || current.slug,
    broadcasterUserId: channel.broadcaster_user_id ?? current.broadcasterUserId ?? null,
    title: channel.stream_title || 'MiojoPlays está ao vivo!',
    category: channel.category?.name || 'Live',
    viewerCount: Number(stream?.viewer_count || 0),
    thumbnail: stream?.thumbnail || null,
    startedAt: stream?.start_time || null,
  };
}

function liveChannel(guild) {
  return guild.channels.cache.find(
    (channel) => channel.name === '🔴・live-agora' && channel.isTextBased(),
  );
}

function liveRole(guild) {
  return guild.roles.cache.find((role) => role.name === '🔴・Lives');
}

function liveUrl(state) {
  return `https://kick.com/${encodeURIComponent(state.slug)}`;
}

function sameLiveSession(embed, state, url) {
  if (!embed || embed.url !== url) return false;
  if (!state.startedAt) {
    const timestamp = embed.timestamp ? new Date(embed.timestamp).getTime() : 0;
    return timestamp > Date.now() - 6 * 60 * 60_000;
  }

  const expected = new Date(state.startedAt).getTime();
  const actual = embed.timestamp ? new Date(embed.timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return false;
  return Math.abs(expected - actual) <= 120_000;
}

async function alreadyAnnounced(channel, state, url) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return false;
  return recent.some((message) =>
    message.author.id === channel.guild.members.me?.id &&
    message.embeds.some((embed) => sameLiveSession(embed, state, url)),
  );
}

function setLivePresence(client, state) {
  client.user?.setActivity(`AO VIVO • ${state.title}`.slice(0, 120), {
    type: ActivityType.Streaming,
    url: liveUrl(state),
  });
}

async function announceLive(client, guild, state) {
  const channel = liveChannel(guild);
  if (!channel) return false;

  const role = liveRole(guild);
  const url = liveUrl(state);

  if (await alreadyAnnounced(channel, state, url)) {
    setLivePresence(client, state);
    return false;
  }

  const description = [
    characterLine('live'),
    '',
    `**${state.title}**`,
    `🎮 ${state.category}`,
    state.viewerCount > 0 ? `👁️ ${state.viewerCount.toLocaleString('pt-BR')} assistindo agora` : null,
    '',
    `💜 Marque presença nesta live e receba **${LIVE_ATTENDANCE_REWARD} MiojoCoins** uma única vez.`,
  ].filter(Boolean).join('\n');

  const embed = characterEmbed({
    title: 'MiojoPlays • AO VIVO',
    description,
    color: CHARACTER.palette.live,
    image: state.thumbnail,
    presentation: 'hero',
    footer: 'Mio • Live Mode • MiojoPlays',
  }).setURL(url);

  if (state.startedAt) {
    const started = new Date(state.startedAt);
    if (!Number.isNaN(started.getTime())) embed.setTimestamp(started);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Assistir na Kick')
      .setStyle(ButtonStyle.Link)
      .setURL(url),
    new ButtonBuilder()
      .setCustomId(`kicklive:attendance:${stateSessionKey(state)}`)
      .setLabel('Marcar presença')
      .setEmoji('💜')
      .setStyle(ButtonStyle.Primary),
  );

  await channel.send({
    content: role ? `<@&${role.id}>` : undefined,
    embeds: [embed],
    components: [row],
    allowedMentions: role ? { roles: [role.id] } : { parse: [] },
  });

  setLivePresence(client, state);
  return true;
}

export async function handleKickLiveButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('kicklive:attendance:')) return false;
  if (!interaction.guild) return true;

  const sessionKey = interaction.customId.slice('kicklive:attendance:'.length);
  const currentState = lastState;
  if (!currentState?.isLive || stateSessionKey(currentState) !== sessionKey) {
    await interaction.reply({
      content: 'Essa transmissão já encerrou ou não é mais a live ativa.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  let rewarded = false;
  let attendanceCount = 0;
  const profile = await mutateProfile(interaction.guild, interaction.user.id, (data) => {
    if (!Array.isArray(data.liveAttendanceSessions)) data.liveAttendanceSessions = [];
    attendanceCount = Math.max(0, Number(data.liveAttendanceCount) || 0);

    if (data.liveAttendanceSessions.includes(sessionKey)) return;

    data.liveAttendanceSessions.push(sessionKey);
    if (data.liveAttendanceSessions.length > MAX_ATTENDANCE_HISTORY) {
      data.liveAttendanceSessions.splice(0, data.liveAttendanceSessions.length - MAX_ATTENDANCE_HISTORY);
    }

    data.liveAttendanceCount = attendanceCount + 1;
    data.coins = Math.max(0, Number(data.coins) || 0) + LIVE_ATTENDANCE_REWARD;
    attendanceCount = data.liveAttendanceCount;
    rewarded = true;
  }, { immediate: true });

  if (!rewarded) {
    await interaction.reply({
      content: `💜 Sua presença nesta live já foi registrada. Total: **${attendanceCount}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.reply({
    content: `💜 Presença registrada! **+${LIVE_ATTENDANCE_REWARD} MiojoCoins** • presença #**${attendanceCount}** • saldo **${profile.coins}**.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

function restorePresence(client) {
  client.user?.setActivity(`${CHARACTER.name} protege a comunidade`, { type: ActivityType.Watching });
}

async function poll(client) {
  if (polling || !client.isReady()) return;
  polling = true;
  try {
    const state = await fetchChannelState();
    const wasLive = Boolean(lastState?.isLive);
    const nowLive = Boolean(state.isLive);

    // Atualiza o estado antes do anúncio para o botão já nascer associado à sessão ativa.
    lastState = state;

    if (nowLive && !wasLive) {
      for (const guild of client.guilds.cache.values()) {
        await guild.channels.fetch().catch(() => {});
        await guild.roles.fetch().catch(() => {});
        await announceLive(client, guild, state).catch((error) => {
          console.error(`Falha ao anunciar live em ${guild.name}:`, error);
        });
      }
    } else if (wasLive && !nowLive) {
      restorePresence(client);
    } else if (nowLive) {
      setLivePresence(client, state);
    }

    lastError = null;
  } catch (error) {
    lastError = error.message;
    console.error('Kick Live Watch:', error.message);
  } finally {
    lastCheckedAt = new Date().toISOString();
    polling = false;
  }
}

export function startKickLiveWatcher(client) {
  const current = config();
  if (!current.enabled) {
    console.log('Kick Live Watch desativado (KICK_LIVE_ENABLED=false).');
    return false;
  }
  if (!current.clientId || !current.clientSecret) {
    console.warn('Kick Live Watch não iniciado: credenciais da Kick ausentes.');
    return false;
  }
  if (pollTimer) return true;

  poll(client).catch(() => {});
  pollTimer = setInterval(() => poll(client).catch(() => {}), current.intervalMs);
  pollTimer.unref?.();
  console.log(`Kick Live Watch ativo para ${current.slug} a cada ${Math.round(current.intervalMs / 1000)}s.`);
  return true;
}

export function stopKickLiveWatcher() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  clearAppToken();
}
