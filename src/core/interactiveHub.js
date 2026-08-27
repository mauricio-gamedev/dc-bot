import { characterEmbed, CHARACTER } from './character.js';
import { kickInteractiveStatus } from './kickInteractive.js';
import { kickLiveStatus } from './kickLive.js';
import { mindustryStatus } from './mindustryInteractive.js';

const INFO_MARKER = 'MIOJO_INTERACTIVE_INFO_V1';
const COMMANDS_MARKER = 'MIOJO_INTERACTIVE_COMMANDS_V1';
const STATUS_MARKER = 'MIOJO_INTERACTIVE_STATUS_V1';

async function findManagedMessage(channel, marker) {
  if (!channel?.isTextBased?.()) return null;
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return recent?.find((message) =>
    message.author.id === channel.guild.members.me?.id
    && message.embeds.some((embed) => embed.footer?.text?.includes(marker)),
  ) ?? null;
}

async function upsertEmbed(channel, marker, embed) {
  if (!channel?.isTextBased?.()) return false;
  embed.setFooter({ text: `MiojoPlays • ${marker}` });
  const existing = await findManagedMessage(channel, marker);
  if (existing) {
    await existing.edit({ embeds: [embed] });
    return false;
  }
  await channel.send({ embeds: [embed] });
  return true;
}

function infoEmbed() {
  return characterEmbed({
    title: '🕹️ Jogos Interativos MiojoPlays',
    description: [
      'Esta área reúne os jogos que conversam diretamente com o sistema interativo da comunidade.',
      '',
      '**Fluxo atual:**',
      '`Kick → MiojoPlays Bot → fila segura → jogo`',
      '',
      '🎮 **Mindustry Interactive** — integração oficial ativa.',
      '📡 O status da conexão fica no canal de status desta categoria.',
      '🧪 Os comandos disponíveis ficam no canal de comandos.',
      '',
      'Novos jogos só entram aqui depois que a integração estiver realmente funcional e segura.',
    ].join('\n'),
    color: CHARACTER.palette.accent,
    presentation: 'hero',
    seal: 'animated',
  });
}

function commandsEmbed() {
  return characterEmbed({
    title: '🧪 Comandos • Mindustry Interactive',
    description: [
      '**Ajuda:** `!comandos` `!help`',
      '',
      '**Recursos:**',
      '`!cobre` `!chumbo` `!grafite` `!silicio` `!titanio` `!torio`',
      '',
      '**Suporte:**',
      '`!cura` `!boost`',
      '',
      '**Caos:**',
      '`!wave` `!horda` `!lento` `!gelo` `!fogo`',
      '',
      '🛡️ Cooldowns por viewer e globais continuam ativos para proteger a partida contra spam.',
    ].join('\n'),
    color: CHARACTER.palette.accent,
    presentation: 'compact',
  });
}

function statusEmbed(guildId) {
  const kickChat = kickInteractiveStatus(guildId);
  const kickLive = kickLiveStatus();
  const mindustry = mindustryStatus(guildId);

  return characterEmbed({
    title: '📡 Status dos Jogos Interativos',
    description: [
      `🔴 **Kick Live:** ${kickLive.lastState?.isLive ? '🟢 ao vivo' : '⚪ offline'}`,
      `💬 **Kick Chat:** ${kickChat.enabled && kickChat.configured ? '🟢 configurado' : '🟡 configuração incompleta'}`,
      `📨 **Webhook:** ${kickChat.lastWebhookAt ? '🟢 recebendo eventos' : kickChat.subscribed ? '🟡 inscrito, aguardando chat' : '⚪ sem evento'}`,
      `🎮 **Mindustry:** ${mindustry.connected ? '🟢 conectado' : '🔴 desconectado'}`,
      `🎛️ **Interações:** ${mindustry.interactionsOpen ? '🟢 abertas' : '🔒 fechadas'}`,
      '',
      mindustry.lastSeenAt ? `Último contato do jogo: <t:${Math.floor(new Date(mindustry.lastSeenAt).getTime() / 1000)}:R>` : 'Último contato do jogo: ainda não registrado.',
      '',
      'Este painel é atualizado automaticamente pelo bot.',
    ].join('\n'),
    color: mindustry.connected ? CHARACTER.palette.success : CHARACTER.palette.warning,
    presentation: 'compact',
  });
}

export async function ensureInteractiveHub(guild) {
  await guild.channels.fetch().catch(() => {});
  const info = guild.channels.cache.find((channel) => channel.name === '📌・como-funciona' && channel.isTextBased());
  const commands = guild.channels.cache.find((channel) => channel.name === '🧪・comandos-interativos' && channel.isTextBased());
  const status = guild.channels.cache.find((channel) => channel.name === '📡・status-interativo' && channel.isTextBased());

  const results = await Promise.all([
    upsertEmbed(info, INFO_MARKER, infoEmbed()),
    upsertEmbed(commands, COMMANDS_MARKER, commandsEmbed()),
    upsertEmbed(status, STATUS_MARKER, statusEmbed(guild.id)),
  ]);

  return {
    available: Boolean(info && commands && status),
    created: results.filter(Boolean).length,
  };
}
