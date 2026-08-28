package io.github.astromg01.miovoice;

import android.content.Context;

import java.io.File;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Keeps heavy RVC inference off the real-time AudioRecord/AudioTrack thread.
 *
 * v0.1.4 deliberately uses ~480 ms chunks. That is not the final gaming
 * latency target, but it makes the first neural voice path usable without
 * blocking the lightweight DSP monitor or freezing a low-end phone.
 */
final class NeuralStreamProcessor implements AutoCloseable {
    private static final int CHUNK_SAMPLES = 23_040; // 480 ms @ 48 kHz

    private final AtomicBoolean running = new AtomicBoolean(true);
    private final ArrayBlockingQueue<float[]> inputQueue = new ArrayBlockingQueue<>(1);
    private final ArrayBlockingQueue<short[]> outputQueue = new ArrayBlockingQueue<>(2);
    private final float[] captureChunk = new float[CHUNK_SAMPLES];
    private int capturePosition = 0;

    private Thread worker;
    private RvcNeuralEngine engine;
    private short[] currentOutput;
    private int currentOutputPosition = 0;

    private volatile boolean enabled = false;
    private volatile boolean ready = false;
    private volatile boolean reloadRequested = false;
    private volatile String status = "desligado";
    private volatile String voiceLabel = "—";
    private volatile int transpose = 0;
    private volatile int lastInferenceMs = -1;
    private volatile int droppedChunks = 0;

    private String hubertPath = "";
    private String rmvpePath = "";
    private String synthPath = "";
    private long modelSignature = Long.MIN_VALUE;

    NeuralStreamProcessor(Context context) {
        worker = new Thread(this::workerLoop, "mio-neural-rvc");
        worker.setPriority(Thread.NORM_PRIORITY);
        worker.start();
    }

    synchronized void configure(
        boolean nextEnabled,
        String nextHubert,
        String nextRmvpe,
        String nextSynth,
        String nextVoiceLabel,
        int nextTranspose
    ) {
        transpose = Math.max(-12, Math.min(12, nextTranspose));
        voiceLabel = nextVoiceLabel == null || nextVoiceLabel.isBlank() ? "Voz RVC" : nextVoiceLabel;
        String newHubert = safe(nextHubert);
        String newRmvpe = safe(nextRmvpe);
        String newSynth = safe(nextSynth);
        long nextSignature = signature(newHubert, newRmvpe, newSynth);
        boolean modelsChanged = !newHubert.equals(hubertPath)
            || !newRmvpe.equals(rmvpePath)
            || !newSynth.equals(synthPath)
            || nextSignature != modelSignature;
        hubertPath = newHubert;
        rmvpePath = newRmvpe;
        synthPath = newSynth;
        modelSignature = nextSignature;
        enabled = nextEnabled;

        if (!enabled) {
            ready = false;
            status = "desligado";
            clearAudioQueues();
            closeEngine();
            return;
        }

        if (hubertPath.isEmpty() || rmvpePath.isEmpty() || synthPath.isEmpty()
            || !new File(hubertPath).isFile() || !new File(rmvpePath).isFile() || !new File(synthPath).isFile()) {
            ready = false;
            status = "modelos incompletos";
            clearAudioQueues();
            closeEngine();
            return;
        }

        if (modelsChanged || engine == null) {
            ready = false;
            status = "carregando modelos…";
            reloadRequested = true;
            clearAudioQueues();
            if (worker != null) worker.interrupt();
        }
    }

