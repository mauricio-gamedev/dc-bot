# Mio Voice — Custom Neural Voices

This document defines the next-stage direction for custom voices in Mio Voice. The current DSP presets are intentionally not presented as neural voice cloning.

## Goal

Add a local real-time voice-conversion engine capable of loading user-provided voice packs while keeping the existing lightweight DSP mode available for games.

## Planned modes

- **Lite DSP** — current low-cost pitch/formant/EQ path. Lowest latency and safest for gaming.
- **Neural Voice** — optional local model inference for a much stronger speaker/character transformation.
- **Auto** — fall back to Lite DSP when the device cannot maintain the neural model in real time.

## Voice pack format

A future `.mvoice` pack should be a ZIP container with:

- `manifest.json`
  - `id`
  - `name`
  - `engine`
  - `sampleRate`
  - `version`
  - `author`
  - `license`
  - `modelSha256`
- `model.onnx` or another explicitly supported mobile model
- optional `index.bin` / speaker embedding data when required by the selected engine
- optional preview image/audio metadata

The app must verify the declared hash before loading a model and must reject unknown executable content.

## Mobile target

The Galaxy A06-class target is resource-constrained, so the first neural engine should prioritize:

- mono 16 kHz or 24 kHz inference where quality permits;
- small streaming chunks;
- bounded RAM usage;
- no microphone audio upload to Render;
- no blocking network dependency during gameplay;
- automatic fallback to Lite DSP on sustained underruns or excessive inference time.

## Safety and licensing

Only load or distribute voice models the user has the right or permission to use. The bot repository should not bundle third-party character/actor voice models without an explicit compatible license.

## Integration plan

1. Finish low-latency DSP + VAD baseline.
2. Add local voice-pack import and validation.
3. Add a mobile inference abstraction.
4. Integrate one lightweight neural conversion backend.
5. Measure real-time factor, latency and memory on Android before enabling Neural Voice during games.
