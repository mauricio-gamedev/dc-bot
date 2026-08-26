import { EmbedBuilder } from 'discord.js';
import { BRAND } from './blueprint.js';
import { getAllProfiles, getProfile, mutateProfile } from './communityStore.js';

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

function mascotEmbed(client, title, description, color = BRAND.color) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${BRAND.footer} • 🐈‍⬛ Miojo System` })
    .setTimestamp();

  const avatar = client.user?.displayAvatarURL({ size: 256 });
  if (avatar) embed.setThumbnail(avatar);
  return embed;
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

  const newLevel = levelFromXp(profile.xp);
  if (gained > 0 && newLevel > oldLevel) {
    const bonus = 25 + newLevel * 5;
    await mutateProfile(message.guild, message.author.id, (data) => {
      data.coins += bonus;
      data.level = newLevel;
    }, { immediate: true });

    const lines = [
      'As luzes roxas acenderam. Mais um nível desbloqueado. 😼',
      'O gato preto aprovou essa evolução. Continua assim. 🐈‍⬛',
      'Subiu de nível sem precisar farmar missão impossível. Aí sim. ⚡',
      'Mais presença na comunidade, mais nível. Tá ficando forte. 💜',
    ];

    await message.channel.send({
      content: `<@${message.author.id}>`,
      embeds: [mascotEmbed(
        message.client,
        `✨ Nível ${newLevel} alcançado!`,
        `${lines[randomInt(0, lines.length - 1)]}\n\n🎁 Bônus: **${bonus} MiojoCoins**`,
        BRAND.success,
      )],
      allowedMentions: { users: [message.author.id] },
    }).catch(() => {});
  }

  return profile;
}

export async function buildProfileEmbed(guild, user, client) {
  const profile = await getProfile(guild, user.id);
  const all = (await getAllProfiles(guild)).sort((a, b) => b.xp - a.xp);
  const rank = all.findIndex((item) => item.userId === user.id) + 1;
  const level = levelFromXp(profile.xp);
  const currentBase = xpForLevel(level);
  const nextBase = xpForLevel(level + 1);
  const current = profile.xp - currentBase;
  const needed = Math.max(1, nextBase - currentBase);

  return mascotEmbed(
    client,
    `🐈‍⬛ Perfil de ${user.username}`,
    [
      `**Nível:** ${level}`,
      `**XP:** ${profile.xp.toLocaleString('pt-BR')}`,
      `${progressBar(current, needed)}  ${current}/${needed}`,
      '',
      `🍜 **MiojoCoins:** ${profile.coins.toLocaleString('pt-BR')}`,
      `💜 **Reputação:** ${profile.reputation}`,
      `💬 **Mensagens registradas:** ${profile.messages.toLocaleString('pt-BR')}`,
      `🏆 **Ranking XP:** ${rank > 0 ? `#${rank}` : 'sem posição'}`,
      `🔥 **Sequência diária:** ${profile.dailyStreak} dia(s)`,
    ].join('\n'),
  ).setAuthor({
    name: BRAND.name,
    iconURL: client.user?.displayAvatarURL({ size: 128 }),
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

  const updated = await mutateProfile(guild, userId, (data) => {
    data.dailyStreak = streak;
    data.lastDailyAt = now;
    data.coins += reward;
  }, { immediate: true });

  return { ok: true, reward, streak, profile: updated };
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

  return { ok: true, reputation: target.reputation };
}

export async function buildLeaderboardEmbed(guild, client, type = 'xp') {
  const profiles = await getAllProfiles(guild);
  const key = type === 'coins' ? 'coins' : type === 'rep' ? 'reputation' : 'xp';
  const icon = key === 'coins' ? '🍜' : key === 'reputation' ? '💜' : '✨';
  const label = key === 'coins' ? 'MiojoCoins' : key === 'reputation' ? 'Reputação' : 'XP';

  const sorted = profiles
    .filter((profile) => profile[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, 10);

  const lines = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const profile = sorted[i];
    const user = await client.users.fetch(profile.userId).catch(() => null);
    const name = user?.username ?? `Usuário ${profile.userId}`;
    lines.push(`**${i + 1}.** ${name} — ${icon} **${profile[key].toLocaleString('pt-BR')}**`);
  }

  return mascotEmbed(
    client,
    `🏆 Ranking • ${label}`,
    lines.length ? lines.join('\n') : 'Ainda não há dados suficientes para montar o ranking.',
  );
}

export function mascotReply(text, username) {
  const input = String(text || '').trim().toLowerCase();

  if (!input) {
    return `🐈‍⬛ E aí, **${username}**. Tô de olho na comunidade. Usa \`/perfil\`, \`/daily\` ou \`/ranking\` pra começar.`;
  }
  if (/(oi|olá|ola|salve|eae|e aí)/i.test(input)) {
    return `🐈‍⬛ Salve, **${username}**. Chegou na área certa. 💜`;
  }
  if (/(live|kick|stream)/i.test(input)) {
    return '🔴 Quando a live estiver rolando, a comunidade vira base de operação. Clips, resenha e caos controlado.';
  }
  if (/(vip|sub)/i.test(input)) {
    return '💎 VIP e Sub são os cargos especiais da comunidade. Quanto mais o sistema evoluir, mais benefícios a gente consegue automatizar.';
  }
  if (/(nível|nivel|xp|rank)/i.test(input)) {
    return '✨ Conversa de verdade gera XP. Spam não: existe cooldown justamente pra manter o ranking justo.';
  }
  if (/(moeda|coin|dinheiro|daily)/i.test(input)) {
    return '🍜 MiojoCoins vêm do daily, bônus de nível e futuras atividades. Guarda porque a lojinha vem depois.';
  }
  if (/(motiv|desanim|cansad)/i.test(input)) {
    return '🐈‍⬛ Um passo bem feito vale mais que dez feitos no automático. Continua construindo.';
  }

  const replies = [
    `🐈‍⬛ Entendi, **${username}**. Ainda tô evoluindo, mas já anotei essa energia.`,
    '💜 A comunidade tá só começando. Cada expansão vai deixar esse bot menos “ferramenta” e mais personagem.',
    '😼 Isso tem cara de coisa que vai virar feature numa atualização futura.',
    '⚡ Tô online, de olho no servidor e acumulando ideias.',
  ];
  return replies[randomInt(0, replies.length - 1)];
}
