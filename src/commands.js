import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { BRAND } from './core/blueprint.js';
import { buildGuild, formatSetupReport, inspectGuild } from './core/guildBuilder.js';

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Monta a estrutura profissional completa do servidor.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('repair')
    .setDescription('Verifica e repara a estrutura sem duplicar canais ou cargos.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra a integridade da estrutura gerenciada pelo bot.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('limpar')
    .setDescription('Remove mensagens recentes do canal atual.')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantidade de mensagens para apagar (1 a 100).')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Aplica timeout temporário a um membro.')
    .addUserOption((option) => option.setName('membro').setDescription('Membro alvo.').setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName('minutos')
        .setDescription('Duração em minutos (1 a 40320).')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320),
    )
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo do timeout.').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Expulsa um membro do servidor.')
    .addUserOption((option) => option.setName('membro').setDescription('Membro alvo.').setRequired(true))
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo da expulsão.').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bane um membro do servidor.')
    .addUserOption((option) => option.setName('membro').setDescription('Membro alvo.').setRequired(true))
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo do banimento.').setMaxLength(300))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('anuncio')
    .setDescription('Publica um anúncio profissional no canal oficial.')
    .addStringOption((option) =>
      option.setName('texto').setDescription('Conteúdo do anúncio.').setRequired(true).setMaxLength(3500),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

export const commandData = commandBuilders.map((command) => command.toJSON());

function setupConfirmationRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:confirm')
      .setLabel('Montar servidor')
      .setEmoji('🏗️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('setup:cancel')
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );
}

function resultEmbed(title, description, color = BRAND.color) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}

export async function handleSetupButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('setup:')) return false;

  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Você precisa ser administrador para usar esta ação.', ephemeral: true });
    return true;
  }

  if (interaction.customId === 'setup:cancel') {
    await interaction.update({ content: 'Configuração cancelada.', embeds: [], components: [] });
    return true;
  }

  await interaction.update({
    content: '⏳ Montando a estrutura profissional. Isso pode levar alguns segundos...',
    embeds: [],
    components: [],
  });

  try {
    const report = await buildGuild(interaction.guild);
    await interaction.editReply({
      content: '',
      embeds: [resultEmbed('✅ Setup concluído', formatSetupReport(report), BRAND.success)],
      components: [],
    });
  } catch (error) {
    await interaction.editReply({
      content: '',
      embeds: [resultEmbed('❌ Falha no setup', error.message, BRAND.danger)],
      components: [],
    });
  }

  return true;
}

async function handleModeration(interaction) {
  if (interaction.commandName === 'limpar') {
    const amount = interaction.options.getInteger('quantidade', true);
    await interaction.deferReply({ ephemeral: true });
    const deleted = await interaction.channel.bulkDelete(amount, true);
    await interaction.editReply(`🧹 Foram removidas **${deleted.size}** mensagens recentes.`);
    return true;
  }

  if (interaction.commandName === 'timeout') {
    const member = interaction.options.getMember('membro');
    const minutes = interaction.options.getInteger('minutos', true);
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';

    if (!member?.moderatable) {
      await interaction.reply({ content: 'Não consigo aplicar timeout nesse membro. Verifique a hierarquia de cargos.', ephemeral: true });
      return true;
    }

    await member.timeout(minutes * 60_000, `${reason} | por ${interaction.user.tag}`);
    await interaction.reply({ content: `⏱️ ${member} recebeu timeout de **${minutes} min**. Motivo: ${reason}`, ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'kick') {
    const member = interaction.options.getMember('membro');
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';

    if (!member?.kickable) {
      await interaction.reply({ content: 'Não consigo expulsar esse membro. Verifique a hierarquia de cargos.', ephemeral: true });
      return true;
    }

    await member.kick(`${reason} | por ${interaction.user.tag}`);
    await interaction.reply({ content: `👢 **${member.user.tag}** foi expulso. Motivo: ${reason}`, ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'ban') {
    const user = interaction.options.getUser('membro', true);
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';
    const member = interaction.options.getMember('membro');

    if (member && !member.bannable) {
      await interaction.reply({ content: 'Não consigo banir esse membro. Verifique a hierarquia de cargos.', ephemeral: true });
      return true;
    }

    await interaction.guild.members.ban(user.id, { reason: `${reason} | por ${interaction.user.tag}` });
    await interaction.reply({ content: `🔨 **${user.tag}** foi banido. Motivo: ${reason}`, ephemeral: true });
    return true;
  }

  return false;
}

export async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;

  if (interaction.commandName === 'setup') {
    const embed = resultEmbed(
      '🏗️ Setup profissional',
      [
        'O bot vai montar e padronizar a comunidade inteira:',
        '',
        '• cargos e hierarquia;',
        '• categorias e canais;',
        '• permissões privadas de Staff/VIP;',
        '• regras e mensagens iniciais;',
        '• sistema de tickets;',
        '• configurações básicas de segurança do servidor.',
        '',
        '**O processo é idempotente:** executar novamente não cria cópias dos canais e cargos gerenciados.',
      ].join('\n'),
    );

    await interaction.reply({ embeds: [embed], components: [setupConfirmationRow()], ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'repair') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const report = await buildGuild(interaction.guild, { repairOnly: true });
      await interaction.editReply({ embeds: [resultEmbed('🛠️ Reparo concluído', formatSetupReport(report), BRAND.success)] });
    } catch (error) {
      await interaction.editReply({ embeds: [resultEmbed('❌ Falha no reparo', error.message, BRAND.danger)] });
    }
    return true;
  }

  if (interaction.commandName === 'status') {
    await interaction.guild.roles.fetch();
    await interaction.guild.channels.fetch();
    const status = inspectGuild(interaction.guild);

    const description = status.healthy
      ? '🟢 A estrutura principal está íntegra. Nenhum cargo, categoria ou canal gerenciado está faltando.'
      : [
          '🟠 Foram encontradas diferenças na estrutura.',
          '',
          status.missingRoles.length ? `**Cargos faltando:** ${status.missingRoles.join(', ')}` : null,
          status.missingCategories.length ? `**Categorias faltando:** ${status.missingCategories.join(', ')}` : null,
          status.missingChannels.length ? `**Canais faltando:** ${status.missingChannels.join(', ')}` : null,
          '',
          'Execute `/repair` para corrigir automaticamente.',
        ].filter(Boolean).join('\n');

    await interaction.reply({
      embeds: [resultEmbed('📊 Status da comunidade', description, status.healthy ? BRAND.success : BRAND.warning)],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.commandName === 'anuncio') {
    const text = interaction.options.getString('texto', true);
    const channel = interaction.guild.channels.cache.find((candidate) => candidate.name === '📢・anúncios' && candidate.isTextBased());

    if (!channel) {
      await interaction.reply({ content: 'Canal de anúncios não encontrado. Execute `/repair` primeiro.', ephemeral: true });
      return true;
    }

    const embed = new EmbedBuilder()
      .setColor(BRAND.color)
      .setTitle('📢 Comunicado oficial')
      .setDescription(text)
      .setFooter({ text: `${BRAND.footer} • publicado por ${interaction.user.username}` })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    await interaction.reply({ content: `✅ Anúncio publicado em <#${channel.id}>.`, ephemeral: true });
    return true;
  }

  if (await handleModeration(interaction)) return true;
  return false;
}
