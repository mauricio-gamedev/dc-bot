import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { commandData, handleCommand, handleSetupButton } from './commands.js';
import { handleTicketInteraction } from './core/tickets.js';
import { attachLogging } from './core/logging.js';
import { handleMessageProgress } from './core/progression.js';
import { flushAllProfiles } from './core/communityStore.js';
import { characterEmbed, characterLine, CHARACTER } from './core/character.js';
import { ensureSelfRolePanel, handleV3Button } from './core/communityV3.js';
import { handleOwnerCoinCommand, ownerCoinCommandData } from './core/ownerCoins.js';
import { eventCommandBuilder, handleEventButton, handleEventCommand } from './core/eventAgenda.js';
import { handleSealCommand, sealCommandData } from './core/personalSeals.js';
import { handleIdentityCommand, identityCommandData } from './core/identityCommands.js';
import { enforceCommandAccess } from './core/commandAccess.js';
import { ensureCommandGuide } from './core/commandGuide.js';
import {
  communityAutomationStatus,
  startCommunityAutomation,
  stopCommunityAutomation,
} from './core/communityAutomation.js';
import {
  attachMinecraftBridge,
  handleMinecraftCommand,
  minecraftBridgeStatus,
  minecraftCommandData,
  stopMinecraftBridge,
} from './core/minecraftInteractive.js';
import {
  handleMindustryCommand,
  handleMindustryHttp,
  mindustryCommandData,
  mindustryStatus,
} from './core/mindustryInteractive.js';
import {
  handleKickLiveButton,
  kickLiveStatus,
  startKickLiveWatcher,
  stopKickLiveWatcher,
} from './core/kickLive.js';
import {
  handleKickInteractiveCommand,
  handleKickInteractiveHttp,
  kickInteractiveCommandData,
  kickInteractiveStatus,
} from './core/kickInteractive.js';
import {
  handleVoiceCommand,
  handleVoiceHttp,
  voiceCommandData,
  voiceStatus,
} from './core/voiceInteractive.js';

const packageMetadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const appVersion = String(packageMetadata.version || '0.0.0');
const deployCommit = String(process.env.RENDER_GIT_COMMIT || '').trim() || null;
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID?.trim();
const enableMemberEvents = String(process.env.ENABLE_MEMBER_EVENTS).toLowerCase() === 'true';
const port = Number(process.env.PORT || 3000);
const startedAt = new Date();
const registeredCommandData = [
  ...commandData,
  ownerCoinCommandData,
  eventCommandBuilder.toJSON(),
  ...sealCommandData,
  identityCommandData,
  minecraftCommandData,
  mindustryCommandData,
  kickInteractiveCommandData,
  voiceCommandData,
];

const officialAssets = new Map([
  ['miojo-seal-static.png', { file: new URL('../assets/miojo-seal-static.png', import.meta.url), contentType: 'image/png' }],
  ['miojo-seal-animated.gif', { file: new URL('../assets/miojo-seal-animated.gif', import.meta.url), contentType: 'image/gif' }],
]);

