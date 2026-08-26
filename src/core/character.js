import { EmbedBuilder } from 'discord.js';
import { BRAND } from './blueprint.js';

export const CHARACTER = {
  name: 'Mio',
  title: 'Guardião da MiojoPlays',
  species: 'gato dark neon',
  palette: {
    primary: 0x7c3aed,
    secondary: 0x111827,
    accent: 0xa855f7,
    success: 0x22c55e,
    warning: 0xf59e0b,
  },
  personality: {
    tone: 'maduro, dark, carismático e levemente sarcástico',
    values: ['comunidade', 'evolução', 'respeito', 'resenha', 'segurança'],
  },
};

function validHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function characterAssets() {
  const avatar = validHttpUrl(process.env.MIO_CHARACTER_IMAGE_URL);
  const banner = validHttpUrl(process.env.MIO_CHARACTER_BANNER_URL);
  const profile = validHttpUrl(process.env.MIO_CHARACTER_PROFILE_URL) ?? banner;
  return { avatar, banner, profile };
}

export function characterEmbed({
  title,
  description,
  color = CHARACTER.palette.primary,
  image = null,
  thumbnail = true,
  footer = `${CHARACTER.name} • ${CHARACTER.title}`,
}) {
  const assets = characterAssets();
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: footer })
    .setTimestamp();

  if (thumbnail && assets.avatar) embed.setThumbnail(assets.avatar);
  const visual = validHttpUrl(image) ?? assets.profile ?? assets.banner;
  if (visual) embed.setImage(visual);
  return embed;
}

export function characterLine(kind, username = '') {
  const lines = {
    welcome: [
      `🐈‍⬛ Chegou na toca, **${username}**. Agora faz parte da MiojoPlays.`,
      `💜 Mais um nome na comunidade. Bem-vindo, **${username}**.`,
      `⚡ **${username}**, entrada liberada. Aproveita a resenha e respeita a base.`,
    ],
    level: [
      'As luzes roxas acenderam. Novo nível desbloqueado. 😼',
      'O progresso apareceu no radar. Continua assim. 🐈‍⬛',
      'Mais presença, mais nível. Sem spam, só evolução. ⚡',
      'A comunidade reconheceu teu progresso. 💜',
    ],
    daily: [
      'Recompensa diária liberada. Guarda essas MiojoCoins. 🍜',
      'Daily coletado. O cofre aumentou um pouco. 😼',
      'Mais um dia de sequência. Disciplina também dá loot. ⚡',
    ],
    achievement: [
      'Conquista desbloqueada. O arquivo foi atualizado. 🏅',
      'Novo marco registrado na comunidade. 🐈‍⬛',
      'Isso merece badge. Conquista liberada. ✨',
    ],
  };
  const pool = lines[kind] ?? lines.level;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function mascotReply(text, username) {
  const input = String(text || '').trim().toLowerCase();
  if (!input) {
    return `🐈‍⬛ E aí, **${username}**. Eu sou **${CHARACTER.name}**, guardião da MiojoPlays. Usa \`/perfil\`, \`/daily\`, \`/loja\` ou \`/missoes\`.`;
  }
  if (/(oi|olá|ola|salve|eae|e aí)/i.test(input)) {
    return `🐈‍⬛ Salve, **${username}**. Chegou na área certa. 💜`;
  }
  if (/(live|kick|stream)/i.test(input)) {
    return '🔴 Quando a live acende, eu considero isso modo operação: clips, resenha e caos controlado.';
  }
  if (/(vip|sub)/i.test(input)) {
    return '💎 VIP e Sub são os cargos especiais da base. As próximas integrações vão automatizar cada vez mais benefício.';
  }
  if (/(nível|nivel|xp|rank)/i.test(input)) {
    return '✨ Participação real gera XP. Spam não passa pelo radar; existe cooldown pra manter o ranking justo.';
  }
  if (/(moeda|coin|dinheiro|daily|loja)/i.test(input)) {
    return '🍜 MiojoCoins vêm de daily, nível, missões e conquistas. Na loja elas viram títulos e itens cosméticos.';
  }
  if (/(missão|missao|conquista|badge)/i.test(input)) {
    return '🏅 Missões dão direção; conquistas registram os marcos. Faz os dois e teu perfil começa a contar uma história.';
  }
  if (/(motiv|desanim|cansad)/i.test(input)) {
    return '🐈‍⬛ Um passo bem feito vale mais que dez no automático. Continua construindo.';
  }

  const replies = [
    `🐈‍⬛ Entendi, **${username}**. Ainda tô evoluindo, mas essa ideia entrou no radar.`,
    '💜 A base tá crescendo. Cada expansão me deixa menos “bot” e mais personagem da comunidade.',
    '😼 Isso tem cara de coisa que vai virar feature.',
    '⚡ Tô online, de olho no servidor e acumulando ideias.',
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

export function characterVisualStatus() {
  const assets = characterAssets();
  return {
    ready: Boolean(assets.avatar || assets.profile || assets.banner),
    assets,
    fallback: `${BRAND.name} usa apenas identidade textual até um asset oficial ser configurado.`,
  };
}
