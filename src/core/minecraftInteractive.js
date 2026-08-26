import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { WebSocketServer } from 'ws';
import { characterEmbed, CHARACTER } from './character.js';

const USER_COOLDOWN_MS = 20_000;
const GLOBAL_COOLDOWN_MS = 4_000;
const MAX_PAYLOAD = 64 * 1024;
const RELAY_ACTIVE_MS = 12_000;
const RELAY_QUEUE_LIMIT = 20;

const persistentToken = process.env.MINECRAFT_BRIDGE_TOKEN?.trim() || '';
const bridgeToken = persistentToken || randomBytes(24).toString('base64url');
const configuredPublicUrl = process.env.MINECRAFT_BRIDGE_PUBLIC_URL?.trim();
const bridgePublicUrl = (configuredPublicUrl || 'wss://dc-bot-us5v.onrender.com/minecraft').replace(/\/+$/, '');
const relayPublicBase = (process.env.MINECRAFT_RELAY_PUBLIC_URL?.trim() || 'https://dc-bot-us5v.onrender.com').replace(/\/+$/, '');
const relayMinecraftCommand = '/connect ws://127.0.0.1:19131/ws';

const ACTIONS = Object.freeze({
  zombie: {
    label: '🧟 Invocar zumbi',
    description: 'Invoca um zumbi perto do jogador.',
    command: 'execute at @p run summon zombie ~ ~ ~3',
  },
  lightning: {
    label: '⚡ Invocar raio',
    description: 'Faz um raio cair perto do jogador.',
    command: 'execute at @p run summon lightning_bolt ~ ~ ~',
  },
  blindness: {
    label: '🌑 Cegueira',
    description: 'Aplica cegueira curta no jogador.',
    command: 'effect @p blindness 5 0 true',
  },
  speed: {
    label: '💨 Velocidade',
    description: 'Dá um boost de velocidade por alguns segundos.',
    command: 'effect @p speed 15 1 true',
  },
  levitation: {
    label: '🪽 Levitação',
    description: 'Faz o jogador levitar rapidamente.',
    command: 'effect @p levitation 3 0 true',
  },
  night: {
    label: '🌙 Virar noite',
    description: 'Muda o horário do mundo para noite.',
    command: 'time set night',
  },
  rain: {
    label: '🌧️ Chuva',
    description: 'Ativa chuva por um período curto.',
    command: 'weather rain 30',
  },
  chicken: {
    label: '🐔 Galinha surpresa',
    description: 'Invoca uma galinha perto do jogador.',
    command: 'execute at @p run summon chicken ~2 ~ ~',
  },
});

const actionChoices = Object.entries(ACTIONS).map(([value, action]) => ({
  name: action.label,
  value,
}));

