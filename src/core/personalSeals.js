import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getProfile, mutateProfile } from './communityStore.js';
import { characterEmbed, CHARACTER } from './character.js';
import { syncSealDisplayRole } from './identityDisplay.js';

export const SEALS = Object.freeze({
  founder: {
    id: 'founder',
    label: '👑 Fundador MiojoPlays',
    short: '👑 Fundador',
    description: 'Selo exclusivo do dono real do servidor.',
  },
  official: {
    id: 'official',
    label: '💜 Oficial MiojoPlays',
    short: '💜 Oficial',
    description: 'Identidade oficial da comunidade MiojoPlays.',
  },
  vip: {
    id: 'vip',
    label: '💎 VIP MiojoPlays',
    short: '💎 VIP',
    description: 'Disponível enquanto o membro possuir o cargo VIP.',
  },
  sub: {
    id: 'sub',
    label: '⭐ Sub MiojoPlays',
    short: '⭐ Sub',
    description: 'Disponível enquanto o membro possuir o cargo Sub.',
  },
  supporter: {
    id: 'supporter',
    label: '🤝 Supporter MiojoPlays',
    short: '🤝 Supporter',
    description: 'Reconhecimento visual para apoiadores da comunidade.',
  },
  live: {
    id: 'live',
    label: '🔴 Presença em Live',
    short: '🔴 Live',
    description: 'Desbloqueado após registrar presença em uma live oficial.',
  },
  event: {
    id: 'event',
    label: '🎟️ Evento Oficial',
    short: '🎟️ Evento',
    description: 'Desbloqueado após participar de um evento oficial.',
  },
});

const sealChoices = Object.values(SEALS).map((seal) => ({
  name: seal.label,
  value: seal.id,
}));

export const sealCommandBuilders = [
  new SlashCommandBuilder()
    .setName('selos')
    .setDescription('Mostra seus selos disponíveis e o selo equipado.'),
  new SlashCommandBuilder()
    .setName('selo')
    .setDescription('Gerencia o selo exibido no seu perfil.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('equipar')
        .setDescription('Equipa um selo disponível no seu perfil.')
        .addStringOption((option) =>
          option
            .setName('selo')
            .setDescription('Escolha o selo que deseja equipar.')
            .setRequired(true)
            .addChoices(...sealChoices),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remover')
        .setDescription('Remove o selo atualmente equipado.'),
    ),
];

export const sealCommandData = sealCommandBuilders.map((builder) => builder.toJSON());

function hasRole(member, roleName) {
  return Boolean(member?.roles?.cache?.some((role) => role.name === roleName));
}

function normalizedOwned(profile) {
  if (!Array.isArray(profile?.ownedSeals)) return [];
  return [...new Set(profile.ownedSeals.filter((id) => typeof id === 'string' && SEALS[id]))];
}

export function availableSealIds(guild, member, profile) {
  const available = new Set(normalizedOwned(profile));

  if (guild?.ownerId && member?.id === guild.ownerId) {
    available.add('founder');
    available.add('official');
  }

  const vip = hasRole(member, '💎・VIP');
  const sub = hasRole(member, '⭐・Sub');
  if (vip) available.add('vip');
  if (sub) available.add('sub');
  if (vip || sub) available.add('supporter');
  if ((profile?.liveAttendanceCount || 0) > 0) available.add('live');
  if ((profile?.eventParticipationCount || 0) > 0) available.add('event');

  return [...available].filter((id) => SEALS[id]);
}

export async function resolveProfileSeal(guild, userId) {
  const profile = await getProfile(guild, userId);
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  const availableIds = availableSealIds(guild, member, profile);
  let equippedId = typeof profile.equippedSeal === 'string' && SEALS[profile.equippedSeal]
    ? profile.equippedSeal
    : '';

  if (equippedId && !availableIds.includes(equippedId)) {
    equippedId = '';
    await mutateProfile(guild, userId, (data) => {
      data.equippedSeal = '';
    }, { immediate: true });
  }

  const normalizedProfile = await getProfile(guild, userId);
  await syncSealDisplayRole(guild, userId, normalizedProfile).catch((error) => {
    console.warn(`Seal display sync ${userId}: ${error.message}`);
  });

  return {
    profile: normalizedProfile,
    member,
    availableIds,
    equippedId,
    equipped: equippedId ? SEALS[equippedId] : null,
  };
}

function sealsDescription(availableIds, equippedId) {
  if (!availableIds.length) {
    return 'Você ainda não desbloqueou nenhum selo. Participe de lives/eventos ou conquiste cargos especiais.';
  }

  return availableIds
    .map((id) => {
      const seal = SEALS[id];
      const marker = id === equippedId ? ' **• EQUIPADO**' : '';
      return `${seal.label}${marker}\n> ${seal.description}`;
    })
    .join('\n\n');
}

export async function handleSealCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;
  if (!['selos', 'selo'].includes(interaction.commandName)) return false;

  const state = await resolveProfileSeal(interaction.guild, interaction.user.id);

  if (interaction.commandName === 'selos') {
    await interaction.reply({
      embeds: [characterEmbed({
        title: '✨ Seus selos MiojoPlays',
        description: [
          state.equipped ? `**Equipado agora:** ${state.equipped.label}` : '**Equipado agora:** nenhum',
          '',
          sealsDescription(state.availableIds, state.equippedId),
          '',
          'Use `/selo equipar` para escolher qual aparece no seu perfil e como cargo cosmético.',
        ].join('\n'),
        color: CHARACTER.palette.accent,
        presentation: state.equipped ? 'badge' : 'compact',
        seal: state.equipped ? 'animated' : 'static',
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'remover') {
    if (!state.equippedId) {
      await interaction.reply({
        content: 'Você não tem nenhum selo equipado no momento.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const profile = await mutateProfile(interaction.guild, interaction.user.id, (data) => {
      data.equippedSeal = '';
    }, { immediate: true });
    await syncSealDisplayRole(interaction.guild, interaction.user.id, profile).catch(() => {});

    await interaction.reply({
      content: '✅ Selo removido do seu perfil e do cargo cosmético.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (subcommand === 'equipar') {
    const sealId = interaction.options.getString('selo', true);
    const seal = SEALS[sealId];
    if (!seal || !state.availableIds.includes(sealId)) {
      await interaction.reply({
        content: '🔒 Esse selo ainda não está disponível para você. Use `/selos` para ver os desbloqueados.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const profile = await mutateProfile(interaction.guild, interaction.user.id, (data) => {
      data.equippedSeal = sealId;
    }, { immediate: true });
    const roleSync = await syncSealDisplayRole(interaction.guild, interaction.user.id, profile)
      .catch((error) => ({ ok: false, reason: error.message }));

    await interaction.reply({
      embeds: [characterEmbed({
        title: '✅ Selo equipado',
        description: [
          seal.label,
          '',
          'Agora esse selo aparece no seu perfil MiojoPlays.',
          roleSync.ok
            ? '✨ O cargo cosmético visível também foi sincronizado.'
            : '⚠️ O selo foi salvo, mas o cargo visual depende da hierarquia do bot no servidor.',
        ].join('\n'),
        color: CHARACTER.palette.accent,
        presentation: 'badge',
        seal: 'animated',
      })],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return true;
}
