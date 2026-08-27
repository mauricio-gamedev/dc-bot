import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { getProfile, mutateProfile } from './communityStore.js';
import { enqueueMindustryAction, mindustryStatus } from './mindustryInteractive.js';

const KICK_API = 'https://api.kick.com';
const KICK_AUTHORIZE = 'https://id.kick.com/oauth/authorize';
const KICK_TOKEN = 'https://id.kick.com/oauth/token';
const KICK_REVOKE = 'https://id.kick.com/oauth/revoke';
const CALLBACK_PATH = '/kick/oauth/callback';
const WEBHOOK_PATH = '/kick/webhook';
const OAUTH_TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const USER_COOLDOWN_MS = 20_000;
const GLOBAL_COOLDOWN_MS = 4_000;
const MESSAGE_DEDUPE_MS = 60 * 60 * 1000;
const WEBHOOK_MAX_SKEW_MS = 15 * 60 * 1000;
const REQUIRED_SCOPES = 'chat:write events:subscribe';

const KICK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

const publicKey = createPublicKey(KICK_PUBLIC_KEY);
const pendingOAuth = new Map();
const accessTokens = new Map();
const seenMessages = new Map();
const userCooldowns = new Map();
const globalCooldowns = new Map();
const actionCooldowns = new Map();
const runtimeByGuild = new Map();

const CHAT_COMMANDS = Object.freeze({
  '!wave': 'wave',
  '!horda': 'horde',
  '!cobre': 'copper',
  '!chumbo': 'lead',
  '!grafite': 'graphite',
  '!silicio': 'silicon',
  '!silício': 'silicon',
  '!titanio': 'titanium',
  '!titânio': 'titanium',
  '!torio': 'thorium',
  '!tório': 'thorium',
  '!cura': 'heal',
  '!boost': 'boost',
  '!lento': 'slow',
  '!gelo': 'freeze',
  '!fogo': 'burn',
});

const ACTION_COOLDOWNS_MS = Object.freeze({
  horde: 45_000,
  boost: 20_000,
  slow: 15_000,
  freeze: 15_000,
  burn: 15_000,
});

const COMMAND_PANEL = [
  '🎮 MIOJOPLAYS INTERACTIVE',
  '⚔️ !wave !horda !lento !gelo !fogo !boost',
  '📦 !cobre !chumbo !grafite !silicio !titanio !torio',
  '💚 !cura',
  'ℹ️ !comandos / !help • 1 ação por pessoa a cada 20s',
].join(' | ');

export const kickInteractiveCommandBuilder = new SlashCommandBuilder()
  .setName('kickbot')
  .setDescription('Configura os comandos interativos do chat da Kick.')
  .addSubcommand((sub) => sub.setName('status').setDescription('Mostra o estado da integração Kick → Mindustry.'))
  .addSubcommand((sub) => sub.setName('vincular').setDescription('Autoriza sua conta Kick para chat e webhooks.'))
  .addSubcommand((sub) => sub.setName('comandos').setDescription('Publica o painel de comandos no chat da Kick para você fixar.'))
  .addSubcommand((sub) => sub.setName('desvincular').setDescription('Remove a autorização da Kick salva pelo bot.'));

export const kickInteractiveCommandData = kickInteractiveCommandBuilder.toJSON();

function config() {
  const redirectUrl = process.env.KICK_OAUTH_REDIRECT_URL?.trim()
    || 'https://dc-bot-us5v.onrender.com/kick/oauth/callback';
  const messageType = String(process.env.KICK_CHAT_MESSAGE_TYPE || 'bot').toLowerCase() === 'user'
    ? 'user'
    : 'bot';

  return {
    enabled: String(process.env.KICK_INTERACTIVE_ENABLED ?? 'true').toLowerCase() === 'true',
    clientId: process.env.KICK_CLIENT_ID?.trim(),
    clientSecret: process.env.KICK_CLIENT_SECRET?.trim(),
    broadcasterUserId: process.env.KICK_BROADCASTER_USER_ID?.trim(),
    guildId: process.env.DISCORD_GUILD_ID?.trim(),
    redirectUrl,
    messageType,
    replyActions: String(process.env.KICK_INTERACTIVE_REPLY_ACTIONS ?? 'false').toLowerCase() === 'true',
  };
}

