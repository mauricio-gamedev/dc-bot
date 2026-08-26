# MiojoPlays Community Bot

Bot oficial para montar, padronizar e manter a comunidade Discord da MiojoPlays.

## Objetivo

O projeto foi desenhado para transformar um servidor vazio em uma comunidade organizada e pronta para crescer, sem depender de configuração manual canal por canal.

## Recursos atuais — v0.1

- `/setup` com confirmação antes de modificar o servidor.
- Setup idempotente: não duplica os cargos/canais gerenciados.
- `/repair` para restaurar itens ausentes e corrigir permissões.
- `/status` para verificar a integridade da estrutura.
- Categorias completas de início, comunidade, games, MiojoPlays, suporte, VIP, voz e staff.
- Cargos com hierarquia e permissões profissionais.
- Canais privados de Staff e VIP.
- Regras, boas-vindas, anúncios e informações iniciais em embeds.
- Sistema privado de tickets com botão de abrir/fechar.
- `/anuncio` para publicar comunicados oficiais.
- Moderação: `/limpar`, `/timeout`, `/kick` e `/ban`.
- Baseline de segurança: verificação Medium, filtro de conteúdo e notificações somente por menção.
- AFK configurado automaticamente.
- Entrada automática e autorole opcionais usando `ENABLE_MEMBER_EVENTS=true`.

## Requisitos

- Node.js 20 ou superior.
- Aplicação criada no Discord Developer Portal.
- Bot adicionado ao servidor.
- Durante o primeiro `/setup`, o bot deve possuir `Administrator` e o cargo do bot precisa estar acima dos cargos que ele gerencia.

## Variáveis de ambiente

Copie `.env.example` para `.env` em desenvolvimento local ou cadastre as variáveis no painel da hospedagem:

```env
DISCORD_TOKEN=token_do_bot
DISCORD_CLIENT_ID=id_da_aplicacao
DISCORD_GUILD_ID=id_do_servidor
ENABLE_MEMBER_EVENTS=false
```

Nunca publique `DISCORD_TOKEN` no GitHub.

`DISCORD_GUILD_ID` é recomendado porque registra os comandos diretamente no servidor e deixa as alterações disponíveis rapidamente.

## Instalação

```bash
npm install
npm start
```

## Primeiro uso

1. Inicie o bot.
2. Confirme que os slash commands apareceram.
3. Execute `/setup`.
4. Confirme em **Montar servidor**.
5. Depois use `/status` para validar a estrutura.

## Member Events opcional

Por padrão o bot não exige intents privilegiadas. Se quiser autorole de `👤・Membro` e mensagem automática quando alguém entrar:

1. Ative **Server Members Intent** no Discord Developer Portal.
2. Configure `ENABLE_MEMBER_EVENTS=true` no host.
3. Reinicie o bot.

## Segurança

- Nenhum token é armazenado no código.
- `.env` está ignorado pelo Git.
- A estrutura é reparável sem recriar tudo.
- Tickets são privados por permission overwrites.
- Comandos administrativos usam permissões nativas do Discord.

## Arquitetura

```text
src/
├─ index.js                  # runtime e eventos
├─ commands.js               # slash commands
└─ core/
   ├─ blueprint.js           # arquitetura do servidor
   ├─ guildBuilder.js        # setup/repair idempotente
   └─ tickets.js             # atendimento privado
```

## Roadmap

Próximas camadas planejadas: AutoMod nativo avançado, logs automáticos, sugestões com votação, integração de live Kick, cargos automáticos de apoiadores e painel de configuração.
