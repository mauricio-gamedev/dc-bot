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
    private Thread thread;
    private volatile int estimatedLatencyMs = -1;
    private float lowState = 0f;
    private float robotPhase = 0f;
    private int reverbIndex = 0;

    AudioEngine(Context context) {
        this.context = context.getApplicationContext();
    }

    void setConfig(VoiceApi.Config next) {
        if (next != null) config.set(next);
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

            recorder = new AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                .setAudioFormat(new AudioFormat.Builder()
                    .setEncoding(ENCODING)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL_IN)
                    .build())
                .setBufferSizeInBytes(inputBuffer)
                .build();

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

            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(recorder.getAudioSessionId());
                if (noiseSuppressor != null) noiseSuppressor.setEnabled(true);
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

    private void process(short[] input, short[] output, int length, VoiceApi.Config cfg) {
        float mix = clamp((float) cfg.mix, 0f, 1f);
        float bassGain = dbToGain((float) (cfg.bass - cfg.formant * 0.7));
        float presenceGain = dbToGain((float) (cfg.presence + cfg.formant * 0.9));
        float drive = clamp((float) cfg.drive, 0f, 1f);
        float robot = clamp((float) cfg.robot, 0f, 1f);
        float reverb = clamp((float) cfg.reverb, 0f, 0.65f);
        float pitch = (float) cfg.pitch;

        for (int i = 0; i < length; i++) {
            float dry = input[i] / 32768f;
            float x = pitchShifter.process(dry, pitch);

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
                reverbBuffer[reverbIndex] = clamp(x + delayed * 0.35f, -1f, 1f);
                reverbIndex++;
                if (reverbIndex >= reverbBuffer.length) reverbIndex = 0;
                x = x * (1f - reverb) + delayed * reverb;
            }

            float mixed = dry * (1f - mix) + x * mix;
            mixed = softLimit(mixed);
            output[i] = (short) Math.round(mixed * 32767f);
        }
    }

    private void releaseAudio() {
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
