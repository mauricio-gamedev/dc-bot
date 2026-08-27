import { EmbedBuilder } from 'discord.js';
import { BRAND } from './blueprint.js';

const OFFICIAL_ASSET_BASE = 'https://dc-bot-us5v.onrender.com/assets';
const ASSET_VERSIONS = Object.freeze({
  character: 'a11b18ed09704b11de301704edb572c778b58df9',
  badgeStatic: '6c10d3f430be1fb31b1862521b56b9b69d80a81d',
  badgeAnimated: 'ba455cc4ce01c13fe490e7d80872e75ebdf6d31f',
});

function officialAsset(filename, version) {
  return `${OFFICIAL_ASSET_BASE}/${filename}?v=${version}`;
}

const DEFAULT_CHARACTER_ASSET = officialAsset('mio-character.webp', ASSET_VERSIONS.character);
const DEFAULT_BADGE_STATIC = officialAsset('miojo-seal-static.png', ASSET_VERSIONS.badgeStatic);
const DEFAULT_BADGE_ANIMATED = officialAsset('miojo-seal-animated.gif', ASSET_VERSIONS.badgeAnimated);

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
    live: 0x53fc18,
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
  const avatar = validHttpUrl(process.env.MIO_CHARACTER_IMAGE_URL) ?? DEFAULT_CHARACTER_ASSET;
  const banner = validHttpUrl(process.env.MIO_CHARACTER_BANNER_URL);
  const profile = validHttpUrl(process.env.MIO_CHARACTER_PROFILE_URL) ?? banner ?? avatar;
  const badge = validHttpUrl(process.env.MIO_BADGE_IMAGE_URL) ?? DEFAULT_BADGE_STATIC;
  const animatedBadge = validHttpUrl(process.env.MIO_BADGE_ANIMATED_URL) ?? DEFAULT_BADGE_ANIMATED;
  return { avatar, banner, profile, badge, animatedBadge };
}

function sealAsset(assets, mode = 'auto') {
  if (mode === 'none') return null;
  if (mode === 'static') return assets.badge;
  if (mode === 'animated') return assets.animatedBadge ?? assets.badge;
  return assets.animatedBadge ?? assets.badge;
}

export function characterEmbed({
  title,
  description,
  color = CHARACTER.palette.primary,
  image = null,
  presentation = 'compact',
  seal = 'auto',
  thumbnail = true,
  footer = `${CHARACTER.name} • ${CHARACTER.title}`,
}) {
  const assets = characterAssets();
  const explicitImage = validHttpUrl(image);
  const selectedSeal = sealAsset(assets, seal);
  const footerData = { text: footer };

  // Footer usa sempre o fallback estático: funciona mesmo em superfícies/clientes sem animação.
  if (assets.badge) footerData.iconURL = assets.badge;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter(footerData)
    .setTimestamp();

  if (presentation === 'hero') {
    // Hero é reservado para momentos em que a presença visual do Mio merece ocupar mais espaço.
    if (thumbnail && selectedSeal) embed.setThumbnail(selectedSeal);
    const visual = explicitImage ?? assets.profile ?? assets.avatar;
    if (visual) embed.setImage(visual);
    return embed;
  }

  if (presentation === 'badge') {
    // Badge prioriza o selo e aceita uma imagem explícita (ex.: thumbnail real de live/evento).
    if (thumbnail && selectedSeal) embed.setThumbnail(selectedSeal);
    if (explicitImage) embed.setImage(explicitImage);
    return embed;
  }

  // Compact é o padrão para perfil, daily, ranking, loja, missões e conquistas.
  // Mantém o Mio visível sem repetir uma imagem hero gigante em todo comando.
  if (thumbnail && assets.avatar) embed.setThumbnail(assets.avatar);
  if (explicitImage) embed.setImage(explicitImage);
  return embed;
}

export function characterLine(kind, username = '') {
  const lines = {
    welcome: [
      `Chegou na toca, **${username}**. Agora faz parte da MiojoPlays.`,
      `Mais um nome na comunidade. Bem-vindo, **${username}**.`,
      `**${username}**, entrada liberada. Aproveita a resenha e respeita a base.`,
    ],
    level: [
      'As luzes roxas acenderam. Novo nível desbloqueado.',
      'O progresso apareceu no radar. Continua assim.',
      'Mais presença, mais nível. Sem spam, só evolução.',
      'A comunidade reconheceu teu progresso.',
    ],
    daily: [
      'Recompensa diária liberada. Guarda essas MiojoCoins.',
      'Daily coletado. O cofre aumentou um pouco.',
      'Mais um dia de sequência. Disciplina também dá loot.',
    ],
    achievement: [
      'Conquista desbloqueada. O arquivo foi atualizado.',
      'Novo marco registrado na comunidade.',
      'Isso merece badge. Conquista liberada.',
    ],
    live: [
      'Modo live ativado. A base está online.',
      'As luzes verdes acenderam. MiojoPlays está ao vivo.',
      'Live detectada. Hora de juntar a comunidade.',
    ],
  };
  const pool = lines[kind] ?? lines.level;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function mascotReply(text, username) {
  const input = String(text || '').trim().toLowerCase();
  if (!input) {
    return `E aí, **${username}**. Eu sou **${CHARACTER.name}**, guardião da MiojoPlays. Usa \`/perfil\`, \`/daily\`, \`/loja\` ou \`/missoes\`.`;
  }
  if (/(oi|olá|ola|salve|eae|e aí)/i.test(input)) return `Salve, **${username}**. Chegou na área certa.`;
  if (/(live|kick|stream)/i.test(input)) return 'Quando a live acende, eu considero isso modo operação: clips, resenha e caos controlado.';
  if (/(vip|sub)/i.test(input)) return 'VIP e Sub são os cargos especiais da base. A camada de apoiadores vai ganhar benefícios e selos próprios.';
  if (/(nível|nivel|xp|rank)/i.test(input)) return 'Participação real gera XP. Spam não passa pelo radar; existe cooldown pra manter o ranking justo.';
  if (/(moeda|coin|dinheiro|daily|loja)/i.test(input)) return 'MiojoCoins vêm de daily, nível, missões e conquistas. Na loja elas viram títulos e itens cosméticos.';
  if (/(missão|missao|conquista|badge|selo)/i.test(input)) return 'Missões dão direção; conquistas registram marcos; selos mostram identidade e status visual.';
  if (/(motiv|desanim|cansad)/i.test(input)) return 'Um passo bem feito vale mais que dez no automático. Continua construindo.';

  const replies = [
    `Entendi, **${username}**. Essa ideia entrou no radar.`,
    'A base tá crescendo. Cada expansão me deixa menos “bot” e mais personagem da comunidade.',
    'Isso tem cara de coisa que vai virar feature.',
    'Tô online, de olho no servidor e acumulando ideias.',
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

export function characterVisualStatus() {
  const assets = characterAssets();
  return {
    ready: Boolean(assets.avatar),
    heroReady: Boolean(assets.profile),
    badgeReady: Boolean(assets.badge || assets.animatedBadge),
    assets,
    fallback: `${BRAND.name} usa os assets oficiais empacotados no repositório.`,
  };
}
