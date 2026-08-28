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
    private final VoiceActivityDetector voiceActivityDetector = new VoiceActivityDetector();
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
    private volatile boolean voiceDetected = false;
    private volatile int voiceConfidence = 0;

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

    void start() {
        if (!running.compareAndSet(false, true)) return;
        thread = new Thread(this::audioLoop, "mio-voice-audio");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    void stop() {
        running.set(false);
        if (thread != null) thread.interrupt();
        releaseAudio();
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

            int outputFrames = Math.max(blockSamples * 2, player.getBufferSizeInFrames());
            int outputQueueMs = Math.round(outputFrames * 1000f / SAMPLE_RATE);
            int blockGuardMs = Math.round(blockSamples * 2f * 1000f / SAMPLE_RATE);
            estimatedLatencyMs = outputQueueMs + blockGuardMs + pitchShifter.getMaxLatencyMs(SAMPLE_RATE);

            while (running.get()) {
                int read = recorder.read(input, 0, input.length, AudioRecord.READ_BLOCKING);
                if (read <= 0) continue;
                process(input, output, read, config.get());
                player.write(output, 0, read, AudioTrack.WRITE_BLOCKING);
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
        VadResult vad = voiceActivityDetector.analyze(input, length, cleanup, vadEnabled);
        voiceDetected = vad.speech;
        voiceConfidence = vad.confidence;

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
        float floorGain = 0.006f + (1f - cleanup) * 0.22f;
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
            boolean shouldOpen = vadEnabled ? (vad.speech || envelopeOpen && vad.confidence >= 18) : envelopeOpen;
            float gateTarget = shouldOpen ? 1f : floorGain;
            float gateRate = gateTarget > gateGain ? 0.16f : 0.0010f;
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
                reverbBuffer[reverbIndex] = clamp(x + delayed * 0.18f, -1f, 1f);
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

    private void releaseAudio() {
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

    private static final class VadResult {
        final boolean speech;
        final int confidence;

        VadResult(boolean speech, int confidence) {
            this.speech = speech;
            this.confidence = confidence;
        }
    }

    private static final class VoiceActivityDetector {
        private float noiseRms = 0.004f;
        private int hangoverBlocks = 0;
        private int lastConfidence = 0;

        VadResult analyze(short[] input, int length, float cleanup, boolean enabled) {
            if (!enabled || length <= 0) return new VadResult(false, 0);

            double energy = 0.0;
            float peak = 0f;
            for (int i = 0; i < length; i++) {
                float sample = input[i] / 32768f;
                energy += sample * sample;
                peak = Math.max(peak, Math.abs(sample));
            }

            float rms = (float) Math.sqrt(energy / length);
            float currentNoise = Math.max(0.0008f, noiseRms);
            float snrDb = (float) (20.0 * Math.log10((rms + 0.00001f) / (currentNoise + 0.00001f)));
            float thresholdDb = 4.0f + cleanup * 4.0f;
            float minEnergy = 0.0030f + cleanup * 0.0025f;
            boolean candidate = rms > minEnergy
                && snrDb > thresholdDb
                && peak > currentNoise * (2.0f + cleanup * 0.8f);

            if (!candidate && hangoverBlocks == 0) {
                float learnRate = rms < noiseRms ? 0.025f : 0.0020f;
                noiseRms += (rms - noiseRms) * learnRate;
                noiseRms = clamp(noiseRms, 0.0010f, 0.040f);
            }

            int confidence = Math.round(clamp((snrDb - thresholdDb + 5f) / 16f, 0f, 1f) * 100f);
            if (candidate) {
                int blocksFor180Ms = Math.max(2, Math.round(0.18f * SAMPLE_RATE / length));
                hangoverBlocks = blocksFor180Ms;
                lastConfidence = Math.max(35, confidence);
                return new VadResult(true, lastConfidence);
            }

            if (hangoverBlocks > 0) {
                hangoverBlocks--;
                lastConfidence = Math.max(18, Math.round(lastConfidence * 0.92f));
                return new VadResult(true, lastConfidence);
            }

            lastConfidence = Math.max(0, Math.round(lastConfidence * 0.70f));
            return new VadResult(false, Math.min(confidence, lastConfidence));
        }
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
