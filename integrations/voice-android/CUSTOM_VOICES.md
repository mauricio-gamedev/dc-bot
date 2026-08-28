# Mio Voice — Custom Neural Voices

Mio Voice has two distinct character-voice paths. The lightweight DSP presets remain the low-latency game mode. Android v0.1.4 adds the first experimental **local RVC/ONNX** path for user-imported neural voices; it is not TTS and it does not upload microphone audio to Render.

## Modes

- **Lite DSP** — pitch/formant/EQ/robot/reverb path. Lowest cost and preferred when latency/FPS matter most.
- **Neural RVC** — local voice conversion using ContentVec/HuBERT + RMVPE + an RVC synthesizer exported to ONNX.
- A later **Auto** mode may fall back to Lite DSP when neural inference cannot keep up in real time.

## Files required by v0.1.4

The Android app imports three files through the system document picker and copies them into private app storage:

1. `ContentVec / HuBERT (.onnx)` — shared speech-content encoder.
2. `RMVPE (.onnx)` — shared F0/pitch extractor.
3. `Voice RVC (.onnx)` — the actual imported character/speaker voice generator.

The first neural implementation accepts the conventional voice-changer RVC synthesizer schema with `feats`, `p_len`, `sid` and, for F0 models, `pitch` + `pitchf`. The synthesizer must currently use **float32 features**; fp16 voice exports are rejected instead of being loaded incorrectly.

No third-party character, actor or creator voice model is bundled in this repository. Users must import only models they have the right or permission to use.

## Runtime design

Audio stays on the phone:

`mic -> Android VOICE_COMMUNICATION NS/AEC -> strict WebRTC VAD -> RVC worker -> monitor`

The neural worker is separated from the real-time AudioRecord/AudioTrack thread. v0.1.4 starts conservatively with roughly 480 ms inference chunks. The UI reports neural inference/estimated neural latency separately from the Lite DSP pipeline. This is deliberately an experimental first pass for Galaxy A06-class hardware; it must not pretend to have gaming-grade latency until measured on-device.

If the neural worker falls behind, Mio Voice bounds the queues and drops stale chunks instead of allowing latency to grow without limit. The Lite DSP path remains available as the safe fallback.

## VAD in v0.1.4

The previous energy/SNR-only detector could mistake short external noises for voice. v0.1.4 uses WebRTC VAD in `VERY_AGGRESSIVE` mode plus Mio Voice near-field checks:

- adaptive room-noise floor;
- SNR requirement;
- learned close-voice level;
- transient/click rejection;
- zero-crossing speech texture check;
- user-adjustable `Foco da minha voz` threshold.

When VAD is enabled, the Lite gate no longer opens from energy alone. A frame has to pass the speech detector.

## Future `.mvoice` package

A future `.mvoice` bundle can wrap compatible models with a signed/hashed manifest containing fields such as `id`, `name`, `engine`, `sampleRate`, `version`, `author`, `license` and model SHA-256 values. The app should reject executable payloads and verify every declared model hash before activation.

## Next optimization targets

1. Validate the first imported RVC model on the Galaxy A06.
2. Measure real-time factor, RAM and thermal load.
3. Replace simple resampling with a higher-quality low-cost resampler.
4. Reduce RVC chunk size only when inference headroom allows it.
5. Consider NNAPI/XNNPACK/quantized mobile exports when model compatibility is proven.
6. Keep virtual-microphone routing as a separate Android platform problem; neural conversion working in the monitor does not by itself make another game accept Mio Voice as its microphone.
