# MiojoPlays Interactive — Mindustry Android

Mod oficial do Game Interactive da MiojoPlays para Mindustry Android.

## Instalação no Android

1. Baixe o artefato `MiojoPlaysInteractive-Android` no GitHub Actions.
2. Extraia o ZIP do artefato e mantenha o arquivo `MiojoPlaysInteractive.jar`.
3. Abra o Mindustry.
4. Entre em **Mods**.
5. Use **Importar mod / Importar arquivo** e escolha `MiojoPlaysInteractive.jar`.
6. Reinicie o Mindustry se ele solicitar.

## Vinculação com o Discord

1. No Discord, use `/mindustry vincular`.
2. O bot envia um código privado de 6 dígitos válido por 10 minutos.
3. Ao carregar o Mindustry com o mod ativo, digite esse código na janela `MiojoPlays Interactive`.
4. Depois do pareamento, use `/mindustry status` para confirmar que o jogo está conectado.
5. O dono pode usar `/mindustry abrir` para permitir as ações da comunidade.

## Ações da fase inicial

- Próxima wave.
- +100 cobre no núcleo do time do jogador.
- Curar núcleo.

O mod não aceita comandos arbitrários. Somente ações cadastradas no bot são executadas.

## Build Android

O workflow principal do repositório usa Java 17, Android SDK + D8 e Gradle para executar:

```sh
gradle --no-daemon clean deploy
```

O resultado final é:

```text
integrations/mindustry-mod/build/libs/MiojoPlaysInteractive.jar
```
