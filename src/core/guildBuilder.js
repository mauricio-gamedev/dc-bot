import {
  ChannelType,
  EmbedBuilder,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  PermissionFlagsBits,
} from 'discord.js';
import {
  BRAND,
  CATEGORY_BLUEPRINT,
  ROLE_BLUEPRINT,
  STAFF_ROLE_NAMES,
  VIP_ROLE_NAMES,
} from './blueprint.js';
import { ensureTicketPanel } from './tickets.js';

const SETUP_MARKER = 'miojoplays:managed:v1';

function byExactName(collection, name) {
  return collection.find((item) => item.name === name);
}

async function ensureRole(guild, spec, report) {
  let role = byExactName(guild.roles.cache, spec.name);

  if (!role) {
    role = await guild.roles.create({
      name: spec.name,
      color: spec.color,
      hoist: spec.hoist,
      mentionable: spec.mentionable,
      permissions: spec.permissions,
      reason: 'MiojoPlays professional community setup',
    });
    report.rolesCreated.push(role.name);
    return role;
  }

  if (!role.managed && role.editable) {
    await role.edit({
      color: spec.color,
      hoist: spec.hoist,
      mentionable: spec.mentionable,
      permissions: spec.permissions,
      reason: 'MiojoPlays community repair',
    });
    report.rolesUpdated.push(role.name);
  }

  return role;
}

function staffOverwriteSet(guild, roleMap) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];

  for (const roleName of STAFF_ROLE_NAMES) {
    const role = roleMap.get(roleName);
    if (!role) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  return overwrites;
}

function vipOverwriteSet(guild, roleMap) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];

  for (const roleName of VIP_ROLE_NAMES) {
    const role = roleMap.get(roleName);
    if (!role) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  return overwrites;
}

function readOnlyOverwrites(guild, roleMap) {
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
    const role = roleMap.get(roleName);
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

function combineOverwrites(...groups) {
  const merged = new Map();

  for (const group of groups.filter(Boolean)) {
    for (const overwrite of group) {
      const current = merged.get(overwrite.id) ?? { id: overwrite.id, allow: [], deny: [] };
      current.allow = [...new Set([...(current.allow ?? []), ...(overwrite.allow ?? [])])];
      current.deny = [...new Set([...(current.deny ?? []), ...(overwrite.deny ?? [])])];
      merged.set(overwrite.id, current);
    }
  }

  return [...merged.values()];
}

async function ensureCategory(guild, spec, roleMap, report) {
  let category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === spec.name,
  );

  const permissionOverwrites = spec.staffOnly
    ? staffOverwriteSet(guild, roleMap)
    : spec.vipOnly
      ? vipOverwriteSet(guild, roleMap)
      : undefined;

  if (!category) {
    category = await guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites,
      reason: 'MiojoPlays professional community setup',
    });
    report.categoriesCreated.push(category.name);
  } else if (permissionOverwrites) {
    await category.permissionOverwrites.set(permissionOverwrites, 'MiojoPlays community repair');
    report.categoriesUpdated.push(category.name);
  }

  return category;
}

async function ensureChannel(guild, category, spec, roleMap, report, categorySpec) {
  let channel = guild.channels.cache.find(
    (candidate) => candidate.name === spec.name && candidate.type === spec.type,
  );

  const inheritedScope = categorySpec.staffOnly
    ? staffOverwriteSet(guild, roleMap)
    : categorySpec.vipOnly
      ? vipOverwriteSet(guild, roleMap)
      : undefined;

  const permissionOverwrites = spec.readOnly
    ? combineOverwrites(inheritedScope, readOnlyOverwrites(guild, roleMap))
    : inheritedScope;

  if (!channel) {
    channel = await guild.channels.create({
      name: spec.name,
      type: spec.type,
      parent: category.id,
      topic: spec.type === ChannelType.GuildText ? spec.topic : undefined,
      permissionOverwrites,
      reason: 'MiojoPlays professional community setup',
    });
    report.channelsCreated.push(channel.name);
    return channel;
  }

  const edits = {};
  if (channel.parentId !== category.id) edits.parent = category.id;
  if (spec.type === ChannelType.GuildText && channel.topic !== (spec.topic ?? null)) {
    edits.topic = spec.topic ?? null;
  }

  if (Object.keys(edits).length > 0) {
    await channel.edit({ ...edits, reason: 'MiojoPlays community repair' });
  }

  if (permissionOverwrites) {
    await channel.permissionOverwrites.set(permissionOverwrites, 'MiojoPlays community repair');
  }

  report.channelsUpdated.push(channel.name);
  return channel;
}

