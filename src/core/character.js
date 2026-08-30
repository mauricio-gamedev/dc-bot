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
  // A arte do Mio foi desativada nos embeds da comunidade porque o cliente do
  // Discord estava renderizando o asset como um bloco cinza em alguns casos.
  // Mantemos a identidade/persona textual e permitimos apenas selos opcionais.
  const badge = validHttpUrl(process.env.MIO_BADGE_IMAGE_URL);
  const animatedBadge = validHttpUrl(process.env.MIO_BADGE_ANIMATED_URL);
  return {
    avatar: null,
    banner: null,
    profile: null,
    badge,
    animatedBadge,
  };
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

  if (assets.badge) footerData.iconURL = assets.badge;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter(footerData)
    .setTimestamp();

  if (presentation === 'hero') {
    if (thumbnail && selectedSeal) embed.setThumbnail(selectedSeal);
    if (explicitImage) embed.setImage(explicitImage);
    return embed;
  }

  if (presentation === 'badge') {
    if (thumbnail && selectedSeal) embed.setThumbnail(selectedSeal);
    if (explicitImage) embed.setImage(explicitImage);
    return embed;
  }

  if (thumbnail && selectedSeal) embed.setThumbnail(selectedSeal);
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
    ready: true,
    heroReady: true,
    badgeReady: Boolean(assets.badge || assets.animatedBadge),
    assets,
    fallback: `${BRAND.name} mantém a identidade textual do Mio; a imagem do personagem está desativada nos embeds para evitar a renderização cinza observada no Discord.`,
  };
}
