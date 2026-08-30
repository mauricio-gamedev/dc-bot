import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { BRAND } from './blueprint.js';
import { getProfile, mutateProfile } from './communityStore.js';
import {
  ACHIEVEMENT_CHAT_BADGES,
  CHAT_COSMETICS,
  PURCHASABLE_CHAT_TITLES,
  chatCosmeticById,
  chatCosmeticForTitleValue,
  managedChatPrefixes,
  ownedChatCosmetics,
  preferredAutomaticCosmetic,
  profileOwnsChatCosmetic,
} from './cosmeticCatalog.js';

const SYSTEM_CATEGORY = '🔒・STAFF';
const SYSTEM_CHANNEL = '🔐・cosméticos-sistema';
const SYSTEM_MARKER = 'MIOJO_COSMETICS_SYSTEM_V1';
const SYSTEM_TOPIC = 'Painel privado do sistema de distintivos, títulos e cosméticos de chat da MiojoPlays.';
const MAX_NICKNAME_LENGTH = 32;

function ownerOnlyOverwrites(guild) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];

  const me = guild.members.me;
  if (me) {
    overwrites.push({
      id: me.id,
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

function systemPanelEmbed() {
  const badgeLines = ACHIEVEMENT_CHAT_BADGES.map(
    (item) => `${item.symbol} **${item.label}** — ${item.description}`,
  );
  const titleLines = PURCHASABLE_CHAT_TITLES.map(
    (item) => `${item.symbol} **${item.name}** — 🍜 ${item.price.toLocaleString('pt-BR')} • ${item.description}`,
  );

  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('🔐 MiojoPlays • Sistema de Cosméticos')
    .setDescription([
      '**Este canal é o painel privado do sistema.**',
      'Membros compram títulos pela `/loja`, desbloqueiam distintivos por conquistas e escolhem o que aparece no chat com `/distintivo`.',
      '',
      '**🏅 Distintivos por conquista**',
      ...badgeLines,
      '',
      '**🛒 Títulos compráveis**',
      ...titleLines,
      '',
      '**Formato no chat:** `⚡・Nome`',
      'O bot modifica apenas o apelido dentro deste servidor. Ele não altera o nome global da conta.',
      '',
      '⚠️ O Discord não permite que bots alterem o apelido do dono do servidor nem de membros acima do cargo do bot. Nesses casos o cosmético fica salvo e o painel registra a limitação.',
    ].join('\n'))
    .setFooter({ text: `${BRAND.footer} • ${SYSTEM_MARKER}` })
    .setTimestamp();
}

export async function ensureCosmeticSystemPanel(guild) {
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  const category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === SYSTEM_CATEGORY,
  );
  if (!category) return { ok: false, reason: 'missing_staff_category' };

  let channel = guild.channels.cache.find(
    (candidate) => candidate.type === ChannelType.GuildText && candidate.name === SYSTEM_CHANNEL,
  );
  const permissionOverwrites = ownerOnlyOverwrites(guild);

  if (!channel) {
    channel = await guild.channels.create({
      name: SYSTEM_CHANNEL,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: SYSTEM_TOPIC,
      permissionOverwrites,
      reason: 'MiojoPlays private cosmetics system',
    });
  } else {
    const edits = {};
    if (channel.parentId !== category.id) edits.parent = category.id;
    if (channel.topic !== SYSTEM_TOPIC) edits.topic = SYSTEM_TOPIC;
    if (Object.keys(edits).length) {
      await channel.edit({ ...edits, reason: 'MiojoPlays cosmetics system repair' });
    }
    await channel.permissionOverwrites.set(permissionOverwrites, 'MiojoPlays private cosmetics permissions');
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === guild.members.me?.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(SYSTEM_MARKER)),
  );

  const embed = systemPanelEmbed();
  if (existing) await existing.edit({ embeds: [embed] });
  else await channel.send({ embeds: [embed] });

  return { ok: true, channel, created: !existing, updated: Boolean(existing) };
}

function cosmeticsChannel(guild) {
  return guild.channels.cache.find(
    (channel) => channel.name === SYSTEM_CHANNEL && channel.isTextBased(),
  ) ?? null;
}

export async function logCosmeticEvent(guild, { userId, action, detail }) {
  const channel = cosmeticsChannel(guild);
  if (!channel) return false;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(BRAND.color)
      .setTitle(`🎨 ${action}`)
      .setDescription(`<@${userId}> • ${detail}`)
      .setFooter({ text: `${BRAND.footer} • COSMETIC_AUDIT` })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch(() => {});
  return true;
}

function stripManagedPrefix(value) {
  let text = String(value || '').trim();
  let changed = true;
  const prefixes = managedChatPrefixes();
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return text;
}

function truncateCodePoints(value, maxLength) {
  return Array.from(String(value || '')).slice(0, Math.max(0, maxLength)).join('');
}

function fallbackBaseName(member) {
  return stripManagedPrefix(member.user.globalName || member.user.username || 'Membro') || 'Membro';
}

function desiredNickname(member, profile, cosmetic) {
  const prefix = `${cosmetic.symbol}・`;
  const storedBase = profile.chatNicknameCaptured
    ? String(profile.chatNicknameBase || '')
    : String(member.nickname || '');
  const base = stripManagedPrefix(storedBase) || fallbackBaseName(member);
  const maxBaseLength = MAX_NICKNAME_LENGTH - Array.from(prefix).length;
  return `${prefix}${truncateCodePoints(base, maxBaseLength)}`;
}

async function resolveMember(guild, userId) {
  return guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
}

async function captureNicknameBase(guild, userId, member, profile) {
  if (profile.chatNicknameCaptured) return profile;
  return mutateProfile(guild, userId, (data) => {
    data.chatNicknameBase = stripManagedPrefix(member.nickname || '');
    data.chatNicknameCaptured = true;
  }, { immediate: true });
}

async function applyNickname(guild, userId, profile, cosmetic) {
  const member = await resolveMember(guild, userId);
  if (!member) return { ok: false, reason: 'member_unavailable', cosmetic };
  if (!member.manageable) {
    return {
      ok: false,
      reason: member.id === guild.ownerId ? 'guild_owner' : 'role_hierarchy',
      cosmetic,
      nickname: member.displayName,
    };
  }

  let currentProfile = profile;
  const currentNickname = String(member.nickname || '');
  const currentHasManagedPrefix = managedChatPrefixes().some((prefix) => currentNickname.startsWith(prefix));

  if (!currentProfile.chatNicknameCaptured || (!currentHasManagedPrefix && currentNickname !== currentProfile.chatNicknameBase)) {
    currentProfile = await mutateProfile(guild, userId, (data) => {
      data.chatNicknameBase = stripManagedPrefix(member.nickname || '');
      data.chatNicknameCaptured = true;
    }, { immediate: true });
  }

  const desired = desiredNickname(member, currentProfile, cosmetic);
  if (member.nickname === desired) return { ok: true, changed: false, cosmetic, nickname: desired };

  await member.setNickname(desired, `MiojoPlays: cosmético de chat ${cosmetic.label}`);
  return { ok: true, changed: true, cosmetic, nickname: desired };
}

export async function reconcileChatCosmetic(guild, userId, profile = null) {
  const current = profile ?? await getProfile(guild, userId);
  const cosmetic = chatCosmeticById(current.chatCosmetic);
  if (!cosmetic || !profileOwnsChatCosmetic(current, cosmetic)) return { ok: true, active: null };
  return applyNickname(guild, userId, current, cosmetic);
}

export async function equipChatCosmetic(guild, userId, cosmeticId, { source = 'manual' } = {}) {
  const cosmetic = chatCosmeticById(cosmeticId);
  if (!cosmetic) return { ok: false, reason: 'not_found' };

  const profile = await getProfile(guild, userId);
  if (!profileOwnsChatCosmetic(profile, cosmetic)) {
    return { ok: false, reason: 'not_owned', cosmetic, profile };
  }

  const member = await resolveMember(guild, userId);
  if (!member) return { ok: false, reason: 'member_unavailable', cosmetic, profile };
  await captureNicknameBase(guild, userId, member, profile);

  const updated = await mutateProfile(guild, userId, (data) => {
    data.chatCosmetic = cosmetic.id;
    data.chatCosmeticOptOut = false;
  }, { immediate: true });

  const nickname = await applyNickname(guild, userId, updated, cosmetic);
  await logCosmeticEvent(guild, {
    userId,
    action: source === 'auto' ? 'Distintivo equipado automaticamente' : 'Cosmético equipado',
    detail: `${cosmetic.symbol} **${cosmetic.label}**${nickname.ok ? ` → \`${nickname.nickname}\`` : ` • não aplicado no apelido (${nickname.reason})`}`,
  });

  return { ok: true, cosmetic, profile: updated, nickname };
}

export async function clearChatCosmetic(guild, userId) {
  const profile = await getProfile(guild, userId);
  const previous = chatCosmeticById(profile.chatCosmetic);
  const member = await resolveMember(guild, userId);

  let nickname = { ok: true, changed: false };
  if (member && member.manageable) {
    const restore = profile.chatNicknameCaptured ? String(profile.chatNicknameBase || '') : '';
    const currentHasManagedPrefix = managedChatPrefixes().some((prefix) => String(member.nickname || '').startsWith(prefix));
    if (currentHasManagedPrefix || profile.chatNicknameCaptured) {
      const target = restore || null;
      if (member.nickname !== target) {
        await member.setNickname(target, 'MiojoPlays: remover cosmético de chat');
        nickname = { ok: true, changed: true, nickname: target };
      }
    }
  } else if (member) {
    nickname = { ok: false, reason: member.id === guild.ownerId ? 'guild_owner' : 'role_hierarchy' };
  }

  const updated = await mutateProfile(guild, userId, (data) => {
    data.chatCosmetic = '';
    data.chatCosmeticOptOut = true;
    data.chatNicknameBase = '';
    data.chatNicknameCaptured = false;
  }, { immediate: true });

  if (previous) {
    await logCosmeticEvent(guild, {
      userId,
      action: 'Cosmético removido',
      detail: `${previous.symbol} **${previous.label}** deixou de ser o distintivo ativo.`,
    });
  }

  return { ok: true, profile: updated, previous, nickname };
}

export async function autoEquipChatCosmetic(guild, userId, profile = null) {
  const current = profile ?? await getProfile(guild, userId);
  if (current.chatCosmeticOptOut || current.chatCosmetic) {
    return reconcileChatCosmetic(guild, userId, current);
  }

  const cosmetic = preferredAutomaticCosmetic(current);
  if (!cosmetic) return { ok: true, active: null };
  return equipChatCosmetic(guild, userId, cosmetic.id, { source: 'auto' });
}

export async function syncEquippedTitleToChat(guild, userId, titleValue) {
  if (titleValue === 'Sem título') {
    const profile = await getProfile(guild, userId);
    const active = chatCosmeticById(profile.chatCosmetic);
    if (active?.kind === 'title') return clearChatCosmetic(guild, userId);
    return { ok: true, unchanged: true };
  }

  const cosmetic = chatCosmeticForTitleValue(titleValue);
  if (!cosmetic) return { ok: false, reason: 'not_found' };
  return equipChatCosmetic(guild, userId, cosmetic.id, { source: 'title' });
}

export function buildMemberCosmeticsEmbed(profile) {
  const owned = ownedChatCosmetics(profile);
  const active = chatCosmeticById(profile.chatCosmetic);
  const lines = owned.length
    ? owned.map((item) => `${active?.id === item.id ? '✅' : '▫️'} ${item.symbol} **${item.label}** • ${item.kind === 'badge' ? 'distintivo' : 'título'}`)
    : ['Você ainda não desbloqueou nem comprou cosméticos.'];

  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('🏅 Seus distintivos e títulos')
    .setDescription([
      `**Exibido no chat:** ${active ? `${active.symbol} ${active.label}` : profile.chatCosmeticOptOut ? 'Nenhum (desativado)' : 'Nenhum ainda'}`,
      '',
      ...lines,
      '',
      'Use `/distintivo equipar` para escolher um e `/distintivo remover` para voltar ao nome normal.',
    ].join('\n'))
    .setFooter({ text: BRAND.footer })
    .setTimestamp();
}

export function chatCosmeticChoices() {
  return CHAT_COSMETICS.map((item) => ({
    name: `${item.symbol} ${item.label} • ${item.kind === 'badge' ? 'distintivo' : 'título'}`,
    value: item.id,
  }));
}

export function chatCosmeticLabel(profile) {
  const cosmetic = chatCosmeticById(profile?.chatCosmetic);
  return cosmetic ? `${cosmetic.symbol} ${cosmetic.label}` : 'Nenhum';
}
