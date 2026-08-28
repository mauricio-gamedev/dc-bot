import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { enqueueTerrariaAction, terrariaStatus } from './terrariaInteractive.js';

const MAX_BODY = 64 * 1024;
const USER_COOLDOWN_MS = 20_000;
const GLOBAL_COOLDOWN_MS = 4_000;
const MESSAGE_DEDUPE_MS = 60 * 60 * 1000;
const WEBHOOK_MAX_SKEW_MS = 15 * 60 * 1000;

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
const seenMessages = new Map();
const userCooldowns = new Map();
const globalCooldowns = new Map();
const actionCooldowns = new Map();

const CHAT_COMMANDS = Object.freeze({
  '!boss': 'boss',
  '!horda': 'horde',
  '!meteor': 'meteor',
  '!meteoro': 'meteor',
  '!lua': 'bloodmoon',
  '!luadesangue': 'bloodmoon',
  '!matar': 'kill',
  '!kill': 'kill',
  '!cura': 'heal',
  '!heal': 'heal',
  '!dia': 'day',
  '!noite': 'night',
  '!chuva': 'rain',
  '!limpar': 'butcher',
});

const ACTION_COOLDOWNS_MS = Object.freeze({
  boss: 60_000,
  horde: 35_000,
  meteor: 120_000,
  bloodmoon: 120_000,
  kill: 45_000,
  butcher: 30_000,
});

function config() {
  return {
    enabled: String(process.env.TERRARIA_KICK_ENABLED ?? 'true').toLowerCase() === 'true',
    guildId: process.env.DISCORD_GUILD_ID?.trim(),
    broadcasterUserId: process.env.KICK_BROADCASTER_USER_ID?.trim(),
  };
}

async function resolveGuild(client, guildId) {
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

function cleanup(now = Date.now()) {
  for (const [messageId, expiresAt] of seenMessages) {
    if (expiresAt <= now) seenMessages.delete(messageId);
  }
  for (const [key, lastAt] of userCooldowns) {
    if (now - lastAt > USER_COOLDOWN_MS * 3) userCooldowns.delete(key);
  }
  for (const [key, lastAt] of actionCooldowns) {
    if (now - lastAt > 5 * 60 * 1000) actionCooldowns.delete(key);
  }
}

function parseAction(content) {
  const command = String(content || '').trim().toLowerCase().split(/\s+/)[0] || '';
  const actionId = CHAT_COMMANDS[command];
  return actionId ? { command, actionId } : null;
}

function eventType(req) {
  return String(req.headers['kick-event-type'] || '').toLowerCase();
}

export async function handleKickTerrariaHttp(req, res, client = null) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/kick/webhook' || req.method !== 'POST') return false;

  const current = config();
  if (!current.enabled || !current.guildId) return false;

  const state = terrariaStatus(current.guildId);
  if (!state.connected) return false;

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

  cleanup();
  if (seenMessages.has(verified.messageId)) {
    json(res, 200, { ok: true, duplicate: true });
    return true;
  }
  seenMessages.set(verified.messageId, Date.now() + MESSAGE_DEDUPE_MS);

  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {
    json(res, 400, { ok: false, error: 'invalid_json' });
    return true;
  }

  const type = eventType(req);
  if (type && type !== 'chat.message.sent') {
    json(res, 200, { ok: true, ignored: true });
    return true;
  }

  const broadcasterId = String(body?.broadcaster?.user_id || '');
  if (current.broadcasterUserId && broadcasterId !== current.broadcasterUserId) {
    json(res, 200, { ok: true, ignored: true });
    return true;
  }

  const parsed = parseAction(body?.content);
  if (!parsed) {
    json(res, 200, { ok: true, ignored: true });
    return true;
  }

  const guild = await resolveGuild(client, current.guildId);
  if (!guild) {
    json(res, 503, { ok: false, error: 'guild_unavailable' });
    return true;
  }

  const senderId = String(body?.sender?.user_id || 'anonymous');
  const senderName = String(body?.sender?.username || 'viewer').slice(0, 80);
  const now = Date.now();
  const userKey = `${guild.id}:${senderId}`;
  const userLast = userCooldowns.get(userKey) || 0;
  if (now - userLast < USER_COOLDOWN_MS) {
    json(res, 200, { ok: true, cooldown: 'viewer' });
    return true;
  }

  const globalLast = globalCooldowns.get(guild.id) || 0;
  if (now - globalLast < GLOBAL_COOLDOWN_MS) {
    json(res, 200, { ok: true, cooldown: 'global' });
    return true;
  }

  const actionCooldown = ACTION_COOLDOWNS_MS[parsed.actionId] || 0;
  const actionKey = `${guild.id}:${parsed.actionId}`;
  const actionLast = actionCooldowns.get(actionKey) || 0;
  if (actionCooldown > 0 && now - actionLast < actionCooldown) {
    json(res, 200, { ok: true, cooldown: 'action' });
    return true;
  }

  const result = enqueueTerrariaAction(guild.id, parsed.actionId, senderName);
  if (!result.ok) {
    json(res, 200, { ok: true, queued: false, reason: result.error });
    return true;
  }

  userCooldowns.set(userKey, now);
  globalCooldowns.set(guild.id, now);
  if (actionCooldown > 0) actionCooldowns.set(actionKey, now);

  console.log(`[Terraria Interactive] ${senderName} -> ${result.action}`);
  json(res, 200, { ok: true, queued: true, action: result.action });
  return true;
}
