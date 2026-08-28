package io.github.astromg01.miovoice;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.AutomaticGainControl;
import android.media.audiofx.NoiseSuppressor;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

final class AudioEngine {
    private static final int SAMPLE_RATE = 48_000;
    private static final int CHANNEL_IN = AudioFormat.CHANNEL_IN_MONO;
    private static final int CHANNEL_OUT = AudioFormat.CHANNEL_OUT_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    private final Context context;
    private final AtomicReference<VoiceApi.Config> config = new AtomicReference<>(VoiceApi.Config.normal());
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final PitchShifter pitchShifter = new PitchShifter(2048, 1024);
    private final StrictVad strictVad;
    private final NeuralStreamProcessor neuralProcessor;
    private final float[] reverbBuffer = new float[7200];

    private AudioRecord recorder;
    private AudioTrack player;
    private NoiseSuppressor noiseSuppressor;
    private AcousticEchoCanceler acousticEchoCanceler;
    private AutomaticGainControl automaticGainControl;
    private Thread thread;
    private volatile int estimatedLatencyMs = -1;
    private volatile float monitorVolume = 0.55f;
    private volatile float cleanupStrength = 0.80f;
    private volatile boolean vadEnabled = true;
    private volatile float vadFocus = 0.78f;
    private volatile boolean voiceDetected = false;
    private volatile int voiceConfidence = 0;
    private volatile boolean disposed = false;

    private float lowState = 0f;
    private float outputLowpassState = 0f;
    private float speechBandState = 0f;
    private float robotPhase = 0f;
    private int reverbIndex = 0;

    private float highPassState = 0f;
    private float highPassPreviousInput = 0f;
    private float inputEnvelope = 0f;
    private float noiseFloor = 0.0035f;
    private float gateGain = 1f;

    AudioEngine(Context context) {
        this.context = context.getApplicationContext();
        strictVad = new StrictVad();
        neuralProcessor = new NeuralStreamProcessor(this.context);
    }

    void setConfig(VoiceApi.Config next) {
        if (next != null) config.set(next);
    }

    void setMonitorVolume(float value) {
        monitorVolume = clamp(value, 0.10f, 1f);
        AudioTrack current = player;
        if (current != null) {
            try {
                current.setVolume(monitorVolume);
            } catch (Exception ignored) {}
        }
    }

    void setCleanupStrength(float value) {
        cleanupStrength = clamp(value, 0f, 1f);
    }

    void setVadEnabled(boolean enabled) {
        vadEnabled = enabled;
        if (!enabled) {
            voiceDetected = false;
            voiceConfidence = 0;
        }
    }

    void setVadFocus(float value) {
        vadFocus = clamp(value, 0f, 1f);
    }

    void configureNeural(
        boolean enabled,
        String hubertPath,
        String rmvpePath,
        String synthPath,
        String label,
        int transpose
    ) {
        neuralProcessor.configure(enabled, hubertPath, rmvpePath, synthPath, label, transpose);
    }

    boolean isRunning() {
        return running.get();
    }

    boolean isVoiceDetected() {
        return voiceDetected;
    }

    int getVoiceConfidence() {
        return voiceConfidence;
    }

    int getEstimatedLatencyMs() {
        return estimatedLatencyMs;
    }

    boolean isNeuralEnabled() {
        return neuralProcessor.isEnabled();
    }

    boolean isNeuralReady() {
        return neuralProcessor.isReady();
    }

    String getNeuralStatus() {
        return neuralProcessor.getStatus();
    }

    int getNeuralLatencyMs() {
        return neuralProcessor.getEstimatedLatencyMs();
    }

    int getNeuralInferenceMs() {
        return neuralProcessor.getLastInferenceMs();
    }

    int getNeuralDroppedChunks() {
        return neuralProcessor.getDroppedChunks();
    }

