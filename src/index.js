import 'dotenv/config';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import { commandData, handleCommand, handleSetupButton } from './commands.js';
import { handleTicketInteraction } from './core/tickets.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID?.trim();
const enableMemberEvents = String(process.env.ENABLE_MEMBER_EVENTS).toLowerCase() === 'true';

if (!token) {
  console.error('DISCORD_TOKEN não configurado. Copie .env.example para .env ou configure a variável no host.');
  process.exit(1);
}

const intents = [GatewayIntentBits.Guilds];
if (enableMemberEvents) intents.push(GatewayIntentBits.GuildMembers);

const client = new Client({ intents });

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

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Online como ${readyClient.user.tag}.`);
  readyClient.user.setActivity('a MiojoPlays Community', { type: ActivityType.Watching });

  try {
    await registerCommands();
  } catch (error) {
    console.error('Falha ao registrar slash commands:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (await handleTicketInteraction(interaction)) return;
    if (await handleSetupButton(interaction)) return;
    if (await handleCommand(interaction)) return;
  } catch (error) {
    console.error('Erro ao processar interação:', error);

    const payload = {
      content: `❌ Ocorreu um erro ao executar esta ação: ${error.message}`,
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
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
          content: `👋 Bem-vindo(a), <@${member.id}>! Dá uma olhada nas regras e aproveita a comunidade. 💜`,
          allowedMentions: { users: [member.id] },
        });
      }
    } catch (error) {
      console.error(`Falha no evento de entrada de ${member.user.tag}:`, error);
    }
  });
}

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

await client.login(token);