function runtime(guildId) {
  if (!runtimeByGuild.has(guildId)) {
    runtimeByGuild.set(guildId, {
      subscribed: false,
      subscriptionId: null,
      lastWebhookAt: null,
      lastCommandAt: null,
      lastCommand: null,
      lastSender: null,
      lastError: null,
    });
  }
  return runtimeByGuild.get(guildId);
}

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function cleanupMaps(now = Date.now()) {
  for (const [state, data] of pendingOAuth) {
    if (data.expiresAt <= now) pendingOAuth.delete(state);
  }
  for (const [messageId, expiresAt] of seenMessages) {
    if (expiresAt <= now) seenMessages.delete(messageId);
  }
  for (const [key, lastAt] of userCooldowns) {
    if (now - lastAt > USER_COOLDOWN_MS * 3) userCooldowns.delete(key);
  }
  for (const [key, lastAt] of actionCooldowns) {
    if (now - lastAt > 2 * 60 * 1000) actionCooldowns.delete(key);
  }
}

function encryptionKey() {
  const secret = process.env.DISCORD_TOKEN;
  if (!secret) throw new Error('DISCORD_TOKEN ausente para proteger o refresh token da Kick.');
  return createHash('sha256').update(`miojoplays-kick-oauth-v1\0${secret}`, 'utf8').digest();
}

