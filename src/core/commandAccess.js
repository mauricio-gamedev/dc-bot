import { MessageFlags, PermissionFlagsBits } from 'discord.js';

const DEFAULT_COOLDOWN_MS = 2_000;
const SUGGESTION_COOLDOWN_MS = 30_000;

const commandCooldowns = new Map();

const OWNER_ONLY_COMMANDS = new Set([
  'coins-dono',
  'kickbot',
  'voz',
]);

const PERMISSION_COMMANDS = new Map([
  ['setup', PermissionFlagsBits.Administrator],
  ['repair', PermissionFlagsBits.Administrator],
  ['status', PermissionFlagsBits.ManageGuild],
  ['anuncio', PermissionFlagsBits.ManageGuild],
  ['evento', PermissionFlagsBits.ManageGuild],
  ['limpar', PermissionFlagsBits.ManageMessages],
  ['timeout', PermissionFlagsBits.ModerateMembers],
  ['kick', PermissionFlagsBits.KickMembers],
  ['ban', PermissionFlagsBits.BanMembers],
]);

const OWNER_SUBCOMMANDS = new Map([
  ['game', new Set(['conectar', 'abrir', 'fechar'])],
  ['mindustry', new Set(['vincular', 'abrir', 'fechar'])],
]);

function ownerOnly(interaction) {
  return Boolean(interaction.guild?.ownerId && interaction.user.id === interaction.guild.ownerId);
}

function subcommandName(interaction) {
  try {
    return interaction.options.getSubcommand(false) || null;
  } catch {
    return null;
  }
}

function hasPermission(interaction, permission) {
  return Boolean(interaction.memberPermissions?.has(permission));
}

function cooldownFor(interaction) {
  if (interaction.commandName === 'sugerir') return SUGGESTION_COOLDOWN_MS;
  return DEFAULT_COOLDOWN_MS;
}

function cleanupCooldowns(now = Date.now()) {
  if (commandCooldowns.size < 2_000) return;
  for (const [key, expiresAt] of commandCooldowns) {
    if (expiresAt <= now) commandCooldowns.delete(key);
  }
}

async function deny(interaction, content) {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

export async function enforceCommandAccess(interaction, { guildId = null } = {}) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return true;

  if (guildId && interaction.guild.id !== guildId) {
    await deny(interaction, '🔒 Este bot é privado e só funciona no servidor oficial configurado.');
    return false;
  }

  const isOwner = ownerOnly(interaction);
  if (!isOwner) {
    if (OWNER_ONLY_COMMANDS.has(interaction.commandName)) {
      await deny(interaction, '🔒 Este comando é exclusivo do dono real do servidor.');
      return false;
    }

    const requiredPermission = PERMISSION_COMMANDS.get(interaction.commandName);
    if (requiredPermission && !hasPermission(interaction, requiredPermission)) {
      await deny(interaction, '🛡️ Você não tem a permissão necessária para usar este comando.');
      return false;
    }

    const protectedSubcommands = OWNER_SUBCOMMANDS.get(interaction.commandName);
    const subcommand = subcommandName(interaction);
    if (protectedSubcommands?.has(subcommand)) {
      await deny(interaction, '🔒 Essa ação é exclusiva do dono real do servidor.');
      return false;
    }
  }

  const now = Date.now();
  cleanupCooldowns(now);
  const cooldownMs = cooldownFor(interaction);
  const key = `${interaction.guild.id}:${interaction.user.id}:${interaction.commandName}`;
  const expiresAt = commandCooldowns.get(key) || 0;

  if (now < expiresAt) {
    const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    await deny(interaction, `⏳ Aguarda **${seconds}s** antes de usar esse comando novamente.`);
    return false;
  }

  commandCooldowns.set(key, now + cooldownMs);
  return true;
}

export function memberCommandGuideDescription() {
  return [
    '**👤 Perfil e progressão**',
    '`/perfil` — mostra seu perfil ou o de outro membro.',
    '`/daily` — coleta a recompensa diária.',
    '`/rep` — dá reputação para outro membro.',
    '`/ranking` — mostra os rankings da comunidade.',
    '',
    '**🍜 Economia e identidade**',
    '`/loja` — abre a loja de MiojoCoins.',
    '`/comprar` — compra um item da loja.',
    '`/titulo` — equipa um título comprado.',
    '`/missoes` — mostra suas missões diárias.',
    '`/missao` — coleta uma missão concluída.',
    '`/conquistas` — mostra conquistas e badges.',
    '`/selos` e `/selo` — consulta e equipa seus selos.',
    '`/identidade` — sincroniza título e selo visíveis.',
    '',
    '**💬 Comunidade**',
    '`/mascote` — conversa com o Mio.',
    '`/sugerir` — envia uma sugestão para votação.',
    '',
    '**🎮 Integrações quando estiverem ativas**',
    '`/game status` e `/game acao` — Minecraft Interactive.',
    '`/mindustry status` e `/mindustry acao` — Mindustry Interactive.',
    '',
    '🔒 Comandos de administração, moderação, vínculo, voz e configuração são protegidos e não fazem parte da lista de membros.',
  ].join('\n');
}