async function hasManagedMarker(channel, marker) {
  if (!channel?.isTextBased?.()) return false;
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.some((message) =>
      message.author.bot &&
      message.embeds.some((embed) => embed.footer?.text?.includes(marker)),
    );
  } catch {
    return false;
  }
}

function managedEmbed(title, description, color = BRAND.color) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `${BRAND.footer} • ${SETUP_MARKER}` })
    .setTimestamp();
}

async function seedMessages(channels, report) {
  const seeds = [
    {
      name: '👋・boas-vindas',
      marker: 'welcome',
      embed: managedEmbed(
        '👋 Bem-vindo à comunidade!',
        [
          'Este é o espaço oficial da **MiojoPlays Community**.',
          '',
          '📜 Leia <#RULES_ID> antes de participar.',
          '💬 Depois, chega no chat geral e fica à vontade.',
          '🎮 Use os canais de jogos para encontrar gente pra jogar.',
          '🎫 Se precisar de ajuda privada, abra um ticket.',
          '',
          'Respeito, resenha e comunidade acima de tudo. 💜',
        ].join('\n'),
      ),
    },
    {
      name: '📜・regras',
      marker: 'rules',
      embed: managedEmbed(
        '📜 Regras da comunidade',
        [
          '**1. Respeito é obrigatório.** Nada de assédio, discurso de ódio ou ataques pessoais.',
          '**2. Sem spam ou divulgação abusiva.** Links e autopromoção só quando fizer sentido.',
          '**3. Conteúdo seguro.** Nada ilegal, explícito ou que coloque outras pessoas em risco.',
          '**4. Use os canais certos.** Isso mantém o servidor organizado e fácil de navegar.',
          '**5. Sem golpes, phishing ou arquivos suspeitos.** Segurança vem primeiro.',
          '**6. Respeite a staff.** Decisões podem ser revisadas, mas discussão deve ser civilizada.',
          '**7. Bom senso vale sempre.** Nem tudo precisa estar escrito para ser considerado inadequado.',
          '',
          'Ao permanecer no servidor, você concorda em seguir estas regras.',
        ].join('\n'),
      ),
    },
    {
      name: '📢・anúncios',
      marker: 'announcements',
      embed: managedEmbed(
        '📢 Central de anúncios',
        'Atualizações importantes, eventos, novidades do servidor e comunicados da MiojoPlays aparecem aqui.',
      ),
    },
    {
      name: '🎭・cargos',
      marker: 'roles',
      embed: managedEmbed(
        '🎭 Cargos da comunidade',
        [
          '👑 **Administração** — gestão do servidor.',
          '🛡️ **Moderador** — segurança e organização.',
          '🎫 **Suporte** — atendimento da comunidade.',
          '🎥 **Criador** — criadores e parceiros da comunidade.',
          '💎 **VIP** — membros especiais.',
          '⭐ **Sub** — apoiadores/subs.',
          '👤 **Membro** — comunidade geral.',
          '',
          'Os cargos especiais são atribuídos pela equipe ou por futuras integrações automáticas.',
        ].join('\n'),
      ),
    },
    {
      name: '💙・apoie-a-live',
      marker: 'support-live',
      embed: managedEmbed(
        '💙 Apoie a live',
        'Quer fortalecer as lives e os projetos da comunidade? Use somente os links oficiais publicados pela MiojoPlays neste canal.',
        BRAND.success,
      ),
    },
  ];

  const rulesChannel = channels.get('📜・regras');

  for (const seed of seeds) {
    const channel = channels.get(seed.name);
    if (!channel?.isTextBased?.()) continue;
    if (await hasManagedMarker(channel, seed.marker)) continue;

    if (seed.name === '👋・boas-vindas' && rulesChannel) {
      seed.embed.setDescription(seed.embed.data.description.replace('<#RULES_ID>', `<#${rulesChannel.id}>`));
    }

    seed.embed.setFooter({ text: `${BRAND.footer} • ${SETUP_MARKER}:${seed.marker}` });
    await channel.send({ embeds: [seed.embed] });
    report.messagesSeeded.push(seed.name);
  }
}

