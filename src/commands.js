import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { BRAND } from './core/blueprint.js';
import { buildGuild, formatSetupReport, inspectGuild } from './core/guildBuilder.js';
import {
  buildLeaderboardEmbed,
  buildProfileEmbed,
  claimDaily,
  giveReputation,
  mascotReply,
} from './core/progression.js';
import { logModerationAction } from './core/logging.js';
import { characterEmbed, CHARACTER } from './core/character.js';
import {
  achievementAnnouncement,
  handleV3Command,
  refreshAchievements,
  v3CommandBuilders,
} from './core/communityV3.js';

const baseCommandBuilders = [
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
    .setName('perfil')
    .setDescription('Mostra nível, XP, MiojoCoins, reputação, título e conquistas.')
    .addUserOption((option) => option.setName('membro').setDescription('Perfil de outro membro (opcional).')),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Coleta sua recompensa diária de MiojoCoins.'),

  new SlashCommandBuilder()
    .setName('rep')
    .setDescription('Dá um ponto de reputação para outro membro.')
    .addUserOption((option) => option.setName('membro').setDescription('Membro que receberá reputação.').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Mostra os melhores membros da comunidade.')
    .addStringOption((option) =>
      option
        .setName('tipo')
        .setDescription('Escolha o ranking.')
        .addChoices(
          { name: 'XP', value: 'xp' },
          { name: 'MiojoCoins', value: 'coins' },
          { name: 'Reputação', value: 'rep' },
          { name: 'Conquistas', value: 'achievements' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('mascote')
    .setDescription('Conversa com Mio, o personagem oficial da MiojoPlays.')
    .addStringOption((option) => option.setName('mensagem').setDescription('Fala algo para o Mio.').setMaxLength(300)),

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
    .addStringOption((option) => option.setName('texto').setDescription('Conteúdo do anúncio.').setRequired(true).setMaxLength(3500))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

export const commandBuilders = [...baseCommandBuilders, ...v3CommandBuilders];
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
    await interaction.reply({ content: 'Você precisa ser administrador para usar esta ação.', flags: MessageFlags.Ephemeral });
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const deleted = await interaction.channel.bulkDelete(amount, true);
    await interaction.editReply(`🧹 Foram removidas **${deleted.size}** mensagens recentes.`);
    await logModerationAction(interaction, 'Limpeza de chat', `<#${interaction.channel.id}>`, `${deleted.size} mensagens removidas`);
    return true;
  }

  if (interaction.commandName === 'timeout') {
    const member = interaction.options.getMember('membro');
    const minutes = interaction.options.getInteger('minutos', true);
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';
    if (!member?.moderatable) {
      await interaction.reply({ content: 'Não consigo aplicar timeout nesse membro. Verifique a hierarquia de cargos.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await member.timeout(minutes * 60_000, `${reason} | por ${interaction.user.tag}`);
    await interaction.reply({ content: `⏱️ ${member} recebeu timeout de **${minutes} min**. Motivo: ${reason}`, flags: MessageFlags.Ephemeral });
    await logModerationAction(interaction, `Timeout ${minutes}min`, `${member.user.tag} (${member.id})`, reason);
    return true;
  }

  if (interaction.commandName === 'kick') {
    const member = interaction.options.getMember('membro');
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';
    if (!member?.kickable) {
      await interaction.reply({ content: 'Não consigo expulsar esse membro. Verifique a hierarquia de cargos.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const target = `${member.user.tag} (${member.id})`;
    await member.kick(`${reason} | por ${interaction.user.tag}`);
    await interaction.reply({ content: `👢 **${member.user.tag}** foi expulso. Motivo: ${reason}`, flags: MessageFlags.Ephemeral });
    await logModerationAction(interaction, 'Kick', target, reason);
    return true;
  }

  if (interaction.commandName === 'ban') {
    const user = interaction.options.getUser('membro', true);
    const reason = interaction.options.getString('motivo') ?? 'Sem motivo informado';
    const member = interaction.options.getMember('membro');
    if (member && !member.bannable) {
      await interaction.reply({ content: 'Não consigo banir esse membro. Verifique a hierarquia de cargos.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.guild.members.ban(user.id, { reason: `${reason} | por ${interaction.user.tag}` });
    await interaction.reply({ content: `🔨 **${user.tag}** foi banido. Motivo: ${reason}`, flags: MessageFlags.Ephemeral });
    await logModerationAction(interaction, 'Ban', `${user.tag} (${user.id})`, reason);
    return true;
  }

  return false;
}

async function handleCommunityCommands(interaction) {
  if (interaction.commandName === 'perfil') {
    const user = interaction.options.getUser('membro') ?? interaction.user;
    const embed = await buildProfileEmbed(interaction.guild, user);
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === 'daily') {
    const result = await claimDaily(interaction.guild, interaction.user.id);
    if (!result.ok) {
      await interaction.reply({
        embeds: [resultEmbed('⏳ Daily ainda em cooldown', `Volta em aproximadamente **${result.wait}** para coletar novamente.`, BRAND.warning)],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.reply({
      embeds: [characterEmbed({
        title: '🍜 Daily coletado!',
        description: `${CHARACTER.name}: ${interaction.user}, recompensa liberada.\n\nVocê recebeu **${result.reward} MiojoCoins**.\n🔥 Sequência atual: **${result.streak} dia(s)**.`,
        color: CHARACTER.palette.success,
      })],
    });

    if (result.unlocked?.length) {
      const achievement = achievementAnnouncement(interaction.client, interaction.user.id, result.unlocked);
      if (achievement) await interaction.followUp({ embeds: [achievement] }).catch(() => {});
    }
    return true;
  }

  if (interaction.commandName === 'rep') {
    const target = interaction.options.getUser('membro', true);
    if (target.bot) {
      await interaction.reply({ content: 'Bots não entram no sistema de reputação.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const result = await giveReputation(interaction.guild, interaction.user.id, target.id);
    if (!result.ok && result.reason === 'self') {
      await interaction.reply({ content: 'Você não pode dar reputação para si mesmo 😼.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!result.ok) {
      await interaction.reply({ content: `Você poderá dar reputação novamente em **${result.wait}**.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.reply({
      content: `💜 <@${interaction.user.id}> deu **+1 reputação** para <@${target.id}>. Agora ele(a) tem **${result.reputation}**.`,
      allowedMentions: { users: [interaction.user.id, target.id] },
    });
    return true;
  }

  if (interaction.commandName === 'ranking') {
    const type = interaction.options.getString('tipo') ?? 'xp';
    const embed = await buildLeaderboardEmbed(interaction.guild, interaction.client, type);
    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (interaction.commandName === 'mascote') {
    const text = interaction.options.getString('mensagem') ?? '';
    await interaction.reply({
      embeds: [characterEmbed({
        title: `${CHARACTER.name} • ${CHARACTER.title}`,
        description: mascotReply(text, interaction.user.username),
        presentation: 'hero',
        seal: 'animated',
      })],
    });
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
        '• cargos, categorias, canais e permissões;',
        '• áreas privadas de Staff/VIP;',
        '• regras, tickets e mensagens iniciais;',
        '• logs e AutoMod nativo;',
        '• XP, níveis, MiojoCoins e reputação;',
        '• Mio, personagem oficial da comunidade;',
        '• loja, títulos, missões, conquistas e auto-cargos;',
        '• sugestões com votação e status da staff.',
        '',
        '**O processo é idempotente:** executar novamente não cria cópias dos itens gerenciados.',
      ].join('\n'),
    );
    await interaction.reply({ embeds: [embed], components: [setupConfirmationRow()], flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.commandName === 'repair') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    const status = await inspectGuild(interaction.guild);
    const description = status.healthy
      ? '🟢 Estrutura, canais, AutoMod e sistemas principais estão íntegros.'
      : [
          '🟠 Foram encontradas diferenças na estrutura.',
          '',
          status.missingRoles.length ? `**Cargos faltando:** ${status.missingRoles.join(', ')}` : null,
          status.missingCategories.length ? `**Categorias faltando:** ${status.missingCategories.join(', ')}` : null,
          status.missingChannels.length ? `**Canais faltando:** ${status.missingChannels.join(', ')}` : null,
          status.missingAutoMod?.length ? `**AutoMod faltando:** ${status.missingAutoMod.join(', ')}` : null,
          '',
          'Execute `/repair` para corrigir automaticamente.',
        ].filter(Boolean).join('\n');
    await interaction.reply({
      embeds: [resultEmbed('📊 Status da comunidade', description, status.healthy ? BRAND.success : BRAND.warning)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.commandName === 'anuncio') {
    const text = interaction.options.getString('texto', true);
    const channel = interaction.guild.channels.cache.find((candidate) => candidate.name === '📢・anúncios' && candidate.isTextBased());
    if (!channel) {
      await interaction.reply({ content: 'Canal de anúncios não encontrado. Execute `/repair` primeiro.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const embed = characterEmbed({
      title: '📢 Comunicado oficial',
      description: text,
      presentation: 'compact',
      seal: 'static',
      footer: `${BRAND.footer} • publicado por ${interaction.user.username}`,
    });
    await channel.send({ embeds: [embed] });
    await interaction.reply({ content: `✅ Anúncio publicado em <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (await handleCommunityCommands(interaction)) return true;
  if (await handleV3Command(interaction)) return true;
  if (await handleModeration(interaction)) return true;
  return false;
}