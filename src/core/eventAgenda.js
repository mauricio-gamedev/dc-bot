import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { BRAND } from './blueprint.js';
import { characterEmbed, CHARACTER } from './character.js';

const publishing = new Set();

export const eventCommandBuilder = new SlashCommandBuilder()
  .setName('evento')
  .setDescription('Gerencia eventos oficiais da comunidade.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('criar')
      .setDescription('Publica um evento oficial na agenda.')
      .addStringOption((option) =>
        option
          .setName('titulo')
          .setDescription('Título do evento.')
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName('quando')
          .setDescription('Data/horário em texto, por exemplo: sábado, 20h (Manaus).')
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(120),
      )
      .addStringOption((option) =>
        option
          .setName('detalhes')
          .setDescription('Descrição e regras do evento.')
          .setRequired(true)
          .setMinLength(5)
          .setMaxLength(2500),
      )
      .addStringOption((option) =>
        option
          .setName('link')
          .setDescription('Link opcional do evento, live, inscrição ou sala.')
          .setMaxLength(500),
      ),
  );

function validHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function agendaChannel(guild) {
  return guild.channels.cache.find(
    (channel) => channel.name === '🗓️・agenda' && channel.isTextBased(),
  ) ?? null;
}

function eventRole(guild) {
  return guild.roles.cache.find((role) => role.name === '🎉・Eventos') ?? null;
}

export async function handleEventCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;
  if (interaction.commandName !== 'evento') return false;

  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Somente a staff responsável pela comunidade pode publicar eventos oficiais.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.options.getSubcommand() !== 'criar') return true;

  const lockKey = `${interaction.guild.id}:${interaction.user.id}`;
  if (publishing.has(lockKey)) {
    await interaction.reply({
      content: 'Já existe uma publicação de evento sua em andamento.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  publishing.add(lockKey);
  try {
    await interaction.guild.channels.fetch().catch(() => {});
    await interaction.guild.roles.fetch().catch(() => {});

    const channel = agendaChannel(interaction.guild);
    if (!channel) {
      await interaction.reply({
        content: 'Canal `🗓️・agenda` não encontrado. Execute `/repair` primeiro.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const title = interaction.options.getString('titulo', true).trim();
    const when = interaction.options.getString('quando', true).trim();
    const details = interaction.options.getString('detalhes', true).trim();
    const rawLink = interaction.options.getString('link')?.trim() || null;
    const link = validHttpUrl(rawLink);

    if (rawLink && !link) {
      await interaction.reply({
        content: 'O link do evento precisa começar com `http://` ou `https://` e ser válido.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const embed = characterEmbed({
      title: `🎉 ${title}`,
      description: [
        '**Evento oficial da MiojoPlays**',
        '',
        `🗓️ **Quando:** ${when}`,
        `👤 **Organização:** ${interaction.user}`,
        '',
        details,
        '',
        '✅ Reaja com **✅** se vai participar.',
        '🤔 Reaja com **🤔** se talvez participe.',
      ].join('\n'),
      color: CHARACTER.palette.accent,
      presentation: 'badge',
      seal: 'static',
      footer: `${BRAND.footer} • Evento oficial`,
    });

    const components = [];
    if (link) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Abrir link do evento')
            .setStyle(ButtonStyle.Link)
            .setURL(link),
        ),
      );
    }

    const role = eventRole(interaction.guild);
    const sent = await channel.send({
      content: role ? `<@&${role.id}>` : undefined,
      embeds: [embed],
      components,
      allowedMentions: role ? { roles: [role.id] } : { parse: [] },
    });

    await sent.react('✅').catch(() => {});
    await sent.react('🤔').catch(() => {});

    await interaction.reply({
      content: `✅ Evento publicado em <#${channel.id}>. ${sent.url}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  } finally {
    publishing.delete(lockKey);
  }
}