function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) throw new Error('Credencial Kick persistida em formato inválido.');
  const [ivText, tagText, ciphertextText] = parts;
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function resolveGuild(client, guildId = config().guildId) {
  if (!client?.guilds || !guildId) return null;
  return client.guilds.cache.get(guildId) ?? client.guilds.fetch(guildId).catch(() => null);
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function html(res, status, title, message) {
  const escape = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><body style="font-family:system-ui;background:#0d0b12;color:#fff;padding:28px;line-height:1.5"><h2>${escape(title)}</h2><p>${escape(message)}</p><p>Você pode fechar esta página e voltar ao Discord.</p></body></html>`);
}

function tokenBody(fields) {
  return new URLSearchParams(fields);
}

async function tokenRequest(fields) {
  const response = await fetch(KICK_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody(fields),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok || !body?.access_token) {
    const detail = body?.error || body?.message || text.slice(0, 160) || 'sem detalhes';
    throw new Error(`Kick OAuth HTTP ${response.status}: ${detail}`);
  }
  return body;
}

function cacheAccessToken(guildId, tokenData) {
  const expiresIn = Math.max(60, Number(tokenData.expires_in || 3600) - 60);
  accessTokens.set(guildId, {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  });
}

async function persistOAuth(guild, tokenData) {
  if (!tokenData.refresh_token) throw new Error('Kick OAuth não retornou refresh_token.');
  const linkedAt = Date.now();
  await mutateProfile(guild, guild.ownerId, (profile) => {
    profile.kickOAuthRefreshEncrypted = encryptSecret(tokenData.refresh_token);
    profile.kickOAuthScope = String(tokenData.scope || REQUIRED_SCOPES).slice(0, 400);
    profile.kickOAuthLinkedAt = linkedAt;
  }, { immediate: true });
  cacheAccessToken(guild.id, tokenData);
}

async function getUserAccessToken(guild) {
  const cached = accessTokens.get(guild.id);
  if (cached?.accessToken && Date.now() < cached.expiresAt) return cached.accessToken;

  const current = config();
  if (!current.clientId || !current.clientSecret) throw new Error('Credenciais do app Kick ausentes.');

  const profile = await getProfile(guild, guild.ownerId);
  if (!profile.kickOAuthRefreshEncrypted) throw new Error('Conta Kick ainda não vinculada ao bot.');

  const refreshToken = decryptSecret(profile.kickOAuthRefreshEncrypted);
  const tokenData = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: current.clientId,
    client_secret: current.clientSecret,
    refresh_token: refreshToken,
  });

  if (tokenData.refresh_token) {
    await mutateProfile(guild, guild.ownerId, (data) => {
      data.kickOAuthRefreshEncrypted = encryptSecret(tokenData.refresh_token);
      data.kickOAuthScope = String(tokenData.scope || data.kickOAuthScope || REQUIRED_SCOPES).slice(0, 400);
    }, { immediate: true });
  }

  cacheAccessToken(guild.id, tokenData);
  return tokenData.access_token;
}

async function kickApiRequest(path, { guild, method = 'GET', body = null } = {}) {
  let token = await getUserAccessToken(guild);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${KICK_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401 && attempt === 0) {
      accessTokens.delete(guild.id);
      token = await getUserAccessToken(guild);
      continue;
    }

    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
    return { response, text, body: parsed };
  }
  throw new Error('Kick API recusou o token após renovação.');
}

function parseSubscriptionId(body) {
  const data = body?.data;
  const item = Array.isArray(data) ? data[0] : data;
  return item?.subscription_id || item?.id || null;
}

async function subscribeChat(guild) {
  const current = config();
  if (!current.broadcasterUserId) throw new Error('KICK_BROADCASTER_USER_ID não configurado.');
  const broadcaster = Number(current.broadcasterUserId);
  if (!Number.isSafeInteger(broadcaster) || broadcaster <= 0) throw new Error('KICK_BROADCASTER_USER_ID inválido.');

  const baseBody = {
    broadcaster_user_id: broadcaster,
    events: [{ name: 'chat.message.sent', version: 1 }],
  };

  let result = await kickApiRequest('/public/v1/events/subscriptions', {
    guild,
    method: 'POST',
    body: baseBody,
  });

  if (!result.response.ok && result.response.status === 400) {
    result = await kickApiRequest('/public/v1/events/subscriptions', {
      guild,
      method: 'POST',
      body: { ...baseBody, method: 'webhook' },
    });
  }

  if (!result.response.ok && result.response.status !== 409) {
    const detail = result.body?.message || result.body?.error || result.text.slice(0, 180) || 'sem detalhes';
    throw new Error(`Assinatura chat.message.sent falhou HTTP ${result.response.status}: ${detail}`);
  }

  const state = runtime(guild.id);
  state.subscribed = true;
  state.subscriptionId = parseSubscriptionId(result.body);
  state.lastError = null;
  await mutateProfile(guild, guild.ownerId, (profile) => {
    profile.kickSubscriptionId = state.subscriptionId || profile.kickSubscriptionId || '';
  }, { immediate: true });
  return state.subscriptionId;
}

async function sendChatMessage(guild, content, replyToMessageId = null) {
  const current = config();
  if (!current.broadcasterUserId) return false;
  const broadcaster = Number(current.broadcasterUserId);
  const safeContent = String(content || '').trim().slice(0, 450);
  if (!safeContent) return false;

  const makePayload = (type) => ({
    ...(type === 'user' ? { broadcaster_user_id: broadcaster } : {}),
    content: safeContent,
    type,
    ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
  });

  let type = current.messageType;
  let result = await kickApiRequest('/public/v1/chat', {
    guild,
    method: 'POST',
    body: makePayload(type),
  });

  if (!result.response.ok && type === 'bot') {
    type = 'user';
    result = await kickApiRequest('/public/v1/chat', {
      guild,
      method: 'POST',
      body: makePayload(type),
    });
  }

  if (!result.response.ok) {
    const detail = result.body?.message || result.body?.error || result.text.slice(0, 180) || 'sem detalhes';
    throw new Error(`Falha ao responder no chat da Kick HTTP ${result.response.status}: ${detail}`);
  }
  return true;
}

function buildAuthorizeUrl(guildId, ownerId) {
  cleanupMaps();
  const current = config();
  if (!current.clientId || !current.clientSecret) throw new Error('KICK_CLIENT_ID/KICK_CLIENT_SECRET não configurados.');

  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  pendingOAuth.set(state, {
    guildId,
    ownerId,
    verifier,
    expiresAt: Date.now() + OAUTH_TTL_MS,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: current.clientId,
    redirect_uri: current.redirectUrl,
    scope: REQUIRED_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${KICK_AUTHORIZE}?${params.toString()}`;
}

function verifyWebhook(req, raw) {
  const messageId = String(req.headers['kick-event-message-id'] || '');
  const timestamp = String(req.headers['kick-event-message-timestamp'] || '');
  const signature = String(req.headers['kick-event-signature'] || '');
  if (!messageId || !timestamp || !signature) return { ok: false, error: 'missing_signature_headers' };

  const parsedTime = new Date(timestamp).getTime();
  if (!Number.isFinite(parsedTime) || Math.abs(Date.now() - parsedTime) > WEBHOOK_MAX_SKEW_MS) {
    return { ok: false, error: 'stale_timestamp' };
  }

  let signatureBuffer;
  try { signatureBuffer = Buffer.from(signature, 'base64'); } catch { return { ok: false, error: 'bad_signature_encoding' }; }
  const signed = Buffer.from(`${messageId}.${timestamp}.${raw.toString('utf8')}`, 'utf8');
  const valid = verifySignature('RSA-SHA256', signed, publicKey, signatureBuffer);
  return valid ? { ok: true, messageId } : { ok: false, error: 'invalid_signature' };
}

function parseChatCommand(content) {
  const command = String(content || '').trim().toLowerCase().split(/\s+/)[0] || '';
  if (command === '!comandos' || command === '!help') return { kind: 'help', command };
  const actionId = CHAT_COMMANDS[command];
  return actionId ? { kind: 'action', command, actionId } : null;
}

async function processChatEvent(client, body) {
  const current = config();
  const guild = await resolveGuild(client);
  if (!guild) throw new Error('Servidor Discord alvo não encontrado.');
  const state = runtime(guild.id);
  state.lastWebhookAt = new Date().toISOString();

  const broadcasterId = String(body?.broadcaster?.user_id || '');
  if (current.broadcasterUserId && broadcasterId !== current.broadcasterUserId) return;

  const profile = await getProfile(guild, guild.ownerId);
  if (!profile.kickOAuthRefreshEncrypted) return;

  const parsed = parseChatCommand(body?.content);
  if (!parsed) return;

  const senderId = String(body?.sender?.user_id || 'anonymous');
  const senderName = String(body?.sender?.username || 'viewer').slice(0, 80);
  const replyMessageId = String(body?.message_id || '').trim() || null;
  state.lastCommandAt = new Date().toISOString();
  state.lastCommand = parsed.command;
  state.lastSender = senderName;

  if (parsed.kind === 'help') {
    sendChatMessage(guild, COMMAND_PANEL, replyMessageId)
      .catch((error) => {
        state.lastError = error.message;
        console.error('Kick Interactive chat reply:', error.message);
      });
    return;
  }

  const now = Date.now();
  const userKey = `${guild.id}:${senderId}`;
  const userLast = userCooldowns.get(userKey) || 0;
  if (now - userLast < USER_COOLDOWN_MS) return;

  const globalLast = globalCooldowns.get(guild.id) || 0;
  if (now - globalLast < GLOBAL_COOLDOWN_MS) return;

  const actionCooldown = ACTION_COOLDOWNS_MS[parsed.actionId] || 0;
  const actionKey = `${guild.id}:${parsed.actionId}`;
  const actionLast = actionCooldowns.get(actionKey) || 0;
  if (actionCooldown > 0 && now - actionLast < actionCooldown) return;

  const result = enqueueMindustryAction(guild.id, parsed.actionId, senderName);
  if (!result.ok) return;

  userCooldowns.set(userKey, now);
  globalCooldowns.set(guild.id, now);
  if (actionCooldown > 0) actionCooldowns.set(actionKey, now);
  state.lastError = null;

  if (current.replyActions) {
    sendChatMessage(guild, `${result.label} • @${senderName} enviou uma ação para o jogo ✅`, replyMessageId)
      .catch((error) => {
        state.lastError = error.message;
        console.error('Kick Interactive action reply:', error.message);
      });
  }
}

async function handleOAuthCallback(req, res, client, url) {
  cleanupMaps();
  const stateValue = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const oauthError = url.searchParams.get('error') || '';
  const pending = pendingOAuth.get(stateValue);
  if (oauthError) {
    pendingOAuth.delete(stateValue);
    html(res, 400, 'Kick não autorizada', `A Kick retornou: ${oauthError}`);
    return true;
  }
  if (!pending || pending.expiresAt <= Date.now() || !code) {
    html(res, 400, 'Vínculo expirado', 'Use /kickbot vincular novamente no Discord e autorize pelo novo link.');
    return true;
  }

  pendingOAuth.delete(stateValue);
  const guild = await resolveGuild(client, pending.guildId);
  if (!guild || guild.ownerId !== pending.ownerId) {
    html(res, 403, 'Vínculo recusado', 'O servidor ou proprietário não corresponde ao pedido de autorização.');
    return true;
  }

  const current = config();
  try {
    const tokenData = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: current.clientId,
      client_secret: current.clientSecret,
      redirect_uri: current.redirectUrl,
      code_verifier: pending.verifier,
    });
    await persistOAuth(guild, tokenData);

    let subscriptionNote = 'Webhook chat.message.sent inscrito com sucesso.';
    try {
      await subscribeChat(guild);
    } catch (error) {
      runtime(guild.id).lastError = error.message;
      subscriptionNote = `OAuth salvo, mas a inscrição do webhook ainda falhou: ${error.message}`;
    }

    html(res, 200, 'Kick vinculada ao MiojoPlays', subscriptionNote);
  } catch (error) {
    runtime(guild.id).lastError = error.message;
    html(res, 500, 'Falha ao vincular Kick', error.message);
  }
  return true;
}

