import { DATA_CHANNEL_NAME } from './communityStore.js';

const PREFIX = 'TERRARIA_LINK:';

function dataChannel(guild) {
  return guild.channels.cache.find(
    (channel) => channel.name === DATA_CHANNEL_NAME && channel.isTextBased(),
  ) ?? null;
}

function parseLinkMessage(message, ownerId) {
  const expected = `${PREFIX}${ownerId}\n`;
  if (!message.content?.startsWith(expected)) return null;
  const [hash = '', linkedAtText = '0'] = message.content.slice(expected.length).trim().split('|');
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const linkedAt = Math.max(0, Number(linkedAtText) || 0);
  return { hash: hash.toLowerCase(), linkedAt };
}

async function findLinkMessage(guild, ownerId) {
  const channel = dataChannel(guild);
  if (!channel) return { channel: null, message: null, data: null };
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return { channel, message: null, data: null };

  for (const message of messages.values()) {
    if (message.author.id !== guild.members.me?.id) continue;
    const data = parseLinkMessage(message, ownerId);
    if (data) return { channel, message, data };
  }
  return { channel, message: null, data: null };
}

export async function loadTerrariaLink(guild, ownerId) {
  const result = await findLinkMessage(guild, ownerId);
  return result.data;
}

export async function saveTerrariaLink(guild, ownerId, hash, linkedAt) {
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('terraria_link_hash_invalid');
  const result = await findLinkMessage(guild, ownerId);
  if (!result.channel) throw new Error('terraria_persistence_unavailable');

  const content = `${PREFIX}${ownerId}\n${hash.toLowerCase()}|${Math.max(0, Number(linkedAt) || Date.now())}`;
  if (result.message) {
    await result.message.edit({ content });
  } else {
    await result.channel.send({ content, allowedMentions: { parse: [] } });
  }
  return true;
}
