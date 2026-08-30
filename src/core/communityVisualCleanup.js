import { EmbedBuilder } from 'discord.js';
import { CATEGORY_BLUEPRINT } from './blueprint.js';

const MANAGED_TEXT_CHANNELS = new Set(
  CATEGORY_BLUEPRINT.flatMap((category) => category.channels.map((channel) => channel.name)),
);

function isLegacyMioImage(url) {
  return typeof url === 'string' && /(?:^|\/)mio-character\.(?:webp|png|jpe?g)(?:\?|$)/i.test(url);
}

function withoutLegacyMioImage(embed) {
  const data = embed.toJSON();
  let changed = false;

  if (isLegacyMioImage(data.image?.url)) {
    delete data.image;
    changed = true;
  }

  if (isLegacyMioImage(data.thumbnail?.url)) {
    delete data.thumbnail;
    changed = true;
  }

  return {
    changed,
    embed: changed ? new EmbedBuilder(data) : embed,
  };
}

export async function stripLegacyMioVisuals(guild) {
  await guild.channels.fetch().catch(() => {});
  const botId = guild.members.me?.id;
  if (!botId) return { scanned: 0, updated: 0 };

  let scanned = 0;
  let updated = 0;

  const channels = guild.channels.cache.filter(
    (channel) => MANAGED_TEXT_CHANNELS.has(channel.name) && channel.isTextBased?.(),
  );

  for (const channel of channels.values()) {
    const messages = await channel.messages?.fetch?.({ limit: 50 }).catch(() => null);
    if (!messages) continue;

    for (const message of messages.values()) {
      if (message.author.id !== botId || !message.embeds.length) continue;
      scanned += 1;

      let changed = false;
      const embeds = message.embeds.map((embed) => {
        const cleaned = withoutLegacyMioImage(embed);
        if (cleaned.changed) changed = true;
        return cleaned.embed;
      });

      if (!changed) continue;
      await message.edit({ embeds }).catch((error) => {
        console.warn(`Falha ao remover visual antigo do Mio em ${channel.name}/${message.id}: ${error.message}`);
      });
      updated += 1;
    }
  }

  return { scanned, updated };
}