export const minecraftCommandBuilder = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Controla o Game Interactive do Minecraft Bedrock.')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Mostra o status da conexão com o Minecraft.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('conectar')
      .setDescription('Mostra ao dono como conectar o relay Android ao Minecraft.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('abrir')
      .setDescription('Abre as interações do Discord com o jogo.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('fechar')
      .setDescription('Fecha as interações do Discord com o jogo.'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('acao')
      .setDescription('Envia uma interação segura para o Minecraft.')
      .addStringOption((option) =>
        option
          .setName('tipo')
          .setDescription('Escolha a interação.')
          .setRequired(true)
          .addChoices(...actionChoices),
      ),
  );

export const minecraftCommandData = minecraftCommandBuilder.toJSON();

let websocketServer = null;
let activeClient = null;
let connectedAt = null;
let lastMessageAt = null;
let interactionsOpen = false;
let lastGlobalActionAt = 0;
let lastUpgradeAt = null;
let lastUpgradeProtocolOffer = null;
let lastCloseCode = null;
let lastCloseReason = null;
let lastBridgeError = null;
let relayLastSeenAt = 0;
let relayConnectedAt = null;
let relayHadActiveSession = false;
const relayQueue = [];
const userCooldowns = new Map();

function safeTokenMatch(candidate) {
  const left = Buffer.from(String(candidate || ''));
  const right = Buffer.from(bridgeToken);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function connectionPathToken(requestUrl) {
  try {
    const url = new URL(requestUrl || '/', 'http://localhost');
    const prefix = '/minecraft/';
    if (!url.pathname.startsWith(prefix)) return null;
    const candidate = decodeURIComponent(url.pathname.slice(prefix.length));
    return candidate || null;
  } catch {
    return null;
  }
}

function isDirectClientOpen() {
  return Boolean(activeClient && activeClient.readyState === 1);
}

function isRelayActive(now = Date.now()) {
  return relayLastSeenAt > 0 && now - relayLastSeenAt <= RELAY_ACTIVE_MS;
}

function reconcileRelayState() {
  const active = isRelayActive();
  if (!active && relayHadActiveSession) {
    relayHadActiveSession = false;
    relayConnectedAt = null;
    relayQueue.length = 0;
    if (!isDirectClientOpen()) interactionsOpen = false;
  }
  return active;
}

function connectionMode() {
  if (isDirectClientOpen()) return 'direct';
  if (reconcileRelayState()) return 'android-relay';
  return null;
}

function isGameConnected() {
  return Boolean(connectionMode());
}

function commandPacket(commandLine) {
  return {
    header: {
      version: 1,
      requestId: randomUUID(),
      messageType: 'commandRequest',
      messagePurpose: 'commandRequest',
    },
    body: {
      version: 1,
      commandLine,
      origin: { type: 'player' },
      overworld: 'default',
    },
  };
}

function enqueueRelayCommand(commandLine) {
  if (!reconcileRelayState()) return { ok: false, reason: 'relay_disconnected' };
  if (relayQueue.length >= RELAY_QUEUE_LIMIT) relayQueue.shift();
  const command = {
    id: randomUUID(),
    commandLine,
    createdAt: new Date().toISOString(),
  };
  relayQueue.push(command);
  return { ok: true, requestId: command.id, mode: 'android-relay' };
}

function sendMinecraftCommand(commandLine) {
  if (isDirectClientOpen()) {
    const packet = commandPacket(commandLine);
    activeClient.send(JSON.stringify(packet));
    return { ok: true, requestId: packet.header.requestId, mode: 'direct' };
  }
  return enqueueRelayCommand(commandLine);
}

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function legacyConnectCommand() {
  return `/connect ${bridgePublicUrl}/${bridgeToken}`;
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function handleMinecraftRelayHttp(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return false;
  }

  if (!url.pathname.startsWith('/minecraft-relay/')) return false;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'minecraft-relay' || parts[2] !== 'pull') {
    jsonResponse(res, 404, { ok: false, error: 'not_found' });
    return true;
  }

  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  let candidate;
  try {
    candidate = decodeURIComponent(parts[1]);
  } catch {
    jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }

  if (!safeTokenMatch(candidate)) {
    jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }

  const wasActive = isRelayActive();
  relayLastSeenAt = Date.now();
  if (!wasActive) {
    relayConnectedAt = new Date(relayLastSeenAt).toISOString();
    relayHadActiveSession = true;
    relayQueue.length = 0;
    interactionsOpen = false;
    userCooldowns.clear();
    lastGlobalActionAt = 0;
  }

  const command = relayQueue.shift() ?? null;
  jsonResponse(res, 200, {
    ok: true,
    mode: 'android-relay',
    command,
    pollAfterMs: 1000,
  });
  return true;
}

export function minecraftBridgeStatus() {
  const relayConnected = reconcileRelayState();
  const directConnected = isDirectClientOpen();
  const mode = directConnected ? 'direct' : relayConnected ? 'android-relay' : null;
  return {
    attached: Boolean(websocketServer),
    connected: directConnected || relayConnected,
    directConnected,
    relayConnected,
    connectionMode: mode,
    interactionsOpen,
    connectedAt: directConnected ? connectedAt : relayConnectedAt,
    lastMessageAt,
    publicUrl: bridgePublicUrl,
    relayPublicBase,
    relayLastSeenAt: relayLastSeenAt ? new Date(relayLastSeenAt).toISOString() : null,
    relayQueueSize: relayQueue.length,
    persistentToken: Boolean(persistentToken),
    lastUpgradeAt,
    lastUpgradeProtocolOffer,
    lastCloseCode,
    lastCloseReason,
    lastBridgeError,
  };
}

export function attachMinecraftBridge(httpServer) {
  if (websocketServer) return websocketServer;

  // Mantém o transporte WSS direto apenas como fallback experimental.
  // O caminho recomendado no Android é o relay local, que implementa o
  // protocolo/criptografia específicos do Minecraft Bedrock em ws://localhost.
  websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    handleProtocols: () => false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    lastUpgradeAt = new Date().toISOString();
    lastUpgradeProtocolOffer = request.headers['sec-websocket-protocol'] || null;
    lastBridgeError = null;

    const token = connectionPathToken(request.url);
    if (!token || !safeTokenMatch(token)) {
      lastBridgeError = 'unauthorized_path_or_token';
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        websocketServer.emit('connection', client, request);
      });
    } catch (error) {
      lastBridgeError = `upgrade_failed:${error.message}`.slice(0, 180);
      socket.destroy();
    }
  });

  websocketServer.on('connection', (client) => {
    if (isDirectClientOpen() && activeClient !== client) {
      activeClient.close(4000, 'Nova conexão Minecraft autenticada');
    }

    activeClient = client;
    connectedAt = new Date().toISOString();
    lastMessageAt = null;
    lastCloseCode = null;
    lastCloseReason = null;
    lastBridgeError = null;
    interactionsOpen = false;
    userCooldowns.clear();
    lastGlobalActionAt = 0;

    client.on('message', (data) => {
      lastMessageAt = new Date().toISOString();
      if (data.length > MAX_PAYLOAD) client.close(1009, 'Payload muito grande');
    });

    client.on('close', (code, reason) => {
      lastCloseCode = Number(code) || 0;
      lastCloseReason = Buffer.isBuffer(reason)
        ? reason.toString('utf8').slice(0, 160)
        : String(reason || '').slice(0, 160);

      if (activeClient === client) {
        activeClient = null;
        interactionsOpen = false;
        connectedAt = null;
      }
    });

    client.on('error', (error) => {
      lastBridgeError = String(error?.message || error).slice(0, 180);
      console.error('Erro na conexão Minecraft WebSocket:', error.message);
    });
  });

  websocketServer.on('error', (error) => {
    lastBridgeError = String(error?.message || error).slice(0, 180);
    console.error('Erro no servidor Minecraft WebSocket:', error.message);
  });

  return websocketServer;
}

