import { getAllProfiles, getProfile, mutateProfile } from './communityStore.js';
import { characterEmbed, characterLine, CHARACTER, mascotReply as mioReply } from './character.js';
import {
  achievementAnnouncement,
  recordMissionDaily,
  recordMissionMessage,
  recordMissionRep,
  refreshAchievements,
} from './communityV3.js';

const XP_COOLDOWN_MS = 60_000;
const DAILY_COOLDOWN_MS = 24 * 60 * 60_000;
const REP_COOLDOWN_MS = 24 * 60 * 60_000;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function levelFromXp(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}

export function xpForLevel(level) {
  return Math.max(0, level) ** 2 * 100;
}

function progressBar(value, max, size = 12) {
  if (max <= 0) return '▰'.repeat(size);
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}`;
}

function formatWait(ms) {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

async function announceAchievements(message, achievements) {
  if (!achievements.length) return;
  const embed = achievementAnnouncement(message.client, message.author.id, achievements);
  if (!embed) return;
  await message.channel.send({
    content: `<@${message.author.id}>`,
    embeds: [embed],
    allowedMentions: { users: [message.author.id] },
  }).catch(() => {});
}

export async function handleMessageProgress(message) {
  if (!message.guild || message.author.bot || !message.channel?.isTextBased()) return null;
  if (message.channel.name === '🗄️・bot-data') return null;
  if (message.channel.parent?.name === '🔒・STAFF') return null;

  const now = Date.now();
  const previous = await getProfile(message.guild, message.author.id);
  const oldLevel = levelFromXp(previous.xp);
  let gained = 0;

  const profile = await mutateProfile(message.guild, message.author.id, (data) => {
    data.messages += 1;
    if (now - data.lastXpAt >= XP_COOLDOWN_MS) {
      gained = randomInt(12, 22);
      data.xp += gained;
      data.lastXpAt = now;
      data.level = levelFromXp(data.xp);
    }
  });

  // A missão de chat só avança quando a mensagem também passa pelo cooldown de XP.
  // Isso impede completar a missão diária com spam em poucos segundos.
  if (gained > 0) {
    await recordMissionMessage(message.guild, message.author.id);
  }

  const newLevel = levelFromXp(profile.xp);
  if (gained > 0 && newLevel > oldLevel) {
    const bonus = 25 + newLevel * 5;
    await mutateProfile(message.guild, message.author.id, (data) => {
      data.coins += bonus;
      data.level = newLevel;
    }, { immediate: true });

    await message.channel.send({
      content: `<@${message.author.id}>`,
      embeds: [characterEmbed({
        title: `✨ Nível ${newLevel} alcançado!`,
        description: `${characterLine('level')}\n\n🎁 Bônus: **${bonus} MiojoCoins**`,
        color: CHARACTER.palette.success,
      })],
      allowedMentions: { users: [message.author.id] },
    }).catch(() => {});
  }

  const achievementResult = await refreshAchievements(message.guild, message.author.id);
  await announceAchievements(message, achievementResult.unlocked);
  return achievementResult.profile;
}

export async function buildProfileEmbed(guild, user) {
  const { profile } = await refreshAchievements(guild, user.id);
  const all = (await getAllProfiles(guild)).sort((a, b) => b.xp - a.xp);
  const rank = all.findIndex((item) => item.userId === user.id) + 1;
  const level = levelFromXp(profile.xp);
  const currentBase = xpForLevel(level);
  const nextBase = xpForLevel(level + 1);
  const current = profile.xp - currentBase;
  const needed = Math.max(1, nextBase - currentBase);
  const badgeCount = profile.achievements.length;

  return characterEmbed({
    title: `🐈‍⬛ Perfil de ${user.username}`,
    description: [
      `> **Título:** ${profile.title || 'Sem título'}`,
      '',
      `✨ **Nível:** ${level}`,
      `**XP total:** ${profile.xp.toLocaleString('pt-BR')}`,
      `${progressBar(current, needed)}  ${current}/${needed}`,
      '',
      `🍜 **MiojoCoins:** ${profile.coins.toLocaleString('pt-BR')}`,
      `💜 **Reputação:** ${profile.reputation}`,
      `💬 **Mensagens registradas:** ${profile.messages.toLocaleString('pt-BR')}`,
      `🏆 **Ranking XP:** ${rank > 0 ? `#${rank}` : 'sem posição'}`,
      `🔥 **Sequência diária:** ${profile.dailyStreak} dia(s)`,
      `🏅 **Conquistas:** ${badgeCount}`,
      '',
      'Use `/loja`, `/missoes` e `/conquistas` para evoluir o perfil.',
    ].join('\n'),
  }).setAuthor({
    name: 'MiojoPlays • Character Profile',
    iconURL: user.displayAvatarURL({ size: 128 }),
  });
}

export async function claimDaily(guild, userId) {
  const now = Date.now();
  const profile = await getProfile(guild, userId);
  const elapsed = now - profile.lastDailyAt;

  if (profile.lastDailyAt > 0 && elapsed < DAILY_COOLDOWN_MS) {
    return { ok: false, wait: formatWait(DAILY_COOLDOWN_MS - elapsed), profile };
  }

  const streak = profile.lastDailyAt > 0 && elapsed <= 48 * 60 * 60_000
    ? profile.dailyStreak + 1
    : 1;
  const reward = randomInt(180, 300) + Math.min(streak, 30) * 10;

  await mutateProfile(guild, userId, (data) => {
    data.dailyStreak = streak;
    data.lastDailyAt = now;
    data.coins += reward;
  }, { immediate: true });

  await recordMissionDaily(guild, userId);
  const achievements = await refreshAchievements(guild, userId);
  return { ok: true, reward, streak, profile: achievements.profile, unlocked: achievements.unlocked };
}

export async function giveReputation(guild, giverId, targetId) {
  if (giverId === targetId) return { ok: false, reason: 'self' };
  const giver = await getProfile(guild, giverId);
  const now = Date.now();
  const elapsed = now - giver.lastRepGivenAt;

  if (giver.lastRepGivenAt > 0 && elapsed < REP_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', wait: formatWait(REP_COOLDOWN_MS - elapsed) };
  }

  await mutateProfile(guild, giverId, (data) => {
    data.lastRepGivenAt = now;
  }, { immediate: true });

  const target = await mutateProfile(guild, targetId, (data) => {
    data.reputation += 1;
  }, { immediate: true });

  await recordMissionRep(guild, giverId);
  await refreshAchievements(guild, targetId);
  return { ok: true, reputation: target.reputation };
}

export async function buildLeaderboardEmbed(guild, client, type = 'xp') {
  const profiles = await getAllProfiles(guild);
  const key = type === 'coins'
    ? 'coins'
    : type === 'rep'
      ? 'reputation'
      : type === 'achievements'
        ? 'achievements'
        : 'xp';
  const valueOf = (profile) => key === 'achievements' ? profile.achievements.length : profile[key];
  const icon = key === 'coins' ? '🍜' : key === 'reputation' ? '💜' : key === 'achievements' ? '🏅' : '✨';
  const label = key === 'coins' ? 'MiojoCoins' : key === 'reputation' ? 'Reputação' : key === 'achievements' ? 'Conquistas' : 'XP';

  const sorted = profiles
    .filter((profile) => valueOf(profile) > 0)
    .sort((a, b) => valueOf(b) - valueOf(a))
    .slice(0, 10);

  const lines = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const profile = sorted[i];
    const user = await client.users.fetch(profile.userId).catch(() => null);
    const name = user?.username ?? `Usuário ${profile.userId}`;
    lines.push(`**${i + 1}.** ${name} — ${icon} **${valueOf(profile).toLocaleString('pt-BR')}**`);
  }

  return characterEmbed({
    title: `🏆 Ranking • ${label}`,
    description: lines.length ? lines.join('\n') : 'Ainda não há dados suficientes para montar o ranking.',
  });
}

export function mascotReply(text, username) {
  return mioReply(text, username);
}
