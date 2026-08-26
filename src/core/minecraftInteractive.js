import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { WebSocketServer } from 'ws';
import { characterEmbed, CHARACTER } from './character.js';

const USER_COOLDOWN_MS = 20_000;
const GLOBAL_COOLDOWN_MS = 4_000;
const MAX_PAYLOAD = 64 * 1024;

const persistentToken = process.env.MINECRAFT_BRIDGE_TOKEN?.trim() || '';
const bridgeToken = persistentToken || randomBytes(24).toString('base64url');
const configuredPublicUrl = process.env.MINECRAFT_BRIDGE_PUBLIC_URL?.trim();
const bridgePublicUrl = (configuredPublicUrl || 'wss://dc-bot-us5v.onrender.com/minecraft').replace(/\/+$/, '');

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
      .setDescription('Mostra ao dono o comando privado para conectar o Minecraft.'),
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

function isClientOpen() {
  return Boolean(activeClient && activeClient.readyState === 1);
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

function sendMinecraftCommand(commandLine) {
  if (!isClientOpen()) return { ok: false, reason: 'disconnected' };
  const packet = commandPacket(commandLine);
  activeClient.send(JSON.stringify(packet));
  return { ok: true, requestId: packet.header.requestId };
}

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function connectCommand() {
  return `/connect ${bridgePublicUrl}/${bridgeToken}`;
}

export function minecraftBridgeStatus() {
  return {
    attached: Boolean(websocketServer),
    connected: isClientOpen(),
    interactionsOpen,
    connectedAt,
    lastMessageAt,
    publicUrl: bridgePublicUrl,
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

  // Bedrock may offer com.microsoft.minecraft.wsencrypt even when encrypted
  // websockets are not required. The default `ws` behaviour echoes the first
  // offered subprotocol, which would falsely negotiate Minecraft application-
  // layer encryption. Explicitly decline subprotocol negotiation here.
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
    if (isClientOpen() && activeClient !== client) {
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

    // Não envia pacote automaticamente no handshake. Alguns clientes Bedrock
    // encerram a sessão se o servidor envia comando antes da inicialização do
    // protocolo estar concluída. O primeiro comando só sai via /game acao.
  });

  websocketServer.on('error', (error) => {
    lastBridgeError = String(error?.message || error).slice(0, 180);
    console.error('Erro no servidor Minecraft WebSocket:', error.message);
  });

  return websocketServer;
}

export function stopMinecraftBridge() {
  interactionsOpen = false;
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
  if (status.lastBridgeError) return `🧪 **Diagnóstico:** ${status.lastBridgeError}`;
  if (status.lastCloseCode !== null) {
    const reason = status.lastCloseReason ? ` • ${status.lastCloseReason}` : '';
    return `🧪 **Último fechamento:** código ${status.lastCloseCode}${reason}`;
  }
  if (status.lastUpgradeAt) return '🧪 **Diagnóstico:** handshake recebido; aguardando nova tentativa.';
  return null;
}

function statusDescription(status) {
  const diagnostic = diagnosticLine(status);
  return [
    `🎮 **Minecraft:** ${status.connected ? '🟢 conectado' : '🔴 desconectado'}`,
    `🎛️ **Interações:** ${status.interactionsOpen ? '🟢 abertas' : '🔒 fechadas'}`,
    `🔐 **Ponte:** ${status.attached ? 'ativa' : 'inativa'}`,
    diagnostic,
    '',
    status.connected
      ? 'O mundo está conectado. O dono pode usar `/game abrir` para liberar as ações da comunidade.'
      : 'O dono precisa usar `/game conectar` e executar o comando mostrado dentro do Minecraft.',
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
        '🎮 **No Minecraft Bedrock, dentro do seu mundo com cheats ativados, execute:**',
        `\`${connectCommand()}\``,
        '',
        'Deixe **Exigir WebSockets criptografados** desativado. Essa resposta é privada; não compartilhe o comando porque ele contém a chave da ponte.',
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

    if (subcommand === 'abrir' && !isClientOpen()) {
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
    }

    await interaction.reply({
      content: interactionsOpen
        ? '🟢 Game Interactive **ABERTO**. A comunidade já pode usar `/game acao`.'
        : '🔒 Game Interactive **FECHADO**. Nenhuma nova ação será enviada ao Minecraft.',
    });
    return true;
  }

  if (subcommand === 'acao') {
    if (!isClientOpen()) {
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
        description: `**${interaction.user.username}** ativou uma interação no Minecraft.\n\n${action.description}`,
        color: CHARACTER.palette.accent,
      })],
    });
    return true;
  }

  return true;
}
