import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { characterEmbed, CHARACTER } from './character.js';
import { equipTitle } from './communityV3.js';
import { resolveProfileSeal } from './personalSeals.js';
import { reconcileIdentityRoles, syncTitleDisplayRole } from './identityDisplay.js';

export const identityCommandBuilder = new SlashCommandBuilder()
  .setName('identidade')
  .setDescription('Mostra e sincroniza seu título e selo visíveis no Discord.');

export const identityCommandData = identityCommandBuilder.toJSON();

export async function handleIdentityCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;

  if (interaction.commandName === 'titulo') {
    const title = interaction.options.getString('equipar', true);
    const result = await equipTitle(interaction.guild, interaction.user.id, title);
    if (!result.ok) {
      await interaction.reply({
        content: 'Você ainda não possui esse título. Veja `/loja`.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const roleSync = await syncTitleDisplayRole(
      interaction.guild,
      interaction.user.id,
      result.profile,
    ).catch((error) => ({ ok: false, reason: error.message }));

    await interaction.reply({
      content: [
        `✅ Título equipado: **${result.profile.title}**`,
        roleSync.ok
          ? roleSync.target
            ? `🏷️ Cargo cosmético sincronizado: **${roleSync.target}**.`
            : '🏷️ Cargo cosmético removido.'
          : '⚠️ O título foi salvo, mas o cargo visual ainda não pôde ser sincronizado. O cargo do bot precisa ficar acima dos cargos cosméticos.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.commandName !== 'identidade') return false;

  const sealState = await resolveProfileSeal(interaction.guild, interaction.user.id);
  const sync = await reconcileIdentityRoles(
    interaction.guild,
    interaction.user.id,
    sealState.profile,
  ).catch((error) => ({ error: error.message }));

  const syncOk = !sync.error && sync.title?.ok !== false && sync.seal?.ok !== false;
  const syncStatus = sync.error
    ? `⚠️ Sincronização visual: ${sync.error}`
    : syncOk
      ? '✅ Título e selo foram reconciliados com os cargos cosméticos do Discord.'
      : '⚠️ Título/selo estão salvos, mas a hierarquia do Discord bloqueou um dos cargos cosméticos. Deixe o cargo do bot acima deles.';

  await interaction.reply({
    embeds: [characterEmbed({
      title: '✨ Identidade MiojoPlays',
      description: [
        `🏷️ **Título:** ${sealState.profile.title || 'Sem título'}`,
        `✨ **Selo:** ${sealState.equipped?.label ?? 'Nenhum equipado'}`,
        '',
        syncStatus,
        '',
        'Use `/titulo` para trocar o título e `/selo equipar` para trocar o selo.',
      ].join('\n'),
      color: CHARACTER.palette.accent,
      presentation: sealState.equipped ? 'badge' : 'compact',
      seal: sealState.equipped ? 'animated' : 'static',
    })],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
