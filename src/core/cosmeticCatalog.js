export const ACHIEVEMENT_CHAT_BADGES = Object.freeze([
  {
    id: 'badge_first_message',
    achievementId: 'first_message',
    symbol: '🏅',
    label: 'Primeiro Sinal',
    description: 'Desbloqueado na primeira participação registrada.',
    priority: 10,
  },
  {
    id: 'badge_level_5',
    achievementId: 'level_5',
    symbol: '✨',
    label: 'Neon I',
    description: 'Desbloqueado ao alcançar o nível 5.',
    priority: 20,
  },
  {
    id: 'badge_level_10',
    achievementId: 'level_10',
    symbol: '⚡',
    label: 'Neon II',
    description: 'Desbloqueado ao alcançar o nível 10.',
    priority: 40,
  },
  {
    id: 'badge_coins_1000',
    achievementId: 'coins_1000',
    symbol: '🍜',
    label: 'Cofre Roxo',
    description: 'Desbloqueado ao alcançar 1.000 MiojoCoins.',
    priority: 30,
  },
  {
    id: 'badge_rep_10',
    achievementId: 'rep_10',
    symbol: '💜',
    label: 'Respeitado',
    description: 'Desbloqueado ao alcançar 10 de reputação.',
    priority: 50,
  },
  {
    id: 'badge_streak_7',
    achievementId: 'streak_7',
    symbol: '🔥',
    label: 'Disciplina',
    description: 'Desbloqueado ao manter uma sequência diária de 7 dias.',
    priority: 60,
  },
]);

export const PURCHASABLE_CHAT_TITLES = Object.freeze([
  {
    id: 'title_noturno',
    type: 'title',
    name: 'Noturno',
    value: '🌙 Noturno',
    symbol: '🌙',
    price: 350,
    description: 'Título dark para o perfil e para o nome no chat.',
  },
  {
    id: 'title_neon',
    type: 'title',
    name: 'Veterano Neon',
    value: '💜 Veterano Neon',
    symbol: '💜',
    price: 650,
    description: 'Título de veterano da comunidade.',
  },
  {
    id: 'title_guardiao',
    type: 'title',
    name: 'Guardião da Base',
    value: '🐈‍⬛ Guardião da Base',
    symbol: '🛡️',
    price: 1200,
    description: 'Título especial inspirado no Mio.',
  },
  {
    id: 'title_lendario',
    type: 'title',
    name: 'Miojo Lendário',
    value: '🍜 Miojo Lendário',
    symbol: '🍜',
    price: 2500,
    description: 'Título premium de progressão.',
  },
]);

export const CHAT_COSMETICS = Object.freeze([
  ...ACHIEVEMENT_CHAT_BADGES.map((item) => ({ ...item, kind: 'badge' })),
  ...PURCHASABLE_CHAT_TITLES.map((item) => ({ ...item, kind: 'title', label: item.name })),
]);

const BY_ID = new Map(CHAT_COSMETICS.map((item) => [item.id, item]));
const TITLE_BY_VALUE = new Map(PURCHASABLE_CHAT_TITLES.map((item) => [item.value, item]));

export function chatCosmeticById(id) {
  return BY_ID.get(String(id || '')) ?? null;
}

export function chatCosmeticForTitleValue(value) {
  return TITLE_BY_VALUE.get(String(value || '')) ?? null;
}

export function profileOwnsChatCosmetic(profile, cosmetic) {
  if (!profile || !cosmetic) return false;
  if (cosmetic.kind === 'badge') {
    return Array.isArray(profile.achievements) && profile.achievements.includes(cosmetic.achievementId);
  }
  if (cosmetic.kind === 'title') {
    return Array.isArray(profile.ownedTitles) && profile.ownedTitles.includes(cosmetic.value);
  }
  return false;
}

export function ownedChatCosmetics(profile) {
  return CHAT_COSMETICS.filter((cosmetic) => profileOwnsChatCosmetic(profile, cosmetic));
}

export function preferredAutomaticCosmetic(profile) {
  const equippedTitle = chatCosmeticForTitleValue(profile?.title);
  if (equippedTitle && profileOwnsChatCosmetic(profile, equippedTitle)) return equippedTitle;

  return ACHIEVEMENT_CHAT_BADGES
    .filter((cosmetic) => profileOwnsChatCosmetic(profile, { ...cosmetic, kind: 'badge' }))
    .sort((a, b) => b.priority - a.priority)[0] ?? null;
}

export function managedChatPrefixes() {
  return [...new Set(CHAT_COSMETICS.map((cosmetic) => `${cosmetic.symbol}・`))];
}
