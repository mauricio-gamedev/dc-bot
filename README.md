# MiojoPlays Community Bot

Bot oficial para montar, padronizar, proteger e evoluir a comunidade Discord da MiojoPlays.

## Recursos atuais — v0.3

### 🐈‍⬛ Mio — personagem oficial
- **Mio**, o gato dark/neon da MiojoPlays, agora é a identidade visual oficial do bot.
- A arte oficial está empacotada em `assets/mio-character.webp` e é usada como thumbnail dos embeds do personagem.
- `/mascote` usa a personalidade própria do Mio: madura, dark, carismática e levemente sarcástica.
- Mio aparece em perfil, daily, level-up, boas-vindas, loja, missões e conquistas.
- A identidade visual foi centralizada em `src/core/character.js`, evitando estilos diferentes entre comandos.
- É possível substituir avatar/banner por URL através das variáveis opcionais `MIO_CHARACTER_*`, sem alterar o código.

### ✨ Progressão e perfil
- XP e níveis por participação com cooldown anti-spam.
- Bônus de nível em **MiojoCoins**.
- `/daily` com sequência diária.
- `/perfil [membro]` mostra nível, XP, moedas, reputação, posição, título equipado e conquistas.
- `/ranking` por XP, MiojoCoins, reputação ou conquistas.
- `/rep` com cooldown de 24 horas.
- Missão de mensagens só avança junto do cooldown válido de XP, evitando farm por spam.

### 🍜 Loja, títulos e economia
- `/loja` mostra itens e saldo.
- `/comprar` usa opções nativas do Discord para comprar títulos com MiojoCoins.
- `/titulo` equipa um título comprado ou remove o título atual.
- Títulos iniciais: **Noturno**, **Veterano Neon**, **Guardião da Base** e **Miojo Lendário**.
- Inventário, títulos e saldo são persistentes.

### 🎯 Missões e conquistas
- `/missoes` mostra objetivos diários.
- `/missao` coleta recompensas concluídas.
- Missões iniciais: participação válida no chat, daily e reputação.
- `/conquistas [membro]` mostra badges desbloqueadas e bloqueadas.
- Conquistas iniciais cobrem atividade, níveis, moedas, reputação e sequência diária.
- Novas conquistas concedem bônus de MiojoCoins.

### 🎭 Auto-cargos
- Painel de cargos por botão no canal `🎭・cargos`.
- Cargos auto-selecionáveis: Games, Lives, Eventos e Minecraft.
- O membro pode ativar ou remover o próprio cargo sem intervenção da staff.

### 💡 Sugestões com votação
- `/sugerir` publica a ideia no canal oficial.
- Votação real pelas reações 👍 e 👎 do Discord.
- Staff pode marcar a sugestão como **Em análise**, **Aprovada** ou **Rejeitada**.

### 🛡️ Estrutura, segurança e administração
- `/setup` com confirmação e execução idempotente.
- `/repair` restaura itens ausentes e aplica expansões sem duplicar estrutura.
- `/status` valida cargos, categorias, canais e AutoMod.
- AutoMod nativo anti-spam e proteção contra raid de menções.
- Logs automáticos de entradas/saídas, bans, canais, cargos e ações administrativas.
- Sistema privado de tickets.
- `/anuncio`, `/limpar`, `/timeout`, `/kick` e `/ban`.
- Verificação Medium, filtro de conteúdo, notificações por menção e AFK automático.

### 🗄️ Persistência sem banco pago
Os perfis continuam armazenados em `🗄️・bot-data`, um canal privado criado e gerenciado pelo próprio bot. XP, economia, títulos, inventário, missões e conquistas sobrevivem a reinícios e redeploys sem depender do disco temporário da hospedagem.

A migração da v0.2 para a v0.3 é compatível: dados antigos recebem automaticamente os novos campos com valores padrão.

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

# Opcionais: o asset oficial já funciona sem configurar estas URLs.
MIO_CHARACTER_IMAGE_URL=
MIO_CHARACTER_BANNER_URL=
MIO_CHARACTER_PROFILE_URL=
```

Nunca publique `DISCORD_TOKEN` no GitHub.

## Atualização de servidor existente

1. Deixe a hospedagem concluir o redeploy da `main`.
2. Execute `/repair` uma vez para criar os novos cargos/canais da v0.3.
3. Execute `/status` para validar a estrutura.
4. Teste `/mascote`, `/perfil`, `/loja`, `/missoes`, `/conquistas` e `/sugerir`.

O processo de reparo é idempotente: repetir `/repair` não deve criar cópias dos itens gerenciados.

## Arquitetura

```text
assets/
└─ mio-character.webp        # arte oficial otimizada do Mio
src/
├─ index.js                  # runtime, health, eventos e bootstrap
├─ commands.js               # slash commands existentes + integração v0.3
└─ core/
   ├─ blueprint.js           # cargos/canais/estrutura
   ├─ guildBuilder.js        # setup e repair idempotente
   ├─ tickets.js
   ├─ automod.js
   ├─ logging.js
   ├─ communityStore.js      # persistência dos perfis
   ├─ progression.js         # XP, daily, rep e ranking
   ├─ character.js           # identidade visual/persona do Mio
   └─ communityV3.js         # loja, títulos, missões, conquistas, sugestões e auto-cargos
```

## Próximas expansões

Integração automática com live da Kick, cargos de apoiadores, itens cosméticos adicionais, eventos sazonais e painel administrativo.