async function serveOfficialAsset(req, res, pathname) {
  if (!pathname.startsWith('/assets/')) return false;

  const filename = pathname.slice('/assets/'.length);
  const asset = officialAssets.get(filename);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'asset_not_found' }));
    return true;
  }

  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return true;
  }

  const data = await readFile(asset.file);
  res.writeHead(200, {
    'content-type': asset.contentType,
    'content-length': data.length,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

if (!token) {
  console.error('DISCORD_TOKEN não configurado. Copie .env.example para .env ou configure a variável no host.');
  process.exit(1);
}

if (!guildId) {
  console.error('DISCORD_GUILD_ID é obrigatório. O MiojoPlays Bot opera em modo privado e não registra comandos globais.');
  process.exit(1);
}

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration,
];
if (enableMemberEvents) intents.push(GatewayIntentBits.GuildMembers);

const client = new Client({ intents });
attachLogging(client);

const healthServer = http.createServer(async (req, res) => {
  try {
    if (await handleKickInteractiveHttp(req, res, client)) return;
    if (await handleMindustryHttp(req, res, client)) return;
    if (await handleVoiceHttp(req, res, client)) return;

    const path = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

    if (await serveOfficialAsset(req, res, path)) return;

    if (path !== '/' && path !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    const ready = client.isReady();
    const kick = kickLiveStatus();
    const kickChat = kickInteractiveStatus(guildId);
    const minecraft = minecraftBridgeStatus();
    const mindustry = mindustryStatus(guildId);
    const voice = voiceStatus(guildId);
    const automation = communityAutomationStatus();
    const body = {
      ok: ready,
      service: 'MiojoPlays Community Bot',
      version: appVersion,
      deployCommit,
      character: CHARACTER.name,
      discord: ready ? 'online' : 'connecting',
      privateGuildMode: true,
      kickLive: {
        enabled: kick.enabled,
        configured: kick.configured,
        polling: kick.polling,
        live: Boolean(kick.lastState?.isLive),
        slug: kick.slug,
      },
      kickInteractive: {
        enabled: kickChat.enabled,
        configured: kickChat.configured,
        subscribed: kickChat.subscribed,
        lastWebhookAt: kickChat.lastWebhookAt,
        lastCommandAt: kickChat.lastCommandAt,
      },
      minecraftInteractive: {
        bridge: minecraft.attached,
        connected: minecraft.connected,
        interactionsOpen: minecraft.interactionsOpen,
        connectedAt: minecraft.connectedAt,
      },
      mindustryInteractive: {
        connected: mindustry.connected,
        interactionsOpen: mindustry.interactionsOpen,
        linkedAt: mindustry.linkedAt,
        lastSeenAt: mindustry.lastSeenAt,
      },
      voiceInteractive: {
        connected: voice.connected,
        linkedAt: voice.linkedAt,
        lastSeenAt: voice.lastSeenAt,
        preset: voice.preset,
        intensity: voice.intensity,
        route: voice.device?.route || null,
      },
      communityAutomation: automation,
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    };

    res.writeHead(ready ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  } catch (error) {
    console.error('Falha no servidor HTTP:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
    } else {
      res.end();
    }
  }
});

attachMinecraftBridge(healthServer);
healthServer.listen(port, '0.0.0.0', () => {
  console.log(`Health server ativo na porta ${port}.`);
});

async function registerCommands() {
  if (!client.application) throw new Error('Aplicação Discord ainda não está disponível.');

  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(registeredCommandData);
  console.log(`Slash commands privados registrados em ${guild.name} (${guild.id}).`);
}

async function enforcePrivateGuildScope() {
  for (const guild of client.guilds.cache.values()) {
    if (guild.id === guildId) continue;
    console.warn(`Servidor não autorizado detectado: ${guild.name} (${guild.id}). Saindo.`);
    await guild.leave().catch((error) => {
      console.error(`Falha ao sair do servidor não autorizado ${guild.id}:`, error.message);
    });
  }
}

async function ensurePanels() {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  await guild.channels.fetch().catch(() => {});
  const rolesChannel = guild.channels.cache.find(
    (channel) => channel.name === '🎭・cargos' && channel.isTextBased(),
  );
  await ensureSelfRolePanel(guild, rolesChannel).catch((error) => {
    console.error(`Falha ao garantir painel de cargos em ${guild.name}:`, error);
  });
  await ensureCommandGuide(guild).catch((error) => {
    console.error(`Falha ao garantir guia de comandos em ${guild.name}:`, error);
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Online como ${readyClient.user.tag}.`);
  readyClient.user.setActivity(`${CHARACTER.name} protege a comunidade`, { type: ActivityType.Watching });

  try {
    await enforcePrivateGuildScope();
    await registerCommands();
    await ensurePanels();
    startCommunityAutomation(client);
    startKickLiveWatcher(client);
  } catch (error) {
    console.error('Falha no bootstrap do bot:', error);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  if (guild.id === guildId) return;
  console.warn(`Instalação não autorizada bloqueada em ${guild.name} (${guild.id}).`);
  await guild.leave().catch(() => {});
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.guildId && interaction.guildId !== guildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: '🔒 Este bot é privado e só funciona no servidor oficial configurado.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const allowed = await enforceCommandAccess(interaction, { guildId });
      if (!allowed) return;
    }

    if (await handleKickLiveButton(interaction)) return;
    if (await handleKickInteractiveCommand(interaction)) return;
    if (await handleEventButton(interaction)) return;
    if (await handleOwnerCoinCommand(interaction)) return;
    if (await handleEventCommand(interaction)) return;
    if (await handleIdentityCommand(interaction)) return;
    if (await handleSealCommand(interaction)) return;
    if (await handleVoiceCommand(interaction)) return;
    if (await handleMindustryCommand(interaction)) return;
    if (await handleMinecraftCommand(interaction)) return;
    if (await handleV3Button(interaction)) return;
    if (await handleTicketInteraction(interaction)) return;
    if (await handleSetupButton(interaction)) return;
    if (await handleCommand(interaction)) return;
  } catch (error) {
    console.error('Erro ao processar interação:', error);

    const payload = {
      content: `❌ Ocorreu um erro ao executar esta ação: ${error.message}`,
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.guildId !== guildId) return;
  try {
    await handleMessageProgress(message);
  } catch (error) {
    console.error('Falha no sistema de progressão:', error);
  }
});

if (enableMemberEvents) {
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== guildId) return;
    try {
      const memberRole = member.guild.roles.cache.find((role) => role.name === '👤・Membro');
      if (memberRole && memberRole.editable) await member.roles.add(memberRole, 'Entrada automática na comunidade');

      const welcome = member.guild.channels.cache.find(
        (channel) => channel.name === '👋・boas-vindas' && channel.isTextBased(),
      );

      if (welcome) {
        await welcome.send({
          content: `<@${member.id}>`,
          embeds: [characterEmbed({
            title: `${CHARACTER.name} recebeu um novo membro`,
            description: `${characterLine('welcome', member.user.username)}\n\n📜 Leia as regras, escolha seus cargos e aproveita a comunidade.`,
            color: CHARACTER.palette.success,
            presentation: 'hero',
          })],
          allowedMentions: { users: [member.id] },
        });
      }
    } catch (error) {
      console.error(`Falha no evento de entrada de ${member.user.tag}:`, error);
    }
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} recebido. Persistindo dados e encerrando com segurança...`);

  stopCommunityAutomation();
  stopKickLiveWatcher();
  stopMinecraftBridge();
  await flushAllProfiles(client).catch((error) => {
    console.error('Falha ao persistir perfis no shutdown:', error);
  });

  healthServer.close();
  client.destroy();
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

await client.login(token);
