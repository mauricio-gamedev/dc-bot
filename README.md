# MiojoPlays Community Bot

Bot oficial para montar, padronizar, proteger e evoluir a comunidade Discord da MiojoPlays.

## Recursos atuais — v0.2

### Estrutura e administração
- `/setup` com confirmação e execução idempotente.
- `/repair` restaura itens ausentes e corrige permissões sem duplicar estrutura.
- `/status` valida cargos, categorias, canais e AutoMod.
- Categorias completas de início, comunidade, games, MiojoPlays, suporte, VIP, voz e staff.
- Sistema privado de tickets.
- `/anuncio`, `/limpar`, `/timeout`, `/kick` e `/ban`.

### Segurança e logs
- AutoMod nativo anti-spam.
- Proteção contra raid de menções.
- Logs automáticos de entradas/saídas, bans, canais, cargos e ações administrativas.
- Verificação Medium, filtro de conteúdo e notificações somente por menção.
- AFK configurado automaticamente.

### Sistema de comunidade / mascote
- XP e níveis por participação, com cooldown para não premiar spam.
- Bônus de nível em **MiojoCoins**.
- `/daily` com sequência diária.
- `/perfil [membro]` com XP, nível, moedas, reputação e posição.
- `/ranking` por XP, MiojoCoins ou reputação.
- `/rep` com cooldown de 24 horas.
- `/mascote` com a persona própria da MiojoPlays.
- Anúncios de level-up com identidade dark/roxa e o avatar do próprio bot.

### Persistência sem banco pago
Os perfis são armazenados em `🗄️・bot-data`, um canal privado criado e gerenciado pelo próprio bot. Assim os dados de XP/economia sobrevivem a reinícios e redeploys da hospedagem gratuita sem depender do disco temporário do Render.

## Requisitos

- Node.js 20 ou superior.
- Aplicação criada no Discord Developer Portal.
- Bot adicionado ao servidor.
- `Server Members Intent` ativada quando `ENABLE_MEMBER_EVENTS=true`.
- Durante `/setup` e `/repair`, o bot deve possuir `Administrator` e o cargo do bot precisa estar acima dos cargos gerenciados.

## Variáveis de ambiente

```env
DISCORD_TOKEN=token_do_bot
DISCORD_CLIENT_ID=id_da_aplicacao
DISCORD_GUILD_ID=id_do_servidor
ENABLE_MEMBER_EVENTS=true
```

Nunca publique `DISCORD_TOKEN` no GitHub.

## Instalação

```bash
npm install
npm start
```

## Primeiro uso / atualização

1. Inicie ou redeploye o bot.
2. Confirme que os slash commands apareceram.
3. Em servidor novo, execute `/setup`.
4. Em servidor já configurado, execute `/repair` para aplicar a expansão nova.
5. Execute `/status` para validar a estrutura.

## Arquitetura

```text
src/
├─ index.js
├─ commands.js
└─ core/
   ├─ blueprint.js
   ├─ guildBuilder.js
   ├─ tickets.js
   ├─ automod.js
   ├─ logging.js
   ├─ communityStore.js
   └─ progression.js
```

## Próximas expansões

Sugestões com votação, cargos por botões, integração de live Kick, loja de MiojoCoins, conquistas, missões e painel administrativo.
