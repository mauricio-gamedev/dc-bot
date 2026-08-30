import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { BRAND, STAFF_ROLE_NAMES } from './blueprint.js';
import { memberCommandGuideDescription } from './commandAccess.js';

const GUIDE_MARKER = 'MIOJO_MEMBER_COMMANDS_V1';
const GUIDE_CHANNEL = '🤖・comandos';
const GUIDE_CATEGORY = '📌・INÍCIO';
const GUIDE_TOPIC = 'Lista oficial de comandos que membros podem utilizar com segurança.';

function guideOverwrites(guild) {
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
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  return overwrites;
}

function guideEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle('🤖 Comandos disponíveis para membros')
    .setDescription(memberCommandGuideDescription())
    .setFooter({ text: `${BRAND.footer} • ${GUIDE_MARKER}` })
    .setTimestamp();
}

export async function ensureCommandGuide(guild) {
  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  const category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === GUIDE_CATEGORY,
  );
  if (!category) return { ok: false, reason: 'missing_category' };

  let channel = guild.channels.cache.find(
    (candidate) => candidate.type === ChannelType.GuildText && candidate.name === GUIDE_CHANNEL,
  );

  const permissionOverwrites = guideOverwrites(guild);
  if (!channel) {
    channel = await guild.channels.create({
      name: GUIDE_CHANNEL,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: GUIDE_TOPIC,
      permissionOverwrites,
      reason: 'MiojoPlays member command guide',
    });
  } else {
    const edits = {};
    if (channel.parentId !== category.id) edits.parent = category.id;
    if (channel.topic !== GUIDE_TOPIC) edits.topic = GUIDE_TOPIC;
    if (Object.keys(edits).length) {
      await channel.edit({ ...edits, reason: 'MiojoPlays command guide repair' });
    }
    await channel.permissionOverwrites.set(permissionOverwrites, 'MiojoPlays command guide permissions');
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === guild.members.me?.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(GUIDE_MARKER)),
  );

  const embed = guideEmbed();
  if (existing) {
    await existing.edit({ embeds: [embed] });
    return { ok: true, channel, updated: true };
  }

  await channel.send({ embeds: [embed] });
  return { ok: true, channel, created: true };
}