    boolean process(short[] input, short[] output, int length, boolean speech) {
        if (!enabled || !ready || input == null || output == null || length <= 0) return false;

        for (int i = 0; i < length; i++) {
            captureChunk[capturePosition++] = speech ? input[i] / 32768f : 0f;
            if (capturePosition >= captureChunk.length) {
                float[] chunk = captureChunk.clone();
                capturePosition = 0;
                if (!inputQueue.offer(chunk)) {
                    inputQueue.poll();
                    inputQueue.offer(chunk);
                    droppedChunks++;
                    status = "sobrecarga neural • reduzindo fila";
                }
            }
        }

        if (currentOutput == null || currentOutputPosition >= currentOutput.length) {
            currentOutput = outputQueue.poll();
            currentOutputPosition = 0;
        }
        if (currentOutput == null) return false;

        int written = 0;
        while (written < length) {
            if (currentOutput == null) {
                while (written < length) output[written++] = 0;
                break;
            }
            int available = currentOutput.length - currentOutputPosition;
            int copy = Math.min(available, length - written);
            System.arraycopy(currentOutput, currentOutputPosition, output, written, copy);
            written += copy;
            currentOutputPosition += copy;
            if (currentOutputPosition >= currentOutput.length) {
                currentOutput = outputQueue.poll();
                currentOutputPosition = 0;
            }
        }
        return true;
    }

    boolean isEnabled() {
        return enabled;
    }

    boolean isReady() {
        return ready;
    }

    String getStatus() {
        return status;
    }

    int getLastInferenceMs() {
        return lastInferenceMs;
    }

    int getEstimatedLatencyMs() {
        if (!enabled) return -1;
        int inference = Math.max(0, lastInferenceMs);
        return 480 + inference;
    }

    int getDroppedChunks() {
        return droppedChunks;
    }

    private void workerLoop() {
        while (running.get()) {
            try {
                if (reloadRequested) reloadEngine();
                if (!enabled || !ready || engine == null) {
                    Thread.sleep(120);
                    continue;
                }

                float[] chunk = inputQueue.poll(250, TimeUnit.MILLISECONDS);
                if (chunk == null) continue;
                long start = System.nanoTime();
                float[] converted = engine.convert48k(chunk, transpose);
                lastInferenceMs = (int) Math.min(Integer.MAX_VALUE, (System.nanoTime() - start) / 1_000_000L);
                short[] pcm = toPcm16(converted);
                if (!outputQueue.offer(pcm)) {
                    outputQueue.poll();
                    outputQueue.offer(pcm);
                    droppedChunks++;
                }
                float realtime = lastInferenceMs / 480f;
                status = realtime <= 1.0f
                    ? "neural pronto • " + voiceLabel
                    : "neural lento x" + String.format(java.util.Locale.US, "%.1f", realtime) + " • " + voiceLabel;
            } catch (InterruptedException ignored) {
                // Configuration wake-up.
            } catch (Exception error) {
                ready = false;
                status = "erro neural: " + safeMessage(error);
                closeEngine();
            }
        }
        closeEngine();
    }

    private synchronized void reloadEngine() {
        reloadRequested = false;
        closeEngine();
        if (!enabled) return;
        try {
            File hubert = new File(hubertPath);
            File rmvpe = new File(rmvpePath);
            File synth = new File(synthPath);
            engine = new RvcNeuralEngine(hubert, rmvpe, synth, voiceLabel);
            ready = true;
            status = "neural pronto • " + engine.getModelInfo().label;
            lastInferenceMs = -1;
            droppedChunks = 0;
        } catch (Exception error) {
            ready = false;
            status = "modelo incompatível: " + safeMessage(error);
            closeEngine();
        }
    }

    private void clearAudioQueues() {
        inputQueue.clear();
        outputQueue.clear();
        currentOutput = null;
        currentOutputPosition = 0;
        capturePosition = 0;
    }

    private void closeEngine() {
        try {
            if (engine != null) engine.close();
        } catch (Exception ignored) {}
        engine = null;
    }

    @Override
    public void close() {
        running.set(false);
        if (worker != null) worker.interrupt();
        clearAudioQueues();
        closeEngine();
    }

    private static long signature(String... paths) {
        long value = 1125899906842597L;
        for (String path : paths) {
            File file = new File(path == null ? "" : path);
            value = value * 31L + file.length();
            value = value * 31L + file.lastModified();
        }
        return value;
    }

    private static short[] toPcm16(float[] input) {
        short[] output = new short[input.length];
        for (int i = 0; i < input.length; i++) {
            float x = Math.max(-1f, Math.min(1f, input[i]));
            output[i] = (short) Math.round(x * 32767f);
        }
        return output;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
