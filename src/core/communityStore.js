const DATA_CHANNEL_NAME = '🗄️・bot-data';
const PROFILE_PREFIX = 'PROFILE:';
const states = new Map();

function defaultProfile(userId) {
  return {
    userId,
    xp: 0,
    coins: 0,
    reputation: 0,
    messages: 0,
    level: 0,
    dailyStreak: 0,
    lastXpAt: 0,
    lastDailyAt: 0,
    lastRepGivenAt: 0,
    title: 'Sem título',
    ownedTitles: [],
    achievements: [],
    inventory: [],
    missionDate: '',
    missionMessages: 0,
    missionDaily: false,
    missionRep: false,
    missionClaimed: [],
    liveAttendanceCount: 0,
    liveAttendanceSessions: [],
    eventParticipationCount: 0,
    eventParticipationIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length <= 80))];
}

function normalizeProfile(userId, raw = {}) {
  const base = defaultProfile(userId);
  const data = { ...base, ...raw, userId };

  for (const key of [
    'xp', 'coins', 'reputation', 'messages', 'level', 'dailyStreak',
    'lastXpAt', 'lastDailyAt', 'lastRepGivenAt', 'missionMessages', 'liveAttendanceCount',
    'eventParticipationCount', 'createdAt', 'updatedAt',
  ]) {
    const value = Number(data[key]);
    data[key] = Number.isFinite(value) ? value : base[key];
  }

  data.liveAttendanceCount = Math.max(0, Math.floor(data.liveAttendanceCount));
  data.eventParticipationCount = Math.max(0, Math.floor(data.eventParticipationCount));
  data.title = typeof data.title === 'string' && data.title.length <= 80 ? data.title : base.title;
  data.ownedTitles = normalizeStringArray(data.ownedTitles);
  data.achievements = normalizeStringArray(data.achievements);
  data.inventory = normalizeStringArray(data.inventory);
  data.missionClaimed = normalizeStringArray(data.missionClaimed);
  data.liveAttendanceSessions = normalizeStringArray(data.liveAttendanceSessions).slice(-100);
  data.eventParticipationIds = normalizeStringArray(data.eventParticipationIds).slice(-100);
  data.missionDate = typeof data.missionDate === 'string' ? data.missionDate.slice(0, 16) : '';
  data.missionDaily = Boolean(data.missionDaily);
  data.missionRep = Boolean(data.missionRep);

  return data;
}

function getState(guildId) {
  if (!states.has(guildId)) {
    states.set(guildId, {
      loaded: false,
      loading: null,
      records: new Map(),
      dirty: new Set(),
      timers: new Map(),
      saveChain: Promise.resolve(),
    });
  }
  return states.get(guildId);
}

function findDataChannel(guild) {
  return guild.channels.cache.find(
    (channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased(),
  ) ?? null;
}

function parseProfileMessage(message) {
  if (!message.content?.startsWith(PROFILE_PREFIX)) return null;
  const newline = message.content.indexOf('\n');
  if (newline < 0) return null;
  const userId = message.content.slice(PROFILE_PREFIX.length, newline).trim();
  if (!/^\d{15,22}$/.test(userId)) return null;
  try {
    const raw = JSON.parse(message.content.slice(newline + 1));
    return { userId, profile: normalizeProfile(userId, raw) };
  } catch {
    return null;
  }
}

async function loadState(guild) {
  const state = getState(guild.id);
  if (state.loaded) return state;
  if (state.loading) return state.loading;

  state.loading = (async () => {
    const channel = findDataChannel(guild);
    if (!channel) {
      state.loaded = true;
      return state;
    }

    let before;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;

      for (const message of batch.values()) {
        if (message.author.id !== guild.members.me?.id) continue;
        const parsed = parseProfileMessage(message);
        if (!parsed || state.records.has(parsed.userId)) continue;
        state.records.set(parsed.userId, {
          messageId: message.id,
          profile: parsed.profile,
        });
      }

      if (batch.size < 100) break;
      before = batch.last()?.id;
      if (!before) break;
    }

    state.loaded = true;
    return state;
  })().finally(() => {
    state.loading = null;
  });

  return state.loading;
}

function serializeProfile(profile) {
  const clean = {
    xp: profile.xp,
    coins: profile.coins,
    reputation: profile.reputation,
    messages: profile.messages,
    level: profile.level,
    dailyStreak: profile.dailyStreak,
    lastXpAt: profile.lastXpAt,
    lastDailyAt: profile.lastDailyAt,
    lastRepGivenAt: profile.lastRepGivenAt,
    title: profile.title,
    ownedTitles: profile.ownedTitles,
    achievements: profile.achievements,
    inventory: profile.inventory,
    missionDate: profile.missionDate,
    missionMessages: profile.missionMessages,
    missionDaily: profile.missionDaily,
    missionRep: profile.missionRep,
    missionClaimed: profile.missionClaimed,
    liveAttendanceCount: profile.liveAttendanceCount,
    liveAttendanceSessions: profile.liveAttendanceSessions,
    eventParticipationCount: profile.eventParticipationCount,
    eventParticipationIds: profile.eventParticipationIds,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
  return `${PROFILE_PREFIX}${profile.userId}\n${JSON.stringify(clean)}`;
}

async function saveOne(guild, userId) {
  const state = await loadState(guild);
  const record = state.records.get(userId);
  if (!record) return;

  const channel = findDataChannel(guild);
  if (!channel) return;

  record.profile.updatedAt = Date.now();
  const content = serializeProfile(record.profile);

  if (record.messageId) {
    try {
      const message = await channel.messages.fetch(record.messageId);
      await message.edit({ content });
      state.dirty.delete(userId);
      return;
    } catch {
      record.messageId = null;
    }
  }

  const sent = await channel.send({
    content,
    allowedMentions: { parse: [] },
  });
  record.messageId = sent.id;
  state.dirty.delete(userId);
}

function enqueueSave(guild, userId) {
  const state = getState(guild.id);
  state.saveChain = state.saveChain
    .then(() => saveOne(guild, userId))
    .catch((error) => console.error(`Falha ao persistir perfil ${userId}:`, error));
  return state.saveChain;
}

function scheduleSave(guild, userId, delay = 7000) {
  const state = getState(guild.id);
  state.dirty.add(userId);
  const existing = state.timers.get(userId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    state.timers.delete(userId);
    enqueueSave(guild, userId);
  }, delay);
  timer.unref?.();
  state.timers.set(userId, timer);
}

export async function getProfile(guild, userId) {
  const state = await loadState(guild);
  let record = state.records.get(userId);
  if (!record) {
    record = { messageId: null, profile: defaultProfile(userId) };
    state.records.set(userId, record);
  }
  return record.profile;
}

export async function mutateProfile(guild, userId, mutator, { immediate = false } = {}) {
  const profile = await getProfile(guild, userId);
  await mutator(profile);
  profile.updatedAt = Date.now();

  if (immediate) {
    const state = getState(guild.id);
    state.dirty.add(userId);
    await enqueueSave(guild, userId);
  } else {
    scheduleSave(guild, userId);
  }

  return profile;
}

export async function getAllProfiles(guild) {
  const state = await loadState(guild);
  return [...state.records.values()].map((record) => record.profile);
}

export async function flushAllProfiles(client) {
  for (const [guildId, state] of states) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const timer of state.timers.values()) clearTimeout(timer);
    state.timers.clear();

    for (const userId of [...state.dirty]) {
      await enqueueSave(guild, userId);
    }
    await state.saveChain;
  }
}

export { DATA_CHANNEL_NAME };
