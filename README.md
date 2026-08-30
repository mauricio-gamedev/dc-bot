# MiojoPlays Community Bot

Bot privado da comunidade Discord da MiojoPlays, responsável por estrutura, moderação, progressão, economia, identidade, eventos e integrações de live/jogos.

## Segurança e operação privada

O bot agora trabalha em **modo de servidor único**:

- `DISCORD_GUILD_ID` é obrigatório;
- slash commands são registrados somente no servidor configurado;
- se o bot for colocado em outro servidor, ele sai automaticamente;
- interações e progressão fora do servidor oficial são ignoradas/bloqueadas;
- comandos sensíveis passam por uma camada central de autorização antes dos handlers;
- ações de dono, staff e moderação continuam com validações próprias como segunda camada;
- comandos recebem cooldown básico contra abuso e `/sugerir` possui cooldown maior;
- `/coins-dono` também fica oculto de membros comuns pelas permissões nativas do Discord;
- respostas de negação e erros operacionais são privadas quando apropriado.

A configuração no Discord Developer Portal deve continuar com o bot **não público** e sem link padrão de instalação.

## 🛡️ Proteções da comunidade

- AutoMod nativo anti-spam;
- proteção contra raid de menções, com bloqueio e timeout;
- filtro de conteúdo explícito para todos os membros;
- nível de verificação `Medium`;
- logs de moderação, membros e ocorrências;
- canais Staff/VIP isolados por permission overwrites;
- persistência interna em `🗄️・bot-data`, invisível para membros comuns;
- tickets privados;
- comandos administrativos protegidos por dono/permissões do Discord.

## 🤖 Guia de comandos para membros

O bot garante automaticamente o canal somente leitura:

`🤖・comandos`

Ele fica em `📌・INÍCIO` e mostra apenas comandos apropriados para membros, organizados por categoria. O painel é atualizado pelo bot sem duplicar mensagens.

Principais comandos de membros:

- Perfil: `/perfil`, `/daily`, `/rep`, `/ranking`;
- Economia: `/loja`, `/comprar`, `/titulo`;
- Progressão: `/missoes`, `/missao`, `/conquistas`;
- Identidade: `/selos`, `/selo`, `/identidade`;
- Comunidade: `/mascote`, `/sugerir`;
- Game Interactive, quando ativo: `/game status`, `/game acao`, `/mindustry status`, `/mindustry acao`;
- Mio Voice para consulta: `/voz status`, `/voz personagens`.

Comandos de setup, reparo, moderação, publicação, vínculo e configuração não são apresentados como comandos de membros e são bloqueados no runtime quando o usuário não possui autorização.

## 🐈‍⬛ Mio — identidade sem imagem nos embeds

**Mio** continua sendo o personagem/guardião textual da MiojoPlays, mas a imagem do personagem foi desativada nos embeds da comunidade porque ela estava aparecendo cinza em alguns clientes do Discord.

O bot também executa uma limpeza segura nas mensagens recentes que ele próprio publicou nos canais gerenciados e remove referências antigas a `mio-character` de imagem/thumbnail. Mensagens de usuários não são alteradas.

Selos opcionais continuam podendo ser usados separadamente quando houver assets válidos configurados.

## ✨ Progressão e perfil

- XP e níveis por participação válida, com cooldown anti-spam;
- bônus de nível em **MiojoCoins**;
- `/daily` com sequência diária;
- `/perfil [membro]` com nível, XP, moedas, reputação, título e conquistas;
- `/ranking` por XP, MiojoCoins, reputação ou conquistas;
- `/rep` com proteção contra auto-reputação e cooldown;
- missões e conquistas persistentes.

## 🍜 Loja, títulos e identidade

- `/loja` mostra itens e saldo;
- `/comprar` compra títulos com MiojoCoins;
- `/titulo` equipa ou remove título;
- `/selos` e `/selo` gerenciam selos elegíveis;
- `/identidade` reconcilia título/selo com cargos cosméticos;
- inventário e economia persistem após reinícios.

## 🎭 Auto-cargos e comunidade

O painel `🎭・cargos` permite ao membro ativar/remover cargos permitidos, como Games, Lives, Eventos e Minecraft, sem receber permissões administrativas.

Sugestões usam `/sugerir`, votação por reação e botões de status protegidos para a staff.

## 🎮 Integrações

O projeto mantém as integrações existentes sem abrir seus controles privados para membros:

- Minecraft Bedrock Game Interactive;
- Mindustry Interactive;
- Kick Live / Kick Chat Interactive;
- Mio Voice Android;
- agenda e participação em eventos.

Subcomandos que vinculam contas/dispositivos, abrem ou fecham sessões e alteram configurações permanecem exclusivos do dono quando previsto pelo módulo.

## Estrutura gerenciada

`/setup` monta a estrutura inicial e `/repair` verifica/repara os itens gerenciados de forma idempotente. `/status` valida cargos, categorias, canais e AutoMod.

A estrutura inclui áreas de início, comunidade, games, interações, MiojoPlays, suporte, VIP, voz e Staff, além de logs e persistência privada.

## Requisitos

- Node.js 20 ou superior;
- aplicação criada no Discord Developer Portal;
- bot instalado somente no servidor oficial;
- `DISCORD_GUILD_ID` configurado obrigatoriamente;
- `Server Members Intent` ativada quando `ENABLE_MEMBER_EVENTS=true`;
- durante `/setup` e `/repair`, o bot precisa de `Administrator` e seu cargo deve ficar acima dos cargos que gerencia.

## Variáveis principais

```env
DISCORD_TOKEN=token_do_bot
DISCORD_CLIENT_ID=id_da_aplicacao
DISCORD_GUILD_ID=id_do_servidor_oficial
ENABLE_MEMBER_EVENTS=true

# opcionais: somente selos; a imagem do personagem está desativada
MIO_BADGE_IMAGE_URL=
MIO_BADGE_ANIMATED_URL=
```

Nunca publique tokens, chaves de bridge, credenciais OAuth ou outros segredos no GitHub ou em canais públicos do Discord.

## Atualização de servidor existente

1. Aguarde o redeploy da `main` terminar.
2. O bootstrap garante o canal `🤖・comandos` e remove imagens antigas do Mio das mensagens recentes gerenciadas.
3. Execute `/repair` uma vez para aplicar/confirmar a estrutura atualizada.
4. Execute `/status` para validar canais, cargos e AutoMod.
5. Teste um comando de membro e um comando restrito com uma conta sem privilégios para confirmar a separação.

## Arquitetura relevante

```text
src/
├─ index.js                       # runtime privado, health, eventos e bootstrap
├─ commands.js                    # comandos base
└─ core/
   ├─ blueprint.js                # cargos/canais/estrutura
   ├─ guildBuilder.js             # setup e repair idempotente
   ├─ commandAccess.js            # ACL central e cooldowns
   ├─ commandGuide.js             # canal público de comandos
   ├─ communityVisualCleanup.js   # remoção segura do visual antigo do Mio
   ├─ automod.js                  # proteção nativa Discord
   ├─ logging.js                  # logs
   ├─ communityStore.js           # persistência
   ├─ progression.js              # XP/daily/rep/ranking
   ├─ character.js                # persona textual do Mio
   └─ communityV3.js              # loja/missões/conquistas/sugestões/auto-cargos
```
