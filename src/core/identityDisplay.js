import { getAllProfiles, getProfile } from './communityStore.js';

const TITLE_ROLE_BY_VALUE = Object.freeze({
  '🌙 Noturno': '🏷️・Título • Noturno',
  '💜 Veterano Neon': '🏷️・Título • Veterano Neon',
  '🐈‍⬛ Guardião da Base': '🏷️・Título • Guardião da Base',
  '🛡️ Guardião da Base': '🏷️・Título • Guardião da Base',
  '🍜 Miojo Lendário': '🏷️・Título • Miojo Lendário',
});

const SEAL_ROLE_BY_ID = Object.freeze({
  founder: '✨・Selo • Fundador',
  official: '✨・Selo • Oficial',
  vip: '✨・Selo • VIP',
  sub: '✨・Selo • Sub',
  supporter: '✨・Selo • Supporter',
  live: '✨・Selo • Presença em Live',
  event: '✨・Selo • Evento Oficial',
});

export const IDENTITY_ROLE_NAMES = Object.freeze([
  ...new Set([
    ...Object.values(TITLE_ROLE_BY_VALUE),
    ...Object.values(SEAL_ROLE_BY_ID),
  ]),
]);

const TITLE_ROLE_NAMES = new Set(Object.values(TITLE_ROLE_BY_VALUE));
const SEAL_ROLE_NAMES = new Set(Object.values(SEAL_ROLE_BY_ID));

async function ensureRole(guild, name) {
  let role = guild.roles.cache.find((candidate) => candidate.name === name);
  if (role) return role;

  role = await guild.roles.create({
    name,
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: [],
    reason: 'MiojoPlays cosmetic identity display',
  });
  return role;
}

async function ensureManagedRoles(guild, names) {
  await guild.roles.fetch().catch(() => {});
  const map = new Map();
  for (const name of names) {
    const role = await ensureRole(guild, name);
    map.set(name, role);
  }
  return map;
}

async function resolveMember(guild, userId) {
  return guild.members.cache.get(userId)
    ?? await guild.members.fetch(userId).catch(() => null);
}

async function syncGroup(guild, member, targetName, managedNames, reason) {
  if (!member?.roles) return { ok: false, reason: 'member_unavailable' };

  const roles = await ensureManagedRoles(guild, managedNames);
  const target = targetName ? roles.get(targetName) : null;
  const current = member.roles.cache.filter((role) => managedNames.has(role.name));
  const toRemove = current.filter((role) => !target || role.id !== target.id);
  const blocked = toRemove.filter((role) => !role.editable);
  const removable = toRemove.filter((role) => role.editable);

  if (removable.size) {
    await member.roles.remove([...removable.values()], reason);
  }

  if (target && !member.roles.cache.has(target.id)) {
    if (!target.editable) {
      return {
        ok: false,
        reason: 'role_hierarchy',
        target: target.name,
        blocked: [...blocked.values()].map((role) => role.name),
      };
    }
    await member.roles.add(target, reason);
  }

  if (blocked.size) {
    return {
      ok: false,
      reason: 'role_hierarchy',
      target: target?.name ?? null,
      blocked: [...blocked.values()].map((role) => role.name),
    };
  }

  return {
    ok: true,
    target: target?.name ?? null,
    removed: [...removable.values()].map((role) => role.name),
  };
}

export function titleDisplayRole(title) {
  return TITLE_ROLE_BY_VALUE[String(title || '')] ?? null;
}

export function sealDisplayRole(sealId) {
  return SEAL_ROLE_BY_ID[String(sealId || '')] ?? null;
}

export async function syncTitleDisplayRole(guild, userId, profile = null) {
  const current = profile ?? await getProfile(guild, userId);
  const member = await resolveMember(guild, userId);
  return syncGroup(
    guild,
    member,
    titleDisplayRole(current.title),
    TITLE_ROLE_NAMES,
    'MiojoPlays: sincronização do título equipado',
  );
}

export async function syncSealDisplayRole(guild, userId, profile = null) {
  const current = profile ?? await getProfile(guild, userId);
  const member = await resolveMember(guild, userId);
  return syncGroup(
    guild,
    member,
    sealDisplayRole(current.equippedSeal),
    SEAL_ROLE_NAMES,
    'MiojoPlays: sincronização do selo equipado',
  );
}

export async function reconcileIdentityRoles(guild, userId, profile = null) {
  const current = profile ?? await getProfile(guild, userId);
  const [title, seal] = await Promise.all([
    syncTitleDisplayRole(guild, userId, current),
    syncSealDisplayRole(guild, userId, current),
  ]);
  return { title, seal };
}

export async function reconcileAllIdentityRoles(guild, { limit = 250 } = {}) {
  const profiles = (await getAllProfiles(guild)).slice(0, limit);
  let synced = 0;
  let skipped = 0;
  let hierarchyBlocked = 0;

  for (const profile of profiles) {
    try {
      const member = await resolveMember(guild, profile.userId);
      if (!member) {
        skipped += 1;
        continue;
      }
      const result = await reconcileIdentityRoles(guild, profile.userId, profile);
      if (!result.title.ok || !result.seal.ok) {
        hierarchyBlocked += 1;
        skipped += 1;
        continue;
      }
      synced += 1;
    } catch (error) {
      skipped += 1;
      console.warn(`Identity sync ${profile.userId}: ${error.message}`);
    }
  }

  return { total: profiles.length, synced, skipped, hierarchyBlocked };
}
