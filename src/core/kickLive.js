import { ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { characterEmbed, characterLine, CHARACTER } from './character.js';

const KICK_API = 'https://api.kick.com';
const KICK_OAUTH = 'https://id.kick.com/oauth/token';
const DEFAULT_INTERVAL_MS = 90_000;

let appToken = null;
let appTokenExpiresAt = 0;
let pollTimer = null;
let polling = false;
let lastState = null;

function config() {
  return {
    clientId: process.env.KICK_CLIENT_ID?.trim(),
    clientSecret: process.env.KICK_CLIENT_SECRET?.trim(),
    slug: process.env.KICK_CHANNEL_SLUG?.trim() || 'MiojoPlays',
    broadcasterUserId: process.env.KICK_BROADCASTER_USER_ID?.trim(),
    enabled: String(process.env.KICK_LIVE_ENABLED ?? 'false').toLowerCase() === 'true',
    intervalMs: Math.max(60_000, Number(process.env.KICK_LIVE_POLL_MS || DEFAULT_INTERVAL_MS)),
  };
}

export function kickLiveStatus() {
  const current = config();
  return {
    enabled: current.enabled,
    configured: Boolean(current.clientId && current.clientSecret && current.slug),
    slug: current.slug,
    polling: Boolean(pollTimer),
    lastState,
  };
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

async function fetchChannelState() {
  const current = config();
  const token = await getAppToken();
  const params = new URLSearchParams();
  if (current.broadcasterUserId) params.append('broadcaster_user_id', current.broadcasterUserId);
  else params.append('slug', current.slug);

  const response = await fetch(`${KICK_API}/public/v1/channels?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const suffix = detail ? ` • ${detail.slice(0, 180)}` : '';
    throw new Error(`Kick channels respondeu HTTP ${response.status}${suffix}`);
  }

  const json = await response.json();
  const channel = Array.isArray(json?.data) ? json.data[0] : json?.data;
  if (!channel) return { isLive: false, slug: current.slug, raw: null };

  const stream = channel.stream ?? null;
  const isLive = Boolean(stream?.is_live ?? stream?.isLive ?? false);

  return {
    isLive,
    slug: channel.slug || current.slug,
    broadcasterUserId: channel.broadcaster_user_id ?? current.broadcasterUserId ?? null,
    title: stream?.title || channel.stream_title || 'MiojoPlays está ao vivo!',
    category: stream?.category?.name || stream?.category?.slug || 'Live',
    viewerCount: Number(stream?.viewer_count || 0),
    thumbnail: stream?.thumbnail || channel.thumbnail || null,
    startedAt: stream?.start_time || stream?.started_at || null,
    raw: channel,
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

async function announceLive(client, guild, state) {
  const channel = liveChannel(guild);
  if (!channel) return;

  const role = liveRole(guild);
  const url = `https://kick.com/${encodeURIComponent(state.slug)}`;
  const description = [
    characterLine('live'),
    '',
    `**${state.title}**`,
    `🎮 ${state.category}`,
    state.viewerCount > 0 ? `👁️ ${state.viewerCount.toLocaleString('pt-BR')} assistindo agora` : null,
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
  );

  await channel.send({
    content: role ? `<@&${role.id}>` : undefined,
    embeds: [embed],
    components: [row],
    allowedMentions: role ? { roles: [role.id] } : { parse: [] },
  });

  client.user?.setActivity(`AO VIVO • ${state.title}`.slice(0, 120), { type: ActivityType.Streaming, url });
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

    if (!wasLive && nowLive) {
      for (const guild of client.guilds.cache.values()) {
        await guild.channels.fetch().catch(() => {});
        await guild.roles.fetch().catch(() => {});
        await announceLive(client, guild, state).catch((error) => {
          console.error(`Falha ao anunciar live em ${guild.name}:`, error);
        });
      }
    } else if (wasLive && !nowLive) {
      restorePresence(client);
    }

    lastState = state;
  } catch (error) {
    console.error('Kick Live Watch:', error.message);
  } finally {
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
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}
