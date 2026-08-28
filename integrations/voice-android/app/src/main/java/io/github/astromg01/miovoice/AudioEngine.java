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
    private final PitchShifter pitchShifter = new PitchShifter(4096, 2048);
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

    private float lowState = 0f;
    private float outputLowpassState = 0f;
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

    boolean isRunning() {
        return running.get();
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

            int minIn = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_IN, ENCODING);
            int minOut = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL_OUT, ENCODING);
            int blockSamples = 480;
            int inputBuffer = Math.max(minIn * 2, blockSamples * 8);
            int outputBuffer = Math.max(minOut * 2, blockSamples * 8);

            // VOICE_COMMUNICATION gives Samsung/Android audio policy the best chance
            // to attach its native voice-call AEC/NS path. Fall back safely on devices
            // where that source cannot initialize.
            recorder = createRecorder(MediaRecorder.AudioSource.VOICE_COMMUNICATION, inputBuffer);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                recorder = createRecorder(MediaRecorder.AudioSource.VOICE_RECOGNITION, inputBuffer);
            }
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("audio_record_init_failed");
            }

            player = new AudioTrack.Builder()
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
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
            player.setVolume(monitorVolume);

            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(recorder.getAudioSessionId());
                if (noiseSuppressor != null) noiseSuppressor.setEnabled(true);
            }

            if (AcousticEchoCanceler.isAvailable()) {
                acousticEchoCanceler = AcousticEchoCanceler.create(recorder.getAudioSessionId());
                if (acousticEchoCanceler != null) acousticEchoCanceler.setEnabled(true);
            }

            // Some devices auto-boost the mic in communication mode. That makes room
            // noise louder and fights our gate, so disable platform AGC when possible.
            if (AutomaticGainControl.isAvailable()) {
                automaticGainControl = AutomaticGainControl.create(recorder.getAudioSessionId());
                if (automaticGainControl != null) automaticGainControl.setEnabled(false);
            }

            AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

            short[] input = new short[blockSamples];
            short[] output = new short[blockSamples];
            recorder.startRecording();
            player.play();

            int bufferLatency = Math.max(inputBuffer, outputBuffer) / 2 * 1000 / SAMPLE_RATE;
            estimatedLatencyMs = bufferLatency + pitchShifter.getMaxLatencyMs(SAMPLE_RATE);

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

    private void process(short[] input, short[] output, int length, VoiceApi.Config cfg) {
        float strength = clamp((float) cfg.mix, 0f, 1f);
        float cleanup = cleanupStrength;
        float formant = (float) cfg.formant * strength;
        float bassGain = dbToGain((float) cfg.bass * strength - formant * 0.7f);
        float presenceGain = dbToGain((float) cfg.presence * strength + formant * 0.9f);
        float drive = clamp((float) cfg.drive * strength, 0f, 1f);
        float robot = clamp((float) cfg.robot * strength, 0f, 1f);
        float reverb = clamp((float) cfg.reverb * strength, 0f, 0.55f);
        float pitch = (float) cfg.pitch * strength;
        boolean pitchActive = Math.abs(pitch) >= 0.03f;

        // Stronger cleanup increases the adaptive open threshold and lowers the
        // residual gain while the user is not speaking. Hysteresis prevents chatter.
        float baseOpenThreshold = 0.007f + cleanup * 0.011f;
        float baseCloseThreshold = 0.0045f + cleanup * 0.0075f;
        float floorGain = 0.02f + (1f - cleanup) * 0.30f;

        for (int i = 0; i < length; i++) {
            float raw = input[i] / 32768f;

            // ~120 Hz high-pass removes handling/room rumble before the detector.
            float highPassed = 0.985f * (highPassState + raw - highPassPreviousInput);
            highPassPreviousInput = raw;
            highPassState = highPassed;

            float absolute = Math.abs(highPassed);
            float envelopeRate = absolute > inputEnvelope ? 0.075f : 0.004f;
            inputEnvelope += (absolute - inputEnvelope) * envelopeRate;

            // Learn the room floor slowly only while the signal is reasonably quiet.
            if (inputEnvelope < 0.07f) {
                noiseFloor += (inputEnvelope - noiseFloor) * 0.00012f;
                noiseFloor = clamp(noiseFloor, 0.0015f, 0.035f);
            }

            float dynamicOpen = Math.max(baseOpenThreshold, noiseFloor * (1.65f + cleanup * 1.25f));
            float dynamicClose = Math.max(baseCloseThreshold, noiseFloor * (1.30f + cleanup * 0.80f));
            boolean currentlyOpen = gateGain > 0.45f;
            float gateTarget = currentlyOpen
                ? (inputEnvelope > dynamicClose ? 1f : floorGain)
                : (inputEnvelope > dynamicOpen ? 1f : floorGain);
            float gateRate = gateTarget > gateGain ? 0.085f : 0.00055f;
            gateGain += (gateTarget - gateGain) * gateRate;

            float cleaned = highPassed * gateGain;
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
                reverbBuffer[reverbIndex] = clamp(x + delayed * 0.22f, -1f, 1f);
                reverbIndex++;
                if (reverbIndex >= reverbBuffer.length) reverbIndex = 0;
                x = x * (1f - reverb) + delayed * reverb;
            }

            // Adaptive post-pitch damping: stronger for large pitch shifts where the
            // time-domain shifter can occasionally create a narrow whistle.
            if (pitchActive) {
                float damping = clamp(0.72f - Math.abs(pitch) * 0.025f, 0.54f, 0.72f);
                outputLowpassState += damping * (x - outputLowpassState);
                x = outputLowpassState;
            } else {
                outputLowpassState = x;
            }

            x = softLimit(x * 0.90f);
            output[i] = (short) Math.round(x * 32767f);
        }
    }

    private void releaseAudio() {
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
