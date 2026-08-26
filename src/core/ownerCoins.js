import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { mutateProfile } from './communityStore.js';

const MAX_OWNER_COINS = 9_000_000_000_000;

export const ownerCoinCommandData = new SlashCommandBuilder()
  .setName('coins-dono')
  .setDescription('Controle exclusivo de MiojoCoins para o dono do servidor.')
  .addStringOption((option) =>
    option
      .setName('modo')
      .setDescription('Defina o saldo total ou adicione ao saldo atual.')
      .setRequired(true)
      .addChoices(
        { name: 'Definir saldo', value: 'set' },
        { name: 'Adicionar coins', value: 'add' },
      ),
  )
  .addIntegerOption((option) =>
    option
      .setName('quantidade')
      .setDescription('Quantidade de MiojoCoins.')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(MAX_OWNER_COINS),
  )
  .toJSON();

export async function handleOwnerCoinCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return false;
  if (interaction.commandName !== 'coins-dono') return false;

  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({
      content: '🔒 Este comando é exclusivo do dono real do servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const mode = interaction.options.getString('modo', true);
  const amount = interaction.options.getInteger('quantidade', true);

  const profile = await mutateProfile(interaction.guild, interaction.user.id, (data) => {
    const current = Number.isFinite(Number(data.coins)) ? Number(data.coins) : 0;
    data.coins = mode === 'set'
      ? amount
      : Math.min(MAX_OWNER_COINS, current + amount);
  }, { immediate: true });

  const action = mode === 'set' ? 'definido para' : 'atualizado para';
  await interaction.reply({
    content: `👑 Cofre do dono ${action} 🍜 **${profile.coins.toLocaleString('pt-BR')} MiojoCoins**.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
