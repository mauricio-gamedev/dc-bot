import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { BRAND } from './blueprint.js';
import { characterEmbed, CHARACTER, characterLine } from './character.js';
import { getProfile, mutateProfile } from './communityStore.js';

const SELF_ROLE_MARKER = 'MIOJO_SELF_ROLES_V3';

export const SELF_ROLES = [
  { id: 'games', role: '🎮・Games', emoji: '🎮', label: 'Games' },
  { id: 'lives', role: '🔴・Lives', emoji: '🔴', label: 'Lives' },
  { id: 'events', role: '🎉・Eventos', emoji: '🎉', label: 'Eventos' },
  { id: 'minecraft', role: '⛏️・Minecraft', emoji: '⛏️', label: 'Minecraft' },
];

export const SHOP_ITEMS = [
  { id: 'title_noturno', type: 'title', name: 'Noturno', value: '🌙 Noturno', price: 350, description: 'Título dark para o perfil.' },
  { id: 'title_neon', type: 'title', name: 'Veterano Neon', value: '💜 Veterano Neon', price: 650, description: 'Título de veterano da comunidade.' },
  { id: 'title_guardiao', type: 'title', name: 'Guardião da Base', value: '🐈‍⬛ Guardião da Base', price: 1200, description: 'Título especial inspirado no Mio.' },
  { id: 'title_lendario', type: 'title', name: 'Miojo Lendário', value: '🍜 Miojo Lendário', price: 2500, description: 'Título premium de progressão.' },
];

export const ACHIEVEMENTS = [
  { id: 'first_message', name: 'Primeiro Sinal', emoji: '💬', check: (p) => p.messages >= 1 },
  { id: 'level_5', name: 'Neon I', emoji: '✨', check: (p) => p.level >= 5 },
  { id: 'level_10', name: 'Neon II', emoji: '⚡', check: (p) => p.level >= 10 },
  { id: 'coins_1000', name: 'Cofre Roxo', emoji: '🍜', check: (p) => p.coins >= 1000 },
  { id: 'rep_10', name: 'Respeitado', emoji: '💜', check: (p) => p.reputation >= 10 },
  { id: 'streak_7', name: 'Disciplina', emoji: '🔥', check: (p) => p.dailyStreak >= 7 },
];

const MISSIONS = [
  { id: 'chat_5', name: 'Conversa Ativa', description: 'Registre 5 mensagens válidas hoje.', reward: 120 },
  { id: 'daily', name: 'Ritual Diário', description: 'Colete o /daily de hoje.', reward: 90 },
  { id: 'rep', name: 'Fortaleça a Base', description: 'Dê reputação para outro membro.', reward: 100 },
];

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureMissionDay(data) {
  const today = utcDateKey();
  if (data.missionDate === today) return;
  data.missionDate = today;
  data.missionMessages = 0;
  data.missionDaily = false;
  data.missionRep = false;
  data.missionClaimed = [];
}

export async function recordMissionMessage(guild, userId) {
  return mutateProfile(guild, userId, (data) => {
    ensureMissionDay(data);
    data.missionMessages = Math.min(9999, data.missionMessages + 1);
  });
}

export async function recordMissionDaily(guild, userId) {
  return mutateProfile(guild, userId, (data) => {
    ensureMissionDay(data);
    data.missionDaily = true;
  });
}

export async function recordMissionRep(guild, userId) {
  return mutateProfile(guild, userId, (data) => {
    ensureMissionDay(data);
    data.missionRep = true;
  });
}

export async function refreshAchievements(guild, userId) {
  const current = await getProfile(guild, userId);
  const unlocked = ACHIEVEMENTS.filter(
    (achievement) => !current.achievements.includes(achievement.id) && achievement.check(current),
  );

  if (!unlocked.length) return { profile: current, unlocked: [] };

  const profile = await mutateProfile(guild, userId, (data) => {
    for (const achievement of unlocked) {
      if (data.achievements.includes(achievement.id)) continue;
      data.achievements.push(achievement.id);
      data.coins += 75;
    }
  }, { immediate: true });

  return { profile, unlocked };
}

