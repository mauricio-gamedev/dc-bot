import 'dotenv/config';
import http from 'node:http';
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
import { kickLiveStatus, startKickLiveWatcher, stopKickLiveWatcher } from './core/kickLive.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID?.trim();
const enableMemberEvents = String(process.env.ENABLE_MEMBER_EVENTS).toLowerCase() === 'true';
const port = Number(process.env.PORT || 3000);
const startedAt = new Date();

if (!token) {
  console.error('DISCORD_TOKEN não configurado. Copie .env.example para .env ou configure a variável no host.');
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

const healthServer = http.createServer((req, res) => {
  const path = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

  if (path !== '/' && path !== '/health') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return;
  }

  const ready = client.isReady();
  const kick = kickLiveStatus();
  const body = {
    ok: ready,
    service: 'MiojoPlays Community Bot',
    version: '0.4.0',
    character: CHARACTER.name,
    discord: ready ? 'online' : 'connecting',
    kickLive: {
      enabled: kick.enabled,
      configured: kick.configured,
      polling: kick.polling,
      live: Boolean(kick.lastState?.isLive),
      slug: kick.slug,
    },
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    timestamp: new Date().toISOString(),
  };

  res.writeHead(ready ? 200 : 503, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
});

healthServer.listen(port, '0.0.0.0', () => {
  console.log(`Health server ativo na porta ${port}.`);
});

async function registerCommands() {
  if (!client.application) throw new Error('Aplicação Discord ainda não está disponível.');

  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commandData);
    console.log(`Slash commands registrados instantaneamente em ${guild.name} (${guild.id}).`);
    return;
  }

  await client.application.commands.set(commandData);
  console.log('Slash commands registrados globalmente. A propagação global pode levar alguns minutos.');
}

async function ensurePanels() {
  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch().catch(() => {});
    const rolesChannel = guild.channels.cache.find(
      (channel) => channel.name === '🎭・cargos' && channel.isTextBased(),
    );
    await ensureSelfRolePanel(guild, rolesChannel).catch((error) => {
      console.error(`Falha ao garantir painel de cargos em ${guild.name}:`, error);
    });
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Online como ${readyClient.user.tag}.`);
  readyClient.user.setActivity(`${CHARACTER.name} protege a comunidade`, { type: ActivityType.Watching });

  try {
    await registerCommands();
    await ensurePanels();
    startKickLiveWatcher(client);
  } catch (error) {
    console.error('Falha no bootstrap do bot:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
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
  try {
    await handleMessageProgress(message);
  } catch (error) {
    console.error('Falha no sistema de progressão:', error);
  }
});

if (enableMemberEvents) {
  client.on(Events.GuildMemberAdd, async (member) => {
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

  stopKickLiveWatcher();
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
