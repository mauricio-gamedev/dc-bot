import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { CATEGORY_BLUEPRINT, STAFF_ROLE_NAMES } from './blueprint.js';
import { ensureAutoMod } from './automod.js';
import { ensureSelfRolePanel } from './communityV3.js';
import { ensureInteractiveHub } from './interactiveHub.js';
import { reconcileAllIdentityRoles } from './identityDisplay.js';
import { ensureReleaseAnnouncement } from './releaseAnnouncements.js';

const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const SECURITY_MARKER = 'MIOJO_SECURITY_GUIDE_V1';
const EXPANSION_CATEGORY_NAMES = new Set([
  '📌・INÍCIO',
  '🕹️・JOGOS INTERATIVOS',
  '📺・MIOJOPLAYS',
  '🔒・STAFF',
]);
const EXPANSION_CHANNEL_NAMES = new Set([
  '🛡️・segurança',
  '📌・como-funciona',
  '🎮・mindustry-interativo',
  '🧪・comandos-interativos',
  '📡・status-interativo',
  '🧾・atualizações',
  '🔐・security-alerts',
]);

let timer = null;
let clientRef = null;
const state = {
  runs: 0,
  lastRunAt: null,
  lastStructuralRunAt: null,
  lastError: null,
  lastIdentitySync: null,
};

function publicReadOnlyOverwrites(guild) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
  ];

  for (const roleName of STAFF_ROLE_NAMES) {
    const role = guild.roles.cache.find((candidate) => candidate.name === roleName);
    if (!role) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }
  return overwrites;
}

async function ensureExpansionStructure(guild) {
  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  const report = { createdCategories: [], createdChannels: [], updatedTopics: [], warnings: [] };

  for (const categorySpec of CATEGORY_BLUEPRINT.filter((spec) => EXPANSION_CATEGORY_NAMES.has(spec.name))) {
    let category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name === categorySpec.name,
    );

    if (!category && categorySpec.name === '🕹️・JOGOS INTERATIVOS') {
      category = await guild.channels.create({
        name: categorySpec.name,
        type: ChannelType.GuildCategory,
        reason: 'MiojoPlays V0.8 interactive games expansion',
      });
      report.createdCategories.push(category.name);
    }

    if (!category) {
      report.warnings.push(`Categoria ausente: ${categorySpec.name}. Use /repair para reconstrução completa.`);
      continue;
    }

    for (const channelSpec of categorySpec.channels.filter((spec) => EXPANSION_CHANNEL_NAMES.has(spec.name))) {
      let channel = guild.channels.cache.find(
        (candidate) => candidate.name === channelSpec.name && candidate.type === channelSpec.type,
      );

      if (!channel) {
        const isPrivateParent = categorySpec.staffOnly || categorySpec.vipOnly;
        channel = await guild.channels.create({
          name: channelSpec.name,
          type: channelSpec.type,
          parent: category.id,
          topic: channelSpec.type === ChannelType.GuildText ? channelSpec.topic : undefined,
          permissionOverwrites: channelSpec.readOnly && !isPrivateParent
            ? publicReadOnlyOverwrites(guild)
            : undefined,
          reason: 'MiojoPlays V0.8 community expansion',
        });
        report.createdChannels.push(channel.name);
        continue;
      }

      if (channel.parentId !== category.id) {
        report.warnings.push(`Canal ${channel.name} já existe fora da categoria esperada; não foi movido automaticamente.`);
      }

      if (channel.type === ChannelType.GuildText && channel.topic !== (channelSpec.topic ?? null)) {
        await channel.edit({
          topic: channelSpec.topic ?? null,
          reason: 'MiojoPlays V0.8 topic refresh',
        }).catch((error) => report.warnings.push(`Tópico ${channel.name}: ${error.message}`));
        report.updatedTopics.push(channel.name);
      }
    }
  }

  state.lastStructuralRunAt = new Date().toISOString();
  return report;
}

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
  let structure = null;
  if (structural) {
    try {
      structure = await ensureExpansionStructure(guild);
    } catch (error) {
      structure = { error: error.message, warnings: [error.message] };
      console.warn(`Community expansion structure (${guild.name}): ${error.message}`);
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
  state.lastError = structure?.error
    || identity.error
    || autoModReport.warnings[0]
    || null;

  return {
    structural: structure,
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
