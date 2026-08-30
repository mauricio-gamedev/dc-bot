import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getProfile } from './communityStore.js';
import {
  buildMemberCosmeticsEmbed,
  chatCosmeticChoices,
  clearChatCosmetic,
  equipChatCosmetic,
} from './chatCosmetics.js';

export const cosmeticCommandBuilder = new SlashCommandBuilder()
  .setName('distintivo')
  .setDescription('Gerencia o distintivo ou título exibido ao lado do seu nome no chat.')
  .addSubcommand((sub) => sub
    .setName('ver')
    .setDescription('Mostra os distintivos e títulos que você possui.'))
  .addSubcommand((sub) => sub
    .setName('equipar')
    .setDescription('Escolhe o símbolo que aparece ao lado do seu nome no chat.')
    .addStringOption((option) => option
      .setName('item')
      .setDescription('Escolha um distintivo desbloqueado ou título comprado.')
      .setRequired(true)
      .addChoices(...chatCosmeticChoices())))
  .addSubcommand((sub) => sub
    .setName('remover')
    .setDescription('Remove o símbolo do seu nome e desativa a equipagem automática.'));

export const cosmeticCommandData = cosmeticCommandBuilder.toJSON();

function nicknameFailureText(reason) {
  if (reason === 'guild_owner') {
    return 'O distintivo ficou salvo, mas o Discord não permite que bots alterem o apelido do dono do servidor. Para o dono, o formato precisa ser colocado manualmente no apelido.';
  }
  if (reason === 'role_hierarchy') {
    return 'O distintivo ficou salvo, mas meu cargo precisa estar acima do seu cargo mais alto para eu alterar seu apelido.';
  }
  return 'O distintivo ficou salvo, mas não consegui alterar seu apelido agora.';
}

export async function handleCosmeticCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;
  if (interaction.commandName !== 'distintivo') return false;

  const sub = interaction.options.getSubcommand();
  if (sub === 'ver') {
    const profile = await getProfile(interaction.guild, interaction.user.id);
    await interaction.reply({
      embeds: [buildMemberCosmeticsEmbed(profile)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'equipar') {
    const item = interaction.options.getString('item', true);
    const result = await equipChatCosmetic(interaction.guild, interaction.user.id, item);
    if (!result.ok) {
      const content = result.reason === 'not_owned'
        ? '🔒 Você ainda não possui esse item. Distintivos vêm de conquistas e títulos são comprados na `/loja`.'
        : 'Não consegui encontrar esse cosmético.';
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return true;
    }

    const applied = result.nickname?.ok;
    await interaction.reply({
      content: applied
        ? `✅ ${result.cosmetic.symbol} **${result.cosmetic.label}** equipado. Seu nome no chat agora fica como \`${result.nickname.nickname}\`.`
        : `✅ ${result.cosmetic.symbol} **${result.cosmetic.label}** equipado no perfil. ${nicknameFailureText(result.nickname?.reason)}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (sub === 'remover') {
    const result = await clearChatCosmetic(interaction.guild, interaction.user.id);
    await interaction.reply({
      content: result.nickname?.ok === false
        ? `✅ Distintivo desativado no perfil. ${nicknameFailureText(result.nickname.reason)}`
        : '✅ Distintivo removido. Seu apelido normal foi restaurado.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}