function missionCompleted(profile, missionId) {
  if (missionId === 'chat_5') return profile.missionMessages >= 5;
  if (missionId === 'daily') return profile.missionDaily;
  if (missionId === 'rep') return profile.missionRep;
  return false;
}

export async function claimMission(guild, userId, missionId) {
  const mission = MISSIONS.find((item) => item.id === missionId);
  if (!mission) return { ok: false, reason: 'not_found' };

  const profile = await getProfile(guild, userId);
  ensureMissionDay(profile);
  if (profile.missionClaimed.includes(missionId)) return { ok: false, reason: 'claimed', mission };
  if (!missionCompleted(profile, missionId)) return { ok: false, reason: 'incomplete', mission };

  const updated = await mutateProfile(guild, userId, (data) => {
    ensureMissionDay(data);
    if (!data.missionClaimed.includes(missionId)) {
      data.missionClaimed.push(missionId);
      data.coins += mission.reward;
    }
  }, { immediate: true });

  return { ok: true, mission, profile: updated };
}

export function buildMissionsEmbed(profile) {
  ensureMissionDay(profile);
  const lines = MISSIONS.map((mission) => {
    const done = missionCompleted(profile, mission.id);
    const claimed = profile.missionClaimed.includes(mission.id);
    const status = claimed ? '✅ Coletada' : done ? '🎁 Pronta' : '⬜ Em progresso';
    const progress = mission.id === 'chat_5' ? ` (${Math.min(profile.missionMessages, 5)}/5)` : '';
    return `**${mission.name}** — ${status}${progress}\n${mission.description} • 🍜 ${mission.reward}`;
  });

  return characterEmbed({
    title: '🎯 Missões do dia',
    description: `${lines.join('\n\n')}\n\nUse \`/missao coletar\` para receber uma missão concluída.`,
  });
}

export function buildAchievementsEmbed(profile) {
  const lines = ACHIEVEMENTS.map((achievement) => {
    const unlocked = profile.achievements.includes(achievement.id);
    return `${unlocked ? achievement.emoji : '🔒'} **${achievement.name}** ${unlocked ? '— desbloqueada' : '— bloqueada'}`;
  });

  return characterEmbed({
    title: '🏅 Conquistas',
    description: lines.join('\n'),
  });
}

export function buildShopEmbed(profile) {
  const lines = SHOP_ITEMS.map((item) => {
    const owned = profile.ownedTitles.includes(item.value);
    return `**${item.name}** — 🍜 **${item.price}**${owned ? ' • ✅ comprado' : ''}\n${item.description}`;
  });

  return characterEmbed({
    title: '🛒 Loja de MiojoCoins',
    description: `Saldo: 🍜 **${profile.coins.toLocaleString('pt-BR')}**\n\n${lines.join('\n\n')}\n\nUse \`/comprar\` para escolher um item.`,
  });
}

export async function buyShopItem(guild, userId, itemId) {
  const item = SHOP_ITEMS.find((candidate) => candidate.id === itemId);
  if (!item) return { ok: false, reason: 'not_found' };

  const profile = await getProfile(guild, userId);
  if (profile.ownedTitles.includes(item.value)) return { ok: false, reason: 'owned', item, profile };
  if (profile.coins < item.price) return { ok: false, reason: 'funds', item, profile };

  const updated = await mutateProfile(guild, userId, (data) => {
    data.coins -= item.price;
    data.ownedTitles.push(item.value);
    if (!data.inventory.includes(item.id)) data.inventory.push(item.id);
  }, { immediate: true });

  return { ok: true, item, profile: updated };
}

export async function equipTitle(guild, userId, title) {
  const profile = await getProfile(guild, userId);
  if (title === 'Sem título') {
    const updated = await mutateProfile(guild, userId, (data) => {
      data.title = 'Sem título';
    }, { immediate: true });
    return { ok: true, profile: updated };
  }

  if (!profile.ownedTitles.includes(title)) return { ok: false, reason: 'not_owned', profile };
  const updated = await mutateProfile(guild, userId, (data) => {
    data.title = title;
  }, { immediate: true });
  return { ok: true, profile: updated };
}