async function tuneGuild(guild, channels, report) {
  const general = channels.get('💬・geral');
  const afk = channels.get('💤・AFK');

  const edit = {
    defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
    explicitContentFilter: GuildExplicitContentFilter.AllMembers,
    verificationLevel: GuildVerificationLevel.Medium,
    reason: 'MiojoPlays professional community baseline',
  };

  if (general) edit.systemChannel = general.id;
  if (afk) {
    edit.afkChannel = afk.id;
    edit.afkTimeout = 900;
  }

  try {
    await guild.edit(edit);
    report.guildTuned = true;
  } catch (error) {
    report.warnings.push(`Não foi possível aplicar todas as configurações globais: ${error.message}`);
  }
}

export async function buildGuild(guild, { repairOnly = false } = {}) {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const report = {
    mode: repairOnly ? 'repair' : 'setup',
    rolesCreated: [],
    rolesUpdated: [],
    categoriesCreated: [],
    categoriesUpdated: [],
    channelsCreated: [],
    channelsUpdated: [],
    messagesSeeded: [],
    guildTuned: false,
    warnings: [],
  };

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error('O bot precisa temporariamente da permissão Administrador para montar e reparar toda a estrutura com segurança.');
  }

  const roleMap = new Map();
  for (const roleSpec of ROLE_BLUEPRINT) {
    const role = await ensureRole(guild, roleSpec, report);
    roleMap.set(roleSpec.name, role);
  }

  const channels = new Map();
  for (const categorySpec of CATEGORY_BLUEPRINT) {
    const category = await ensureCategory(guild, categorySpec, roleMap, report);
    for (const channelSpec of categorySpec.channels) {
      const channel = await ensureChannel(
        guild,
        category,
        channelSpec,
        roleMap,
        report,
        categorySpec,
      );
      channels.set(channelSpec.name, channel);
    }
  }

  await tuneGuild(guild, channels, report);
  await seedMessages(channels, report);
  await ensureTicketPanel(guild, channels.get('🎫・abrir-ticket'), roleMap, report);

  return report;
}

export function formatSetupReport(report) {
  const created = report.rolesCreated.length + report.categoriesCreated.length + report.channelsCreated.length;
  const repaired = report.rolesUpdated.length + report.categoriesUpdated.length + report.channelsUpdated.length;

  return [
    `✅ Estrutura processada com sucesso.`,
    `🆕 Criados: **${created}** itens`,
    `🛠️ Verificados/ajustados: **${repaired}** itens`,
    `📝 Mensagens iniciais novas: **${report.messagesSeeded.length}**`,
    `⚙️ Configurações globais: **${report.guildTuned ? 'aplicadas' : 'parciais'}**`,
    report.warnings.length ? `⚠️ Avisos: ${report.warnings.join(' | ')}` : '🟢 Nenhum aviso crítico.',
  ].join('\n');
}

export function inspectGuild(guild) {
  const missingRoles = ROLE_BLUEPRINT
    .filter((spec) => !byExactName(guild.roles.cache, spec.name))
    .map((spec) => spec.name);

  const missingCategories = CATEGORY_BLUEPRINT
    .filter((spec) => !guild.channels.cache.some((channel) => channel.type === ChannelType.GuildCategory && channel.name === spec.name))
    .map((spec) => spec.name);

  const expectedChannels = CATEGORY_BLUEPRINT.flatMap((category) => category.channels);
  const missingChannels = expectedChannels
    .filter((spec) => !guild.channels.cache.some((channel) => channel.name === spec.name && channel.type === spec.type))
    .map((spec) => spec.name);

  return {
    healthy: missingRoles.length === 0 && missingCategories.length === 0 && missingChannels.length === 0,
    missingRoles,
    missingCategories,
    missingChannels,
  };
}
