import { EmbedBuilder, Events } from 'discord.js';
import { BRAND } from './blueprint.js';

function findChannel(guild, name) {
  return guild.channels.cache.find((channel) => channel.name === name && channel.isTextBased()) ?? null;
}

export async function sendLog(guild, {
  title,
  description,
  color = BRAND.color,
  fields = [],
  memberLog = false,
}) {
  const channel = findChannel(guild, memberLog ? '📥・member-logs' : '📋・mod-logs');
  if (!channel) return false;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || null)
    .setFooter({ text: `${BRAND.footer} • Logs` })
    .setTimestamp();

  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

export function attachLogging(client) {
  client.on(Events.GuildMemberAdd, async (member) => {
    await sendLog(member.guild, {
      title: '📥 Membro entrou',
      description: `${member.user.tag} entrou no servidor.`,
      color: BRAND.success,
      memberLog: true,
      fields: [
        { name: 'Usuário', value: `<@${member.id}>`, inline: true },
        { name: 'ID', value: member.id, inline: true },
        { name: 'Conta criada', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      ],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    await sendLog(member.guild, {
      title: '📤 Membro saiu',
      description: `${member.user.tag} saiu do servidor.`,
      color: BRAND.warning,
      memberLog: true,
      fields: [{ name: 'ID', value: member.id, inline: true }],
    });
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    await sendLog(ban.guild, {
      title: '🔨 Banimento registrado',
      description: `${ban.user.tag} foi banido.`,
      color: BRAND.danger,
      fields: [
        { name: 'ID', value: ban.user.id, inline: true },
        { name: 'Motivo', value: ban.reason || 'Não informado', inline: false },
      ],
    });
  });

  client.on(Events.GuildBanRemove, async (ban) => {
    await sendLog(ban.guild, {
      title: '♻️ Banimento removido',
      description: `${ban.user.tag} foi desbanido.`,
      color: BRAND.success,
      fields: [{ name: 'ID', value: ban.user.id, inline: true }],
    });
  });

  client.on(Events.ChannelCreate, async (channel) => {
    if (!channel.guild) return;
    await sendLog(channel.guild, {
      title: '➕ Canal criado',
      description: `**${channel.name}** foi criado.`,
      fields: [{ name: 'ID', value: channel.id, inline: true }],
    });
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (!channel.guild) return;
    await sendLog(channel.guild, {
      title: '➖ Canal removido',
      description: `**${channel.name}** foi removido.`,
      color: BRAND.warning,
      fields: [{ name: 'ID', value: channel.id, inline: true }],
    });
  });

  client.on(Events.GuildRoleCreate, async (role) => {
    await sendLog(role.guild, {
      title: '🎭 Cargo criado',
      description: `**${role.name}** foi criado.`,
      fields: [{ name: 'ID', value: role.id, inline: true }],
    });
  });

  client.on(Events.GuildRoleDelete, async (role) => {
    await sendLog(role.guild, {
      title: '🗑️ Cargo removido',
      description: `**${role.name}** foi removido.`,
      color: BRAND.warning,
      fields: [{ name: 'ID', value: role.id, inline: true }],
    });
  });
}

export async function logModerationAction(interaction, action, target, reason) {
  await sendLog(interaction.guild, {
    title: `🛡️ Moderação • ${action}`,
    description: `Ação executada por <@${interaction.user.id}>.`,
    color: BRAND.danger,
    fields: [
      { name: 'Alvo', value: target, inline: true },
      { name: 'Moderador', value: interaction.user.tag, inline: true },
      { name: 'Motivo', value: reason || 'Não informado', inline: false },
    ],
  });
}