    void start() {
        if (disposed || !running.compareAndSet(false, true)) return;
        thread = new Thread(this::audioLoop, "mio-voice-audio");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    void stop() {
        running.set(false);
        if (thread != null) thread.interrupt();
        releaseAudio();
        Thread current = thread;
        if (current != null && current != Thread.currentThread()) {
            try {
                current.join(350);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        disposeProcessors();
    }

    private void audioLoop() {
        try {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw new IllegalStateException("microphone_permission_missing");
            }

            AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            int minIn = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_IN, ENCODING);
            int minOut = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL_OUT, ENCODING);
            int blockSamples = resolveBlockSamples(audioManager);
            int targetBufferBytes = blockSamples * 2 * 4;
            int inputBuffer = Math.max(minIn, targetBufferBytes);
            int outputBuffer = Math.max(minOut, targetBufferBytes);

            recorder = createRecorder(MediaRecorder.AudioSource.VOICE_COMMUNICATION, inputBuffer);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                recorder = createRecorder(MediaRecorder.AudioSource.VOICE_RECOGNITION, inputBuffer);
            }
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("audio_record_init_failed");
            }

            player = createPlayer(outputBuffer, true);
            if (player.getState() != AudioTrack.STATE_INITIALIZED) {
                player.release();
                player = createPlayer(outputBuffer, false);
            }
            if (player.getState() != AudioTrack.STATE_INITIALIZED) {
                throw new IllegalStateException("audio_track_init_failed");
            }
            player.setVolume(monitorVolume);

            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(recorder.getAudioSessionId());
                if (noiseSuppressor != null) noiseSuppressor.setEnabled(true);
            }

            if (AcousticEchoCanceler.isAvailable()) {
                acousticEchoCanceler = AcousticEchoCanceler.create(recorder.getAudioSessionId());
                if (acousticEchoCanceler != null) acousticEchoCanceler.setEnabled(true);
            }

            if (AutomaticGainControl.isAvailable()) {
                automaticGainControl = AutomaticGainControl.create(recorder.getAudioSessionId());
                if (automaticGainControl != null) automaticGainControl.setEnabled(false);
            }

            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

            short[] input = new short[blockSamples];
            short[] output = new short[blockSamples];
            recorder.startRecording();
            player.play();

            long totalWrittenFrames = 0L;
            int blockMs = Math.max(1, Math.round(blockSamples * 1000f / SAMPLE_RATE));
            estimatedLatencyMs = blockMs * 2;

            while (running.get()) {
                int read = recorder.read(input, 0, input.length, AudioRecord.READ_BLOCKING);
                if (read <= 0) continue;
                VoiceApi.Config currentConfig = config.get();
                process(input, output, read, currentConfig);
                int written = player.write(output, 0, read, AudioTrack.WRITE_BLOCKING);
                if (written > 0) {
                    totalWrittenFrames += written;
                    long playedFrames = player.getPlaybackHeadPosition() & 0xffffffffL;
                    long queuedFrames = Math.max(0L, totalWrittenFrames - playedFrames);
                    int queuedMs = Math.round(queuedFrames * 1000f / SAMPLE_RATE);
                    float pitch = (float) currentConfig.pitch * clamp((float) currentConfig.mix, 0f, 1f);
                    int pitchMs = Math.abs(pitch) >= 0.03f ? pitchShifter.getMaxLatencyMs(SAMPLE_RATE) : 0;
                    estimatedLatencyMs = Math.max(blockMs, queuedMs + blockMs + pitchMs);
                }
            }
        } catch (Exception error) {
            running.set(false);
        } finally {
            releaseAudio();
        }
    }

    private int resolveBlockSamples(AudioManager manager) {
        try {
            String value = manager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);
            int nativeFrames = Integer.parseInt(value == null ? "0" : value);
            if (nativeFrames >= 120 && nativeFrames <= 480) return nativeFrames;
        } catch (Exception ignored) {}
        return 240;
    }

    private AudioRecord createRecorder(int source, int inputBuffer) {
        return new AudioRecord.Builder()
            .setAudioSource(source)
            .setAudioFormat(new AudioFormat.Builder()
                .setEncoding(ENCODING)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(CHANNEL_IN)
                .build())
            .setBufferSizeInBytes(inputBuffer)
            .build();
    }

    private AudioTrack createPlayer(int outputBuffer, boolean lowLatency) {
        AudioTrack.Builder builder = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            .setAudioFormat(new AudioFormat.Builder()
                .setEncoding(ENCODING)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(CHANNEL_OUT)
                .build())
            .setBufferSizeInBytes(outputBuffer)
            .setTransferMode(AudioTrack.MODE_STREAM);
        if (lowLatency) builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
        return builder.build();
    }

    private void process(short[] input, short[] output, int length, VoiceApi.Config cfg) {
        float strength = clamp((float) cfg.mix, 0f, 1f);
        float cleanup = cleanupStrength;
        StrictVad.Result vad = strictVad.analyze(input, length, vadFocus, vadEnabled);
        voiceDetected = vad.speech;
        voiceConfidence = vad.confidence;

        // Native NS/AEC has already processed AudioRecord. The neural path is kept
        // separate from the Lite DSP chain so the RVC model does not inherit pitch,
        // robot or reverb artifacts from the lightweight preset.
        if (neuralProcessor.process(input, output, length, !vadEnabled || vad.speech)) {
            return;
        }

        float formant = (float) cfg.formant * strength;
        float bassGain = dbToGain((float) cfg.bass * strength - formant * 0.7f);
        float presenceGain = dbToGain((float) cfg.presence * strength + formant * 0.9f);
        float drive = clamp((float) cfg.drive * strength, 0f, 1f);
        float robot = clamp((float) cfg.robot * strength, 0f, 1f);
        float reverb = clamp((float) cfg.reverb * strength, 0f, 0.50f);
        float pitch = (float) cfg.pitch * strength;
        boolean pitchActive = Math.abs(pitch) >= 0.03f;

        float baseOpenThreshold = 0.0065f + cleanup * 0.010f;
        float baseCloseThreshold = 0.0040f + cleanup * 0.0065f;
        float floorGain = 0.003f + (1f - cleanup) * 0.18f;
        float speechBandAlpha = clamp(0.68f - cleanup * 0.15f, 0.50f, 0.68f);

        for (int i = 0; i < length; i++) {
            float raw = input[i] / 32768f;

            float highPassed = 0.985f * (highPassState + raw - highPassPreviousInput);
            highPassPreviousInput = raw;
            highPassState = highPassed;

            speechBandState += speechBandAlpha * (highPassed - speechBandState);
            float filtered = speechBandState;

            float absolute = Math.abs(filtered);
            float envelopeRate = absolute > inputEnvelope ? 0.09f : 0.004f;
            inputEnvelope += (absolute - inputEnvelope) * envelopeRate;

            if (!vad.speech && inputEnvelope < 0.06f) {
                noiseFloor += (inputEnvelope - noiseFloor) * 0.00010f;
                noiseFloor = clamp(noiseFloor, 0.0012f, 0.030f);
            }

            float dynamicOpen = Math.max(baseOpenThreshold, noiseFloor * (1.75f + cleanup * 1.25f));
            float dynamicClose = Math.max(baseCloseThreshold, noiseFloor * (1.35f + cleanup * 0.75f));
            boolean currentlyOpen = gateGain > 0.45f;
            boolean envelopeOpen = currentlyOpen ? inputEnvelope > dynamicClose : inputEnvelope > dynamicOpen;

            // This is intentionally strict. With VAD enabled, energy alone cannot
            // open the gate anymore; the frame must look like near-field speech.
            boolean shouldOpen = vadEnabled ? vad.speech : envelopeOpen;
            float gateTarget = shouldOpen ? 1f : floorGain;
            float gateRate = gateTarget > gateGain ? 0.18f : 0.00125f;
            gateGain += (gateTarget - gateGain) * gateRate;

            float cleaned = filtered * gateGain;
            float x = pitchShifter.process(cleaned, pitch);

            lowState += 0.055f * (x - lowState);
            float high = x - lowState;
            x = lowState * bassGain + high * presenceGain;

            if (drive > 0.001f) {
                float amount = 1f + drive * 8f;
                x = (float) (Math.tanh(x * amount) / Math.tanh(amount));
            }

            if (robot > 0.001f) {
                robotPhase += (float) (2.0 * Math.PI * 92.0 / SAMPLE_RATE);
                if (robotPhase > Math.PI * 2) robotPhase -= (float) (Math.PI * 2);
                float ring = x * (float) Math.sin(robotPhase);
                x = x * (1f - robot) + ring * robot;
            }

            if (reverb > 0.001f) {
                float delayed = reverbBuffer[reverbIndex];
                reverbBuffer[reverbIndex] = clamp(x + delayed * 0.16f, -1f, 1f);
                reverbIndex++;
                if (reverbIndex >= reverbBuffer.length) reverbIndex = 0;
                x = x * (1f - reverb) + delayed * reverb;
            }

            if (pitchActive) {
                float damping = clamp(0.70f - Math.abs(pitch) * 0.028f, 0.50f, 0.70f);
                outputLowpassState += damping * (x - outputLowpassState);
                x = outputLowpassState;
            } else {
                outputLowpassState = x;
            }

            x = softLimit(x * 0.86f);
            output[i] = (short) Math.round(x * 32767f);
        }
    }

    private synchronized void releaseAudio() {
        voiceDetected = false;
        voiceConfidence = 0;

        try {
            if (automaticGainControl != null) automaticGainControl.release();
        } catch (Exception ignored) {}
        automaticGainControl = null;

        try {
            if (acousticEchoCanceler != null) acousticEchoCanceler.release();
        } catch (Exception ignored) {}
        acousticEchoCanceler = null;

        try {
            if (noiseSuppressor != null) noiseSuppressor.release();
        } catch (Exception ignored) {}
        noiseSuppressor = null;

        try {
            if (recorder != null) recorder.stop();
        } catch (Exception ignored) {}
        try {
            if (recorder != null) recorder.release();
        } catch (Exception ignored) {}
        recorder = null;

        try {
            if (player != null) player.stop();
        } catch (Exception ignored) {}
        try {
            if (player != null) player.release();
        } catch (Exception ignored) {}
        player = null;

        try {
            AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            audioManager.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {}
    }

    private synchronized void disposeProcessors() {
        if (disposed) return;
        disposed = true;
        try {
            neuralProcessor.close();
        } catch (Exception ignored) {}
        try {
            strictVad.close();
        } catch (Exception ignored) {}
    }

    private static float dbToGain(float db) {
        float safe = clamp(db, -12f, 12f);
        return (float) Math.pow(10.0, safe / 20.0);
    }

    private static float softLimit(float value) {
        return (float) Math.tanh(value * 1.1f) / (float) Math.tanh(1.1f);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    private static final class PitchShifter {
        private final float[] buffer;
        private final int window;
        private int writeIndex = 0;
        private double phase = 0.25;

        PitchShifter(int bufferSize, int window) {
            this.buffer = new float[bufferSize];
            this.window = Math.min(window, bufferSize - 4);
        }

        int getMaxLatencyMs(int sampleRate) {
            return Math.round(window * 1000f / sampleRate);
        }

        float process(float input, float semitones) {
            buffer[writeIndex] = input;
            if (Math.abs(semitones) < 0.03f) {
                writeIndex = (writeIndex + 1) % buffer.length;
                return input;
            }

            double factor = Math.pow(2.0, semitones / 12.0);
            phase += (1.0 - factor) / window;
            phase -= Math.floor(phase);
            double phase2 = phase + 0.5;
            if (phase2 >= 1.0) phase2 -= 1.0;

            float first = readDelay(phase * window);
            float second = readDelay(phase2 * window);
            double w1 = Math.sin(Math.PI * phase);
            w1 *= w1;
            double w2 = 1.0 - w1;
            float result = (float) (first * w1 + second * w2);

            writeIndex = (writeIndex + 1) % buffer.length;
            return result;
        }

        private float readDelay(double delay) {
            double position = writeIndex - delay;
            while (position < 0) position += buffer.length;
            while (position >= buffer.length) position -= buffer.length;
            int a = (int) position;
            int b = (a + 1) % buffer.length;
            float fraction = (float) (position - a);
            return buffer[a] * (1f - fraction) + buffer[b] * fraction;
        }
    }
}
