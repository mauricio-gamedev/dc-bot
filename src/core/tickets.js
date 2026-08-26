import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { BRAND, STAFF_ROLE_NAMES } from './blueprint.js';

const PANEL_MARKER = 'miojoplays:ticket-panel:v1';
const TICKET_TOPIC_PREFIX = 'miojoplays-ticket-owner:';

function ticketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:create')
      .setLabel('Abrir atendimento')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );
}

function closeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Fechar ticket')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
}

export async function ensureTicketPanel(guild, channel, roleMap, report) {
  if (!channel?.isTextBased?.()) {
    report.warnings.push('Canal de tickets não encontrado para publicar o painel.');
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const exists = messages.some((message) =>
      message.author.bot && message.embeds.some((embed) => embed.footer?.text?.includes(PANEL_MARKER)),
    );
    if (exists) return;
  } catch {
    // If history cannot be read, publish a fresh panel instead of breaking setup.
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('🎫 Atendimento privado')
    .setDescription([
      'Precisa falar com a equipe? Abra um ticket usando o botão abaixo.',
      '',
      '• O canal criado será privado.',
      '• Apenas você e a equipe de suporte poderão visualizar.',
      '• Evite abrir vários tickets para o mesmo assunto.',
      '',
      'Explique o problema com o máximo de contexto possível para agilizar o atendimento.',
    ].join('\n'))
    .setFooter({ text: `${BRAND.footer} • ${PANEL_MARKER}` });

  await channel.send({ embeds: [embed], components: [ticketRow()] });
  report.messagesSeeded.push(channel.name);
}

function staffPermissionOverwrites(guild, roleMap, ownerId) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  for (const roleName of STAFF_ROLE_NAMES) {
    const role = roleMap.get(roleName);
    if (!role) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  return overwrites;
}

export async function handleTicketInteraction(interaction) {
  if (!interaction.isButton() || !interaction.guild) return false;
  if (!interaction.customId.startsWith('ticket:')) return false;

  if (interaction.customId === 'ticket:create') {
    await interaction.deferReply({ ephemeral: true });

    await interaction.guild.channels.fetch();
    await interaction.guild.roles.fetch();

    const existing = interaction.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildText && channel.topic === `${TICKET_TOPIC_PREFIX}${interaction.user.id}`,
    );

    if (existing) {
      await interaction.editReply(`Você já possui um ticket aberto: <#${existing.id}>`);
      return true;
    }

    const supportCategory = interaction.guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === '🛠️・SUPORTE',
    );

    if (!supportCategory) {
      await interaction.editReply('O sistema de suporte ainda não foi configurado. Um administrador deve executar `/repair`.');
      return true;
    }

    const roleMap = new Map();
    for (const roleName of STAFF_ROLE_NAMES) {
      roleMap.set(roleName, interaction.guild.roles.cache.find((role) => role.name === roleName));
    }

    const suffix = interaction.user.id.slice(-6);
    const ticket = await interaction.guild.channels.create({
      name: `ticket-${suffix}`,
      type: ChannelType.GuildText,
      parent: supportCategory.id,
      topic: `${TICKET_TOPIC_PREFIX}${interaction.user.id}`,
      permissionOverwrites: staffPermissionOverwrites(interaction.guild, roleMap, interaction.user.id),
      reason: `Ticket aberto por ${interaction.user.tag}`,
    });

    const embed = new EmbedBuilder()
      .setColor(BRAND.color)
      .setTitle('🎫 Ticket aberto')
      .setDescription([
        `Olá <@${interaction.user.id}>! Seu atendimento foi criado com sucesso.`,
        '',
        'Descreva aqui o que aconteceu e, se necessário, envie prints ou outras informações úteis.',
        'Quando tudo estiver resolvido, use **Fechar ticket**.',
      ].join('\n'))
      .setFooter({ text: BRAND.footer })
      .setTimestamp();

    await ticket.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
      components: [closeRow()],
      allowedMentions: { users: [interaction.user.id] },
    });

    await interaction.editReply(`✅ Atendimento criado: <#${ticket.id}>`);
    return true;
  }

  if (interaction.customId === 'ticket:close') {
    const ownerId = interaction.channel?.topic?.startsWith(TICKET_TOPIC_PREFIX)
      ? interaction.channel.topic.slice(TICKET_TOPIC_PREFIX.length)
      : null;

    if (!ownerId) {
      await interaction.reply({ content: 'Este canal não é um ticket gerenciado.', ephemeral: true });
      return true;
    }

    const isOwner = interaction.user.id === ownerId;
    const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      interaction.member.roles.cache.some((role) => STAFF_ROLE_NAMES.includes(role.name));

    if (!isOwner && !isStaff) {
      await interaction.reply({ content: 'Você não tem permissão para fechar este ticket.', ephemeral: true });
      return true;
    }

    await interaction.reply('🔒 Ticket encerrado. Este canal será removido em alguns segundos.');
    setTimeout(() => interaction.channel?.delete(`Ticket fechado por ${interaction.user.tag}`).catch(() => {}), 3000);
    return true;
  }

  return false;
}
