import { characterEmbed, CHARACTER } from './character.js';

export const BOT_RELEASE = Object.freeze({
  version: '0.8.0',
  name: 'Community Expansion',
  highlights: [
    '🕹️ Nova área exclusiva para jogos interativos.',
    '✨ Títulos e selos agora sincronizam com cargos cosméticos visíveis.',
    '🛡️ Segurança e AutoMod reforçados.',
    '📡 Painel de status dos jogos atualizado automaticamente.',
    '🔄 Manutenção leve automática de painéis e identidades.',
    '🧾 Canal de atualizações com changelog automático por versão.',
  ],
});

function marker() {
  return `MIOJO_RELEASE:${BOT_RELEASE.version}`;
}

export async function ensureReleaseAnnouncement(guild) {
  const channel = guild.channels.cache.find(
    (candidate) => candidate.name === '🧾・atualizações' && candidate.isTextBased(),
  );
  if (!channel) return { ok: false, reason: 'channel_missing' };

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) =>
    message.author.id === guild.members.me?.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(marker())),
  );
  if (existing) return { ok: true, posted: false };

  const embed = characterEmbed({
    title: `🧾 MiojoPlays Bot ${BOT_RELEASE.version} • ${BOT_RELEASE.name}`,
    description: [
      'Atualização aplicada automaticamente ao sistema da comunidade.',
      '',
      ...BOT_RELEASE.highlights,
      '',
      'O `/repair` continua disponível para uma verificação estrutural manual quando necessário.',
    ].join('\n'),
    color: CHARACTER.palette.success,
    presentation: 'hero',
    seal: 'animated',
  }).setFooter({ text: `MiojoPlays • ${marker()}` });

  await channel.send({ embeds: [embed] });
  return { ok: true, posted: true };
}