async function handleWebhook(req, res, client) {
  const current = config();
  if (!current.enabled) {
    json(res, 503, { ok: false, error: 'interactive_disabled' });
    return true;
  }

  let raw;
  try {
    raw = await readRaw(req);
  } catch (error) {
    json(res, error.message === 'payload_too_large' ? 413 : 400, { ok: false, error: 'bad_request' });
    return true;
  }

  const verified = verifyWebhook(req, raw);
  if (!verified.ok) {
    json(res, 401, { ok: false, error: verified.error });
    return true;
  }

  cleanupMaps();
  if (seenMessages.has(verified.messageId)) {
    res.writeHead(204);
    res.end();
    return true;
  }
  seenMessages.set(verified.messageId, Date.now() + MESSAGE_DEDUPE_MS);

  const eventType = String(req.headers['kick-event-type'] || '');
  const eventVersion = String(req.headers['kick-event-version'] || '');
  if (eventType !== 'chat.message.sent' || eventVersion !== '1') {
    res.writeHead(204);
    res.end();
    return true;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    json(res, 400, { ok: false, error: 'invalid_json' });
    return true;
  }

  res.writeHead(204);
  res.end();
  processChatEvent(client, body).catch((error) => {
    const guildId = config().guildId;
    if (guildId) runtime(guildId).lastError = error.message;
    console.error('Kick Interactive webhook:', error.message);
  });
  return true;
}