export async function ensureSelfRolePanel(guild, channel) {
  if (!channel?.isTextBased()) return false;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === guild.members.me?.id &&
    message.embeds.some((embed) => embed.footer?.text?.includes(SELF_ROLE_MARKER)),
  );
  if (existing) return false;

  const row = new ActionRowBuilder();
  for (const spec of SELF_ROLES) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`selfrole:${spec.id}`)
        .setLabel(spec.label)
        .setEmoji(spec.emoji)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  await channel.send({
    embeds: [characterEmbed({
      title: '🎭 Escolha seus cargos',
      description: 'Clique nos botões para ativar ou remover cargos de interesse. Você pode trocar quando quiser.',
      footer: `${BRAND.footer} • ${SELF_ROLE_MARKER}`,
    })],
    components: [row],
  });
  return true;
}

export async function handleV3Button(interaction) {
  if (!interaction.isButton() || !interaction.guild) return false;

  if (interaction.customId.startsWith('selfrole:')) {
    const id = interaction.customId.split(':')[1];
    const spec = SELF_ROLES.find((item) => item.id === id);
    if (!spec) return true;

    const role = interaction.guild.roles.cache.find((candidate) => candidate.name === spec.role);
    const member = interaction.member;
    if (!role || !member?.roles) {
      await interaction.reply({ content: 'Cargo ainda não está disponível. Execute `/repair`.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!role.editable) {
      await interaction.reply({ content: 'Meu cargo precisa ficar acima dos cargos de auto-seleção.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const has = member.roles.cache.has(role.id);
    if (has) await member.roles.remove(role, 'Auto-cargo removido pelo membro');
    else await member.roles.add(role, 'Auto-cargo escolhido pelo membro');

    await interaction.reply({
      content: `${has ? '➖ Removido' : '✅ Adicionado'}: **${role.name}**`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId.startsWith('suggestion:status:')) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Somente a staff pode mudar o status.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const status = interaction.customId.split(':')[2];
    const label = status === 'approved'
      ? '✅ Aprovada'
      : status === 'rejected'
        ? '❌ Rejeitada'
        : '🟡 Em análise';

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setFooter({ text: `${BRAND.footer} • ${label}` });
    await interaction.update({ embeds: [embed], components: interaction.message.components });
    return true;
  }

  return false;
}

export async function postSuggestion(interaction, text) {
  const channel = interaction.guild.channels.cache.find(
    (candidate) => candidate.name === '💡・sugestões' && candidate.isTextBased(),
  );
  if (!channel) return { ok: false };

  const embed = characterEmbed({
    title: '💡 Nova sugestão',
    description: `${text}\n\n**Vote usando as reações 👍 ou 👎 abaixo.**`,
    thumbnail: false,
    footer: `${BRAND.footer} • 🟡 Em análise`,
  }).setAuthor({
    name: interaction.user.username,
    iconURL: interaction.user.displayAvatarURL({ size: 128 }),
  });

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('suggestion:status:review').setLabel('Em análise').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('suggestion:status:approved').setLabel('Aprovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('suggestion:status:rejected').setLabel('Rejeitar').setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [staffRow] });
  await sent.react('👍').catch(() => {});
  await sent.react('👎').catch(() => {});
  return { ok: true, channel, message: sent };
}

export const v3CommandBuilders = [
  new SlashCommandBuilder()
    .setName('loja')
    .setDescription('Abre a loja de MiojoCoins.'),

  new SlashCommandBuilder()
    .setName('comprar')
    .setDescription('Compra um item da loja.')
    .addStringOption((option) =>
      option
        .setName('item')
        .setDescription('Escolha um item.')
        .setRequired(true)
        .addChoices(...SHOP_ITEMS.map((item) => ({ name: `${item.name} • ${item.price} coins`, value: item.id }))),
    ),

  new SlashCommandBuilder()
    .setName('titulo')
    .setDescription('Equipa um título comprado.')
    .addStringOption((option) =>
      option
        .setName('equipar')
        .setDescription('Escolha um título.')
        .setRequired(true)
        .addChoices(
          { name: 'Sem título', value: 'Sem título' },
          ...SHOP_ITEMS.filter((item) => item.type === 'title').map((item) => ({ name: item.name, value: item.value })),
        ),
    ),

  new SlashCommandBuilder()
    .setName('missoes')
    .setDescription('Mostra suas missões diárias.'),

  new SlashCommandBuilder()
    .setName('missao')
    .setDescription('Coleta a recompensa de uma missão concluída.')
    .addStringOption((option) =>
      option
        .setName('coletar')
        .setDescription('Escolha a missão.')
        .setRequired(true)
        .addChoices(
          { name: 'Conversa Ativa', value: 'chat_5' },
          { name: 'Ritual Diário', value: 'daily' },
          { name: 'Fortaleça a Base', value: 'rep' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('conquistas')
    .setDescription('Mostra conquistas e badges.')
    .addUserOption((option) => option.setName('membro').setDescription('Membro opcional.')),

  new SlashCommandBuilder()
    .setName('sugerir')
    .setDescription('Envia uma sugestão para votação da comunidade.')
    .addStringOption((option) =>
      option
        .setName('texto')
        .setDescription('Sua sugestão.')
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(1500),
    ),
];

export async function handleV3Command(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;

  if (interaction.commandName === 'loja') {
    const profile = await getProfile(interaction.guild, interaction.user.id);
    await interaction.reply({ embeds: [buildShopEmbed(profile)] });
    return true;
  }

  if (interaction.commandName === 'comprar') {
    const itemId = interaction.options.getString('item', true);
    const result = await buyShopItem(interaction.guild, interaction.user.id, itemId);
    if (!result.ok) {
      const text = result.reason === 'owned'
        ? 'Você já possui esse item.'
        : result.reason === 'funds'
          ? `Saldo insuficiente. Você tem 🍜 **${result.profile.coins}**.`
          : 'Item não encontrado.';
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({ embeds: [characterEmbed({
      title: '🛒 Compra concluída',
      description: `Você comprou **${result.item.name}** por 🍜 **${result.item.price}**.\nSaldo: **${result.profile.coins} MiojoCoins**.`,
      color: CHARACTER.palette.success,
    })] });
    return true;
  }

  if (interaction.commandName === 'titulo') {
    const title = interaction.options.getString('equipar', true);
    const result = await equipTitle(interaction.guild, interaction.user.id, title);
    if (!result.ok) {
      await interaction.reply({ content: 'Você ainda não possui esse título. Veja `/loja`.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({
      content: `✅ Título equipado: **${result.profile.title}**`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.commandName === 'missoes') {
    const profile = await getProfile(interaction.guild, interaction.user.id);
    await interaction.reply({ embeds: [buildMissionsEmbed(profile)] });
    return true;
  }

  if (interaction.commandName === 'missao') {
    const id = interaction.options.getString('coletar', true);
    const result = await claimMission(interaction.guild, interaction.user.id, id);
    if (!result.ok) {
      const text = result.reason === 'claimed'
        ? 'Essa missão já foi coletada hoje.'
        : result.reason === 'incomplete'
          ? 'Essa missão ainda não foi concluída.'
          : 'Missão inválida.';
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.reply({ embeds: [characterEmbed({
      title: '🎁 Missão coletada',
      description: `**${result.mission.name}** concluída.\n🍜 +**${result.mission.reward} MiojoCoins**`,
      color: CHARACTER.palette.success,
    })] });
    return true;
  }

  if (interaction.commandName === 'conquistas') {
    const user = interaction.options.getUser('membro') ?? interaction.user;
    const { profile } = await refreshAchievements(interaction.guild, user.id);
    await interaction.reply({ embeds: [buildAchievementsEmbed(profile)] });
    return true;
  }

  if (interaction.commandName === 'sugerir') {
    const text = interaction.options.getString('texto', true);
    const result = await postSuggestion(interaction, text);
    if (!result.ok) {
      await interaction.reply({
        content: 'Canal `💡・sugestões` não encontrado. Execute `/repair`.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.reply({
      content: `✅ Sugestão publicada em <#${result.channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}

export function achievementAnnouncement(_client, userId, achievements) {
  if (!achievements.length) return null;
  const names = achievements.map((item) => `${item.emoji} **${item.name}**`).join('\n');

  return characterEmbed({
    title: '🏅 Conquista desbloqueada',
    description: `${characterLine('achievement')}\n\n<@${userId}> desbloqueou:\n${names}\n\n🍜 **+75 MiojoCoins por conquista**`,
    color: CHARACTER.palette.success,
  });
}
