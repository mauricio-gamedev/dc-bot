import { ChannelType, PermissionFlagsBits } from 'discord.js';

export const BRAND = {
  name: 'MiojoPlays Community',
  color: 0x8b5cf6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  footer: 'MiojoPlays • Community System',
};

export const ROLE_BLUEPRINT = [
  {
    name: '👑・Administração',
    color: 0x7c3aed,
    hoist: true,
    mentionable: false,
    permissions: [PermissionFlagsBits.Administrator],
  },
  {
    name: '🛡️・Moderador',
    color: 0xef4444,
    hoist: true,
    mentionable: true,
    permissions: [
      PermissionFlagsBits.ViewAuditLog,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageNicknames,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.DeafenMembers,
      PermissionFlagsBits.MoveMembers,
    ],
  },
  {
    name: '🎫・Suporte',
    color: 0x0ea5e9,
    hoist: true,
    mentionable: true,
    permissions: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  },
  {
    name: '🎥・Criador',
    color: 0xec4899,
    hoist: true,
    mentionable: true,
    permissions: [],
  },
  {
    name: '💎・VIP',
    color: 0xa855f7,
    hoist: true,
    mentionable: true,
    permissions: [],
  },
  {
    name: '⭐・Sub',
    color: 0x22c55e,
    hoist: false,
    mentionable: true,
    permissions: [],
  },
  {
    name: '🤖・Bots',
    color: 0x64748b,
    hoist: false,
    mentionable: false,
    permissions: [],
  },
  {
    name: '👤・Membro',
    color: 0x94a3b8,
    hoist: false,
    mentionable: false,
    permissions: [],
  },
];

export const CATEGORY_BLUEPRINT = [
  {
    name: '📌・INÍCIO',
    channels: [
      { name: '👋・boas-vindas', type: ChannelType.GuildText, readOnly: true, topic: 'Comece por aqui. Informações essenciais da comunidade MiojoPlays.' },
      { name: '📜・regras', type: ChannelType.GuildText, readOnly: true, topic: 'Regras oficiais da comunidade.' },
      { name: '📢・anúncios', type: ChannelType.GuildText, readOnly: true, topic: 'Novidades, atualizações e comunicados importantes.' },
      { name: '🎭・cargos', type: ChannelType.GuildText, readOnly: true, topic: 'Informações sobre cargos e benefícios da comunidade.' },
    ],
  },
  {
    name: '💬・COMUNIDADE',
    channels: [
      { name: '💬・geral', type: ChannelType.GuildText, topic: 'Conversa principal da comunidade.' },
      { name: '🙋・apresentações', type: ChannelType.GuildText, topic: 'Chegou agora? Se apresente para a comunidade.' },
      { name: '📸・mídia', type: ChannelType.GuildText, topic: 'Prints, fotos, artes e outros conteúdos da comunidade.' },
      { name: '🎬・clips', type: ChannelType.GuildText, topic: 'Clipes e momentos marcantes.' },
      { name: '😂・memes', type: ChannelType.GuildText, topic: 'Memes e conteúdo descontraído.' },
      { name: '💡・sugestões', type: ChannelType.GuildText, topic: 'Sugestões para melhorar o servidor e as lives.' },
      { name: '🏆・ranking', type: ChannelType.GuildText, readOnly: true, topic: 'Ranking de XP, reputação e MiojoCoins da comunidade.' },
    ],
  },
  {
    name: '🎮・GAMES',
    channels: [
      { name: '🎮・jogos-geral', type: ChannelType.GuildText, topic: 'Conversa sobre jogos em geral.' },
      { name: '🧩・procurando-grupo', type: ChannelType.GuildText, topic: 'Encontre pessoas para jogar junto.' },
      { name: '⛏️・minecraft', type: ChannelType.GuildText, topic: 'Minecraft, servidores, mods e projetos da comunidade.' },
    ],
  },
  {
    name: '📺・MIOJOPLAYS',
    channels: [
      { name: '🔴・live-agora', type: ChannelType.GuildText, readOnly: true, topic: 'Avisos automáticos quando MiojoPlays estiver ao vivo.' },
      { name: '💭・chat-da-live', type: ChannelType.GuildText, topic: 'Continue a conversa da live por aqui.' },
      { name: '🗓️・agenda', type: ChannelType.GuildText, readOnly: true, topic: 'Agenda, eventos e próximos conteúdos.' },
      { name: '🏆・melhores-momentos', type: ChannelType.GuildText, topic: 'Melhores momentos das lives e da comunidade.' },
      { name: '💙・apoie-a-live', type: ChannelType.GuildText, readOnly: true, topic: 'Formas oficiais de apoiar o canal e a comunidade.' },
    ],
  },
  {
    name: '🛠️・SUPORTE',
    channels: [
      { name: '❓・ajuda', type: ChannelType.GuildText, topic: 'Dúvidas rápidas e ajuda da comunidade.' },
      { name: '🎫・abrir-ticket', type: ChannelType.GuildText, readOnly: true, topic: 'Abra um atendimento privado com a equipe.' },
    ],
  },
  {
    name: '💎・VIP',
    vipOnly: true,
    channels: [
      { name: '💎・vip-chat', type: ChannelType.GuildText, topic: 'Chat exclusivo para membros VIP.' },
      { name: '👑・vip-lounge', type: ChannelType.GuildVoice },
    ],
  },
  {
    name: '🔊・VOZ',
    channels: [
      { name: '🔊・Geral', type: ChannelType.GuildVoice },
      { name: '🎮・Gameplay 1', type: ChannelType.GuildVoice },
      { name: '🎮・Gameplay 2', type: ChannelType.GuildVoice },
      { name: '💤・AFK', type: ChannelType.GuildVoice },
    ],
  },
  {
    name: '🔒・STAFF',
    staffOnly: true,
    channels: [
      { name: '🛡️・staff-chat', type: ChannelType.GuildText, topic: 'Comunicação interna da equipe.' },
      { name: '📋・mod-logs', type: ChannelType.GuildText, readOnly: true, topic: 'Registro automático de ações administrativas e segurança.' },
      { name: '📥・member-logs', type: ChannelType.GuildText, readOnly: true, topic: 'Entradas e saídas registradas automaticamente.' },
      { name: '🚨・denúncias', type: ChannelType.GuildText, topic: 'Triagem interna de denúncias e ocorrências.' },
      { name: '🤖・bot-comandos', type: ChannelType.GuildText, topic: 'Canal reservado para comandos e manutenção do bot.' },
      { name: '🗄️・bot-data', type: ChannelType.GuildText, systemOnly: true, topic: 'Persistência interna do bot. Não edite nem apague mensagens deste canal.' },
      { name: '🔒・Staff', type: ChannelType.GuildVoice },
    ],
  },
];

export const STAFF_ROLE_NAMES = ['👑・Administração', '🛡️・Moderador', '🎫・Suporte'];
export const VIP_ROLE_NAMES = ['👑・Administração', '🛡️・Moderador', '💎・VIP'];