export async function handleKickInteractiveHttp(req, res, client) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === CALLBACK_PATH && req.method === 'GET') {
    return handleOAuthCallback(req, res, client, url);
  }
  if (url.pathname === WEBHOOK_PATH && req.method === 'POST') {
    return handleWebhook(req, res, client);
  }
  return false;
}

export function kickInteractiveStatus(guildId = config().guildId) {
  const current = config();
  const state = guildId ? runtime(guildId) : null;
  return {
    enabled: current.enabled,
    configured: Boolean(current.clientId && current.clientSecret && current.broadcasterUserId && current.guildId),
    redirectUrl: current.redirectUrl,
    webhookPath: WEBHOOK_PATH,
    subscribed: Boolean(state?.subscribed),
    lastWebhookAt: state?.lastWebhookAt || null,
    lastCommandAt: state?.lastCommandAt || null,
    lastCommand: state?.lastCommand || null,
    lastSender: state?.lastSender || null,
    lastError: state?.lastError || null,
  };
}

async function unlinkKick(guild) {
  const profile = await getProfile(guild, guild.ownerId);
  let refreshToken = null;
  try {
    if (profile.kickOAuthRefreshEncrypted) refreshToken = decryptSecret(profile.kickOAuthRefreshEncrypted);
  } catch {}

  if (refreshToken) {
    const current = config();
    const params = new URLSearchParams({ token: refreshToken, token_hint_type: 'refresh_token' });
    fetch(`${KICK_REVOKE}?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  await mutateProfile(guild, guild.ownerId, (data) => {
    data.kickOAuthRefreshEncrypted = '';
    data.kickOAuthScope = '';
    data.kickOAuthLinkedAt = 0;
    data.kickSubscriptionId = '';
  }, { immediate: true });
  accessTokens.delete(guild.id);
  const state = runtime(guild.id);
  state.subscribed = false;
  state.subscriptionId = null;
}

export async function handleKickInteractiveCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'kickbot' || !interaction.guild) return false;
  if (!ownerOnly(interaction)) {
    await interaction.reply({ content: 'Somente o dono real do servidor pode configurar o Kick Interactive.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const current = config();

  if (sub === 'status') {
    const profile = await getProfile(guild, guild.ownerId);
    const state = runtime(guild.id);
    const mindustry = mindustryStatus(guild.id);
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🟢 Kick Chat Interactive',
        description: [
          `🔌 **Módulo:** ${current.enabled ? '🟢 ativo' : '🔴 desativado'}`,
          `🔐 **Kick OAuth:** ${profile.kickOAuthRefreshEncrypted ? '🟢 vinculada' : '🔴 não vinculada'}`,
          `📡 **Webhook:** ${state.lastWebhookAt ? '🟢 recebendo eventos' : state.subscribed ? '🟡 inscrito, aguardando evento' : '⚪ sem evento recebido'}`,
          `🎮 **Mindustry:** ${mindustry.connected ? '🟢 conectado' : '🔴 desconectado'} • ${mindustry.interactionsOpen ? 'interações abertas' : 'interações fechadas'}`,
          '',
          '**Chat:** `!wave` `!horda` `!cobre` `!chumbo` `!grafite` `!silicio` `!titanio` `!torio` `!cura` `!boost` `!lento` `!gelo` `!fogo` `!comandos`',
          state.lastCommandAt ? `🧪 Último comando: **${state.lastCommand}** por **${state.lastSender}**` : null,
          state.lastError ? `⚠️ Último erro: ${state.lastError.slice(0, 250)}` : null,
        ].filter(Boolean).join('\n'),
        color: profile.kickOAuthRefreshEncrypted ? CHARACTER.palette.success : CHARACTER.palette.warning,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'vincular') {
    if (!current.enabled) {
      await interaction.reply({ content: '❌ KICK_INTERACTIVE_ENABLED está desativado.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!current.clientId || !current.clientSecret || !current.broadcasterUserId || !current.guildId) {
      await interaction.reply({ content: '❌ Faltam credenciais/IDs da Kick ou DISCORD_GUILD_ID no Render.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const authorizeUrl = buildAuthorizeUrl(guild.id, interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Autorizar na Kick')
        .setStyle(ButtonStyle.Link)
        .setURL(authorizeUrl),
    );
    await interaction.reply({
      content: [
        '🔐 **Vincular Kick Chat Interactive**',
        '',
        'Antes de autorizar, o app da Kick deve ter:',
        `• Redirect URI: \`${current.redirectUrl}\``,
        '• Webhook URL: `https://dc-bot-us5v.onrender.com/kick/webhook`',
        '• permissões `chat:write` e `events:subscribe`',
        '',
        'Depois toque no botão. O link expira em 10 minutos.',
      ].join('\n'),
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'comandos') {
    try {
      const profile = await getProfile(guild, guild.ownerId);
      if (!profile.kickOAuthRefreshEncrypted) {
        await interaction.reply({ content: '❌ A Kick ainda não está vinculada. Use `/kickbot vincular` primeiro.', flags: MessageFlags.Ephemeral });
        return true;
      }
      await sendChatMessage(guild, COMMAND_PANEL);
      await interaction.reply({
        content: '📌 Painel de comandos enviado para o chat da Kick. Agora é só usar **Fixar mensagem** na própria Kick; a API pública ainda não oferece pin automático.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      runtime(guild.id).lastError = error.message;
      await interaction.reply({ content: `❌ Não consegui publicar o painel: ${error.message.slice(0, 250)}`, flags: MessageFlags.Ephemeral });
    }
    return true;
  }

  if (sub === 'desvincular') {
    await unlinkKick(guild);
    await interaction.reply({ content: '🔒 Autorização da Kick removida do bot. Os comandos do chat foram desativados.', flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}
