import { characterEmbed, CHARACTER } from './character.js';
import { buildGuild } from './guildBuilder.js';
import { ensureAutoMod } from './automod.js';
import { ensureSelfRolePanel } from './communityV3.js';
import { ensureInteractiveHub } from './interactiveHub.js';
import { reconcileAllIdentityRoles } from './identityDisplay.js';
import { ensureReleaseAnnouncement } from './releaseAnnouncements.js';

const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const SECURITY_MARKER = 'MIOJO_SECURITY_GUIDE_V1';
let timer = null;
let clientRef = null;
const state = {
  runs: 0,
  lastRunAt: null,
  lastStructuralRunAt: null,
  lastError: null,
  lastIdentitySync: null,
};

async function ensureSecurityPanel(guild) {
  const channel = guild.channels.cache.find(
    (candidate) => candidate.name === '🛡️・segurança' && candidate.isTextBased(),
  );
  if (!channel) return false;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === guild.members.me?.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(SECURITY_MARKER)),
  );

  const embed = characterEmbed({
    title: '🛡️ Segurança da MiojoPlays',
    description: [
      '• A staff nunca precisa da sua senha, token ou código de autenticação.',
      '• Desconfie de “Nitro grátis”, arquivos inesperados e páginas que imitam Discord/Kick.',
      '• Ative autenticação em duas etapas sempre que possível.',
      '• Use ticket para reportar tentativa de golpe, invasão ou comportamento suspeito.',
      '• Links oficiais importantes são publicados pelos canais oficiais da comunidade.',
      '',
      '🚨 O AutoMod envia eventos de spam e raid de menções para a área privada de segurança da staff.',
    ].join('\n'),
    color: CHARACTER.palette.warning,
    presentation: 'compact',
  }).setFooter({ text: `MiojoPlays • ${SECURITY_MARKER}` });

  if (existing) await existing.edit({ embeds: [embed] });
  else await channel.send({ embeds: [embed] });
  return true;
}

async function runForGuild(guild, { structural = false } = {}) {
  let structuralError = null;
  if (structural) {
    try {
      await buildGuild(guild, { repairOnly: true });
      state.lastStructuralRunAt = new Date().toISOString();
    } catch (error) {
      structuralError = error;
      console.warn(`Community structural maintenance (${guild.name}): ${error.message}`);
    }
  }

  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  const rolesChannel = guild.channels.cache.find(
    (channel) => channel.name === '🎭・cargos' && channel.isTextBased(),
  );
  await ensureSelfRolePanel(guild, rolesChannel).catch((error) => {
    console.warn(`Self-role panel (${guild.name}): ${error.message}`);
  });

  await ensureInteractiveHub(guild).catch((error) => {
    console.warn(`Interactive hub (${guild.name}): ${error.message}`);
  });

  const identity = await reconcileAllIdentityRoles(guild).catch((error) => ({
    total: 0,
    synced: 0,
    skipped: 0,
    error: error.message,
  }));
  state.lastIdentitySync = identity;

  const securityChannel = guild.channels.cache.find(
    (channel) => channel.name === '🔐・security-alerts' && channel.isTextBased(),
  );
  const autoModReport = { automodCreated: [], automodUpdated: [], warnings: [] };
  await ensureAutoMod(guild, securityChannel, autoModReport).catch((error) => {
    autoModReport.warnings.push(error.message);
  });

  await ensureSecurityPanel(guild).catch((error) => {
    console.warn(`Security panel (${guild.name}): ${error.message}`);
  });
  await ensureReleaseAnnouncement(guild).catch((error) => {
    console.warn(`Release announcement (${guild.name}): ${error.message}`);
  });

  state.runs += 1;
  state.lastRunAt = new Date().toISOString();
  state.lastError = structuralError?.message
    || identity.error
    || autoModReport.warnings[0]
    || null;

  return {
    structural: structural && !structuralError,
    identity,
    automod: autoModReport,
  };
}

export async function runCommunityMaintenance(client, { structural = false } = {}) {
  const results = [];
  for (const guild of client.guilds.cache.values()) {
    try {
      results.push(await runForGuild(guild, { structural }));
    } catch (error) {
      state.lastError = error.message;
      console.error(`Community maintenance (${guild.name}):`, error);
    }
  }
  return results;
}

export function startCommunityAutomation(client) {
  if (timer) return;
  clientRef = client;

  runCommunityMaintenance(client, { structural: true }).catch((error) => {
    state.lastError = error.message;
    console.error('Community bootstrap maintenance:', error);
  });

  timer = setInterval(() => {
    if (!clientRef?.isReady()) return;
    runCommunityMaintenance(clientRef).catch((error) => {
      state.lastError = error.message;
      console.error('Community scheduled maintenance:', error);
    });
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
}

export function stopCommunityAutomation() {
  if (timer) clearInterval(timer);
  timer = null;
  clientRef = null;
}

export function communityAutomationStatus() {
  return {
    enabled: Boolean(timer),
    intervalMinutes: MAINTENANCE_INTERVAL_MS / 60_000,
    runs: state.runs,
    lastRunAt: state.lastRunAt,
    lastStructuralRunAt: state.lastStructuralRunAt,
    lastError: state.lastError,
    lastIdentitySync: state.lastIdentitySync,
  };
}