export function stopMinecraftBridge() {
  interactionsOpen = false;
  relayQueue.length = 0;
  relayLastSeenAt = 0;
  relayConnectedAt = null;
  relayHadActiveSession = false;

  if (activeClient) {
    try {
      activeClient.close(1001, 'Bot encerrando');
    } catch {
      // conexão já encerrada
    }
    activeClient = null;
  }
  if (websocketServer) {
    try {
      websocketServer.close();
    } catch {
      // servidor já encerrado
    }
    websocketServer = null;
  }
}

function diagnosticLine(status) {
  if (status.connected) return null;
  if (status.lastBridgeError) return `🧪 **WSS direto:** ${status.lastBridgeError}`;
  if (status.lastCloseCode !== null) {
    const reason = status.lastCloseReason ? ` • ${status.lastCloseReason}` : '';
    return `🧪 **Último WSS direto:** código ${status.lastCloseCode}${reason}`;
  }
  return '📱 **Relay Android:** aguardando o relay local conectar ao Minecraft.';
}

function statusDescription(status) {
  const diagnostic = diagnosticLine(status);
  const mode = status.connectionMode === 'android-relay'
    ? '📱 relay Android local'
    : status.connectionMode === 'direct'
      ? '🌐 WSS direto (experimental)'
      : 'nenhum';
  return [
    `🎮 **Minecraft:** ${status.connected ? '🟢 conectado' : '🔴 desconectado'}`,
    `📡 **Modo:** ${mode}`,
    `🎛️ **Interações:** ${status.interactionsOpen ? '🟢 abertas' : '🔒 fechadas'}`,
    `🔐 **Ponte:** ${status.attached ? 'ativa' : 'inativa'}`,
    diagnostic,
    '',
    status.connected
      ? 'O mundo está conectado. O dono pode usar `/game abrir` para liberar as ações da comunidade.'
      : 'No Android, inicie o relay local e depois execute o comando local mostrado por `/game conectar` dentro do Minecraft.',
  ].filter(Boolean).join('\n');
}

