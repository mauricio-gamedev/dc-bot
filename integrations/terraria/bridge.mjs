import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const VERSION = '0.1.0';
const STATE_FILE = resolve(process.env.TERRARIA_BRIDGE_STATE || '.terraria-bridge.json');
const BOT_BASE_URL = String(process.env.TERRARIA_BOT_URL || 'https://dc-bot-us5v.onrender.com').replace(/\/$/, '');
const TSHOCK_URL = String(process.env.TSHOCK_URL || 'http://127.0.0.1:7878').replace(/\/$/, '');
const TSHOCK_TOKEN = String(process.env.TSHOCK_TOKEN || '').trim();
const PLAYER_NAME = String(process.env.TERRARIA_PLAYER || '').trim();
const PAIR_CODE = String(process.env.TERRARIA_PAIR_CODE || '').trim();

if (!TSHOCK_TOKEN) {
  console.error('TSHOCK_TOKEN não configurado.');
  process.exit(1);
}
if (!PLAYER_NAME) {
  console.error('TERRARIA_PLAYER não configurado. Use exatamente o nome do personagem que entra no servidor.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.token === 'string' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveState(token) {
  await writeFile(STATE_FILE, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
}

async function botRequest(path, { method = 'GET', token = '', body = null } = {}) {
  const response = await fetch(`${BOT_BASE_URL}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Bot HTTP ${response.status}: ${data.error || text.slice(0, 160)}`);
  return data;
}

async function tshockRequest(path, params = {}) {
  const url = new URL(`${TSHOCK_URL}${path}`);
  url.searchParams.set('token', TSHOCK_TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(7_000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data.status === '400' || data.status === 400) {
    throw new Error(`TShock HTTP ${response.status}: ${data.error || data.response || text.slice(0, 180)}`);
  }
  return data;
}

async function rawCommand(command) {
  return tshockRequest('/v3/server/rawcmd', { cmd: command });
}

function quotedPlayer() {
  return `"${PLAYER_NAME.replaceAll('"', '')}"`;
}

const ACTIONS = Object.freeze({
  meteor: () => tshockRequest('/world/meteor'),
  blood_moon: () => tshockRequest('/v3/world/bloodmoon'),
  kill_player: () => tshockRequest('/v2/players/kill', { player: PLAYER_NAME, from: 'Kick chat' }),
  butcher_hostile: () => tshockRequest('/v2/world/butcher', { killfriendly: false }),
  time_day: () => rawCommand('/time day'),
  time_night: () => rawCommand('/time night'),
  rain_toggle: () => rawCommand('/rain'),
  heal_player: () => rawCommand(`/heal ${quotedPlayer()}`),
  boss_eye: () => rawCommand('/spawnboss 4 1'),
  horde_zombie: () => rawCommand('/spawnmob 3 12'),
});

async function tshockReady() {
  try {
    await tshockRequest('/tokentest');
    return true;
  } catch {
    return false;
  }
}

async function pairIfNeeded() {
  const state = await readState();
  if (state.token) return state.token;
  if (!PAIR_CODE) {
    throw new Error('Ponte ainda não vinculada. Gere /terraria vincular no Discord e informe TERRARIA_PAIR_CODE.');
  }

  const result = await botRequest('/terraria/pair', {
    method: 'POST',
    body: { code: PAIR_CODE, playerName: PLAYER_NAME, version: VERSION },
  });
  await saveState(result.token);
  console.log('✅ Terraria Interactive vinculado. Token salvo localmente.');
  return result.token;
}

async function acknowledge(token, action, ok, error = '') {
  await botRequest('/terraria/ack', {
    method: 'POST',
    token,
    body: { id: action.id, ok, ...(error ? { error: String(error).slice(0, 220) } : {}) },
  });
}

async function executeAction(token, action) {
  const handler = ACTIONS[action.type];
  if (!handler) {
    await acknowledge(token, action, false, `unknown_action:${action.type}`);
    return;
  }

  try {
    await handler();
    await acknowledge(token, action, true);
    console.log(`✅ ${action.type} executado • enviado por ${action.by || 'viewer'}`);
  } catch (error) {
    console.error(`❌ ${action.type}: ${error.message}`);
    await acknowledge(token, action, false, error.message).catch(() => {});
  }
}

async function main() {
  let token = await pairIfNeeded();
  let pollMs = 1200;
  console.log(`🌳 MiojoPlays Terraria Bridge ${VERSION}`);
  console.log(`👤 Jogador alvo: ${PLAYER_NAME}`);
  console.log(`🛠️ TShock: ${TSHOCK_URL}`);

  for (;;) {
    try {
      const ready = await tshockReady();
      const params = new URLSearchParams({
        tshock: ready ? '1' : '0',
        player: PLAYER_NAME,
        version: VERSION,
      });
      const result = await botRequest(`/terraria/pull?${params}`, { token });
      pollMs = Math.max(750, Math.min(5000, Number(result.pollAfterMs) || 1200));
      if (result.action && ready) await executeAction(token, result.action);
    } catch (error) {
      console.error(`⚠️ Ponte: ${error.message}`);
      if (String(error.message).includes('HTTP 401')) {
        token = '';
        await writeFile(STATE_FILE, '{}\n', { mode: 0o600 }).catch(() => {});
        console.error('Vínculo expirou. Gere um novo código /terraria vincular e reinicie a ponte.');
        process.exit(2);
      }
      pollMs = Math.min(10_000, pollMs + 1000);
    }
    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
