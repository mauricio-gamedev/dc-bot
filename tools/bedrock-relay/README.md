# MiojoPlays Bedrock Relay — Android

Relay local para conectar Minecraft Bedrock no Android ao Game Interactive do Discord.

## Por que existe

O Minecraft Bedrock usa um protocolo WebSocket próprio, incluindo negociação de criptografia de aplicação. O relay roda localmente no Android usando `mcwss`, enquanto a comunicação com o bot hospedado no Render acontece por HTTPS.

Fluxo:

`Minecraft Bedrock -> ws://127.0.0.1:19131/ws -> relay Android -> HTTPS -> bot Discord/Render`

O endereço `127.0.0.1` é local ao próprio aparelho: o Minecraft não recebe a chave privada nem se conecta diretamente ao Render.

## Termux

No Termux:

```sh
pkg update
pkg install git golang -y
git clone https://github.com/mauricio-gamedev/dc-bot.git
cd dc-bot/tools/bedrock-relay
```

No Discord, execute `/game conectar`. Copie apenas a **chave privada do relay** e configure no Termux sem publicar a chave:

```sh
export MIOJO_RELAY_TOKEN='COLE_A_CHAVE_AQUI'
go run .
```

Quando aparecer `MiojoPlays Bedrock Relay ativo`, mantenha o processo em execução, abra o Minecraft, entre em um mundo com cheats habilitados e execute:

```text
/connect ws://127.0.0.1:19131/ws
```

Depois confira `/game status` no Discord. O modo deve aparecer como `relay Android local`.

## Uso

1. Mantenha o Termux/relay ativo em segundo plano enquanto joga.
2. No Discord, o dono usa `/game abrir`.
3. A comunidade usa `/game acao`.
4. O dono pode usar `/game fechar` a qualquer momento.

O relay nunca aceita comandos arbitrários vindos de usuários. Somente as ações pré-aprovadas pelo bot entram na fila.

## Variáveis opcionais

- `MIOJO_RELAY_TOKEN`: chave privada fornecida por `/game conectar`.
- `MIOJO_RELAY_SERVER`: padrão `https://dc-bot-us5v.onrender.com`.
- `MIOJO_RELAY_LISTEN`: padrão `127.0.0.1:19131`.

A chave não deve ser commitada nem compartilhada. Se o Render reiniciar e `MINECRAFT_BRIDGE_TOKEN` não estiver persistido no host, consulte `/game conectar` novamente e reinicie o relay com a chave atual.