export async function handleMinecraftCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;
  if (interaction.commandName !== 'game') return false;

  const subcommand = interaction.options.getSubcommand();
  const status = minecraftBridgeStatus();

  if (subcommand === 'status') {
    await interaction.reply({
      embeds: [characterEmbed({
        title: '🎮 Minecraft Game Interactive',
        description: statusDescription(status),
        color: status.connected ? CHARACTER.palette.success : CHARACTER.palette.warning,
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (subcommand === 'conectar') {
    if (!ownerOnly(interaction)) {
      await interaction.reply({
        content: 'Somente o dono real do servidor pode ver a chave de conexão do Minecraft.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.reply({
      content: [
        '📱 **Modo recomendado no Android: Relay local**',
        '',
        `**Servidor do bot:** \`${relayPublicBase}\``,
        `**Chave privada do relay:** \`${bridgeToken}\``,
        `**Comando dentro do Minecraft:** \`${relayMinecraftCommand}\``,
        '',
        '1. Inicie o relay MiojoPlays no Android usando o servidor e a chave acima.',
        '2. Entre no mundo com cheats ativados.',
        '3. Execute o comando local acima no Minecraft.',
        '4. Confira com `/game status` e depois use `/game abrir`.',
        '',
        '⚠️ Não compartilhe a chave. O WSS direto antigo fica apenas como fallback experimental.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (subcommand === 'abrir' || subcommand === 'fechar') {
    if (!ownerOnly(interaction)) {
      await interaction.reply({
        content: 'Somente o dono real do servidor pode abrir ou fechar as interações com o jogo.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (subcommand === 'abrir' && !isGameConnected()) {
      await interaction.reply({
        content: '❌ O Minecraft ainda não está conectado. Use `/game conectar` primeiro.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    interactionsOpen = subcommand === 'abrir';
    if (!interactionsOpen) {
      userCooldowns.clear();
      lastGlobalActionAt = 0;
      relayQueue.length = 0;
    }

    await interaction.reply({
      content: interactionsOpen
        ? '🟢 Game Interactive **ABERTO**. A comunidade já pode usar `/game acao`.'
        : '🔒 Game Interactive **FECHADO**. Nenhuma nova ação será enviada ao Minecraft.',
    });
    return true;
  }

  if (subcommand === 'acao') {
    if (!isGameConnected()) {
      await interaction.reply({
        content: '🎮 O Minecraft não está conectado agora.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (!interactionsOpen) {
      await interaction.reply({
        content: '🔒 O Game Interactive está fechado pelo dono.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const now = Date.now();
    const userReadyAt = userCooldowns.get(interaction.user.id) || 0;
    if (now < userReadyAt) {
      const seconds = Math.ceil((userReadyAt - now) / 1000);
      await interaction.reply({
        content: `⏳ Aguarda **${seconds}s** para mandar outra interação.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (now - lastGlobalActionAt < GLOBAL_COOLDOWN_MS) {
      const seconds = Math.max(1, Math.ceil((GLOBAL_COOLDOWN_MS - (now - lastGlobalActionAt)) / 1000));
      await interaction.reply({
        content: `⏳ O jogo acabou de receber uma ação. Tenta novamente em **${seconds}s**.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const actionId = interaction.options.getString('tipo', true);
    const action = ACTIONS[actionId];
    if (!action) {
      await interaction.reply({ content: 'Ação inválida.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const sent = sendMinecraftCommand(action.command);
    if (!sent.ok) {
      await interaction.reply({
        content: '❌ A conexão com o Minecraft caiu antes da ação ser enviada.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    userCooldowns.set(interaction.user.id, now + USER_COOLDOWN_MS);
    lastGlobalActionAt = now;

    await interaction.reply({
      embeds: [characterEmbed({
        title: `🎮 ${action.label}`,
        description: `**${interaction.user.username}** ativou uma interação no Minecraft.\n\n${action.description}\n\n📡 Enviado via **${sent.mode === 'android-relay' ? 'relay Android' : 'WSS direto'}**.`,
        color: CHARACTER.palette.accent,
      })],
    });
    return true;
  }

  return true;
}

export function minecraftRelayPrivateConfig() {
  return {
    server: relayPublicBase,
    token: bridgeToken,
    minecraftCommand: relayMinecraftCommand,
    legacyDirectCommand: legacyConnectCommand(),
  };
}
