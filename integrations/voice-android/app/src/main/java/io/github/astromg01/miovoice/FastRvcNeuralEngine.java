package io.github.astromg01.miovoice;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;
import ai.onnxruntime.providers.NNAPIFlags;

import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Performance-oriented local RVC path for Android.
 *
 * Supports the large voice-changer base models already used by Mio Voice and
 * the much smaller voiceclonnx INT8/Q8 ContentVec + RMVPE base pair. The
 * character synthesizer remains user supplied. Audio never leaves the phone.
 *
 * v0.1.7 keeps ContentVec/RMVPE on XNNPACK but gives the character synth a
 * dedicated accelerator path: hardware-only NNAPI FP16 first, partial NNAPI
 * FP16 second, then XNNPACK/CPU fallback. The active backend is exposed in the
 * live timing card so device testing stays honest.
 */
final class FastRvcNeuralEngine implements AutoCloseable {
    private static final int INPUT_SR = 16_000;
    private static final int OUTPUT_SR = 48_000;
    private static final int RMVPE_FFT = 1024;
    private static final int RMVPE_HOP = 160;
    private static final int RMVPE_MELS = 128;
    private static final int RMVPE_BINS = 360;
    private static final float RMVPE_VOICED = 0.003f;

    private static final float[] HANN = buildHann();
    private static final float[] MEL_FILTER = buildMelFilterbank();

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private OrtSession hubert;
    private OrtSession rmvpe;
    private OrtSession synth;
    private final String label;
    private final int sampleRate;
    private final boolean f0;
    private final String hubertOutput;
    private final String backend;

    private volatile int hubertMs = -1;
    private volatile int rmvpeMs = -1;
    private volatile int synthMs = -1;

    FastRvcNeuralEngine(File hubertFile, File rmvpeFile, File synthFile, String voiceLabel) throws Exception {
        if (!hubertFile.isFile() || !rmvpeFile.isFile() || !synthFile.isFile()) {
            throw new IllegalArgumentException("neural_models_missing");
        }

        this.label = voiceLabel == null || voiceLabel.isBlank() ? "Voz RVC" : voiceLabel;
        try {
            SessionOpen h = openBaseOptimized(hubertFile);
            hubert = h.session;
            SessionOpen r = openBaseOptimized(rmvpeFile);
            rmvpe = r.session;
            SessionOpen s = openSynthOptimized(synthFile);
            synth = s.session;

            String baseBackend = h.backend.equals(r.backend)
                ? h.backend
                : h.backend + "+" + r.backend;
            backend = "base " + baseBackend + " • synth " + s.backend;

            hubertOutput = chooseHubertOutput(hubert);
            validateSchemas();
            ModelMeta meta = readModelMeta(synth);
            sampleRate = meta.sampleRate;
            f0 = meta.f0;
        } catch (Exception error) {
            close();
            throw error;
        }
    }

    String getTimingSummary() {
        String h = hubertMs >= 0 ? hubertMs + "ms" : "—";
        String r = rmvpeMs >= 0 ? rmvpeMs + "ms" : "—";
        String g = synthMs >= 0 ? synthMs + "ms" : "—";
        return "HuBERT " + h + " • F0 " + r + " • Gojo/RVC " + g + " • " + backend;
    }

    float[] convert48k(float[] audio48k, int transpose) throws Exception {
        if (audio48k == null || audio48k.length < 4_800) {
            throw new IllegalArgumentException("neural_chunk_too_short");
        }

        float[] audio16k = downsample48To16(audio48k);

        long start = System.nanoTime();
        Embedding embedding = extractEmbedding(audio16k);
        hubertMs = elapsedMs(start);

        int frames = embedding.frames * 2;
        float[] features = upsample2x(embedding.values, embedding.frames, embedding.channels);

        Pitch pitch = null;
        if (f0) {
            start = System.nanoTime();
            pitch = extractPitch(audio16k, frames, transpose);
            rmvpeMs = elapsedMs(start);
        } else {
            rmvpeMs = 0;
        }

        long[] coarse = pitch == null ? null : pitch.coarse;
        float[] pitchf = pitch == null ? null : pitch.pitchf;

        start = System.nanoTime();
        float[] generated = synthesize(features, frames, embedding.channels, coarse, pitchf);
        synthMs = elapsedMs(start);

        int rateConvertedLength = Math.max(1, Math.round(generated.length * OUTPUT_SR / (float) sampleRate));
        float[] at48k = resampleLinear(generated, rateConvertedLength);
        return at48k.length == audio48k.length ? at48k : resampleLinear(at48k, audio48k.length);
    }

    private SessionOpen openBaseOptimized(File file) throws Exception {
        int threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors()));
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            options.setInterOpNumThreads(1);
            options.setIntraOpNumThreads(1);
            options.setMemoryPatternOptimization(true);
            options.setCPUArenaAllocator(true);
            options.addConfigEntry("session.intra_op.allow_spinning", "1");
            options.addXnnpack(Map.of("intra_op_num_threads", Integer.toString(threads)));
            return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "XNNPACK" + threads);
        } catch (Exception ignored) {
            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                options.setInterOpNumThreads(1);
                options.setIntraOpNumThreads(threads);
                options.setMemoryPatternOptimization(true);
                options.setCPUArenaAllocator(true);
                options.addConfigEntry("session.intra_op.allow_spinning", "1");
                return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "CPU" + threads);
            }
        }
    }

    private SessionOpen openSynthOptimized(File file) throws Exception {
        // First choice: force NNAPI away from its CPU implementation so a successful
        // session really means the Android accelerator accepted the graph. FP16 lets
        // compatible NPU/GPU drivers reduce bandwidth and arithmetic cost.
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            options.setInterOpNumThreads(1);
            options.setIntraOpNumThreads(1);
            options.setMemoryPatternOptimization(true);
            options.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16, NNAPIFlags.CPU_DISABLED));
            return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "NNAPI-FP16-HW");
        } catch (Exception ignored) {
            // Some RVC graphs have a few operators NNAPI cannot accelerate. Let NNAPI
            // take supported subgraphs and use ORT CPU only for the remaining nodes.
            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                options.setInterOpNumThreads(1);
                options.setIntraOpNumThreads(1);
                options.setMemoryPatternOptimization(true);
                options.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16));
                return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "NNAPI-FP16");
            } catch (Exception ignoredAgain) {
                return openSynthCpuOptimized(file);
            }
        }
    }

    private SessionOpen openSynthCpuOptimized(File file) throws Exception {
        // The synthesizer dominates the measured cost on the Galaxy A06. It can use
        // two extra workers compared with the base models while leaving headroom for
        // AudioRecord/AudioTrack and the WebRTC VAD thread.
        int threads = Math.max(2, Math.min(6, Runtime.getRuntime().availableProcessors() - 1));
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            options.setInterOpNumThreads(1);
            options.setIntraOpNumThreads(1);
            options.setMemoryPatternOptimization(true);
            options.setCPUArenaAllocator(true);
            options.addConfigEntry("session.intra_op.allow_spinning", "1");
            options.addXnnpack(Map.of("intra_op_num_threads", Integer.toString(threads)));
            return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "XNNPACK" + threads);
        } catch (Exception ignored) {
            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                options.setInterOpNumThreads(1);
                options.setIntraOpNumThreads(threads);
                options.setMemoryPatternOptimization(true);
                options.setCPUArenaAllocator(true);
                options.addConfigEntry("session.intra_op.allow_spinning", "1");
                return new SessionOpen(env.createSession(file.getAbsolutePath(), options), "CPU" + threads);
            }
        }
    }

    private void validateSchemas() throws Exception {
        Map<String, NodeInfo> h = hubert.getInputInfo();
        boolean hubertOk = h.containsKey("audio")
            || h.containsKey("input_values")
            || h.containsKey("source");
        if (!hubertOk) throw new IllegalArgumentException("hubert_schema_incompatible");

        Map<String, NodeInfo> r = rmvpe.getInputInfo();
        boolean rmvpeOk = (r.containsKey("waveform") && r.containsKey("threshold"))
            || r.containsKey("input");
        if (!rmvpeOk) throw new IllegalArgumentException("rmvpe_schema_incompatible");

        Map<String, NodeInfo> s = synth.getInputInfo();
        boolean mio = s.containsKey("feats") && s.containsKey("p_len") && s.containsKey("sid");
        boolean standard = s.containsKey("phone") && s.containsKey("phone_lengths") && s.containsKey("sid");
        if (!mio && !standard) throw new IllegalArgumentException("rvc_synth_schema_incompatible");
    }

    private Embedding extractEmbedding(float[] audio16k) throws Exception {
        Map<String, NodeInfo> schema = hubert.getInputInfo();
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            if (schema.containsKey("audio")) {
                inputs.put("audio", floatTensor(audio16k, audioShape(schema.get("audio"), audio16k.length)));
            } else if (schema.containsKey("source")) {
                inputs.put("source", floatTensor(audio16k, audioShape(schema.get("source"), audio16k.length)));
                if (schema.containsKey("padding_mask")) {
                    long[] shape = maskShape(schema.get("padding_mask"), audio16k.length);
                    inputs.put("padding_mask", boolTensor(new byte[audio16k.length], shape));
                }
            } else if (schema.containsKey("input_values")) {
                inputs.put("input_values", floatTensor(audio16k, new long[]{1L, audio16k.length}));
                if (schema.containsKey("attention_mask")) {
                    NodeInfo info = schema.get("attention_mask");
                    TensorInfo tensorInfo = info != null && info.getInfo() instanceof TensorInfo ? (TensorInfo) info.getInfo() : null;
                    if (tensorInfo != null && tensorInfo.type == OnnxJavaType.BOOL) {
                        byte[] mask = new byte[audio16k.length];
                        for (int i = 0; i < mask.length; i++) mask[i] = 1;
                        inputs.put("attention_mask", boolTensor(mask, new long[]{1L, audio16k.length}));
                    } else {
                        long[] mask = new long[audio16k.length];
                        for (int i = 0; i < mask.length; i++) mask[i] = 1L;
                        inputs.put("attention_mask", OnnxTensor.createTensor(env, LongBuffer.wrap(mask), new long[]{1L, audio16k.length}));
                    }
                }
            } else {
                throw new IllegalArgumentException("hubert_schema_incompatible");
            }

            try (OrtSession.Result result = hubert.run(inputs, Set.of(hubertOutput))) {
                OnnxValue value = result.iterator().next().getValue();
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("hubert_output_not_tensor");
                OnnxTensor tensor = (OnnxTensor) value;
                long[] shape = tensor.getInfo().getShape();
                FloatBuffer buffer = tensor.getFloatBuffer();
                if (buffer == null) throw new IllegalArgumentException("hubert_output_type");
                float[] values = new float[buffer.remaining()];
                buffer.get(values);

                if (shape.length == 3 && shape[0] == 1L) {
                    return new Embedding(values, (int) shape[1], (int) shape[2]);
                }
                throw new IllegalArgumentException("hubert_output_shape");
            }
        } finally {
            closeTensors(inputs);
        }
    }

    private Pitch extractPitch(float[] audio16k, int targetFrames, int transpose) throws Exception {
        Map<String, NodeInfo> schema = rmvpe.getInputInfo();
        float[] rawPitch;

        if (schema.containsKey("waveform")) {
            try (OnnxTensor waveform = floatTensor(audio16k, audioShape(schema.get("waveform"), audio16k.length));
                 OnnxTensor threshold = floatTensor(new float[]{0.30f}, new long[]{1L})) {
                Map<String, OnnxTensor> inputs = new HashMap<>();
                inputs.put("waveform", waveform);
                inputs.put("threshold", threshold);
                try (OrtSession.Result result = rmvpe.run(inputs)) {
                    rawPitch = readPitchOutput(result.get(0), targetFrames);
                }
            }
        } else if (schema.containsKey("input")) {
            int melFrames = Math.max(32, (audio16k.length + RMVPE_HOP - 1) / RMVPE_HOP + 1);
            int paddedFrames = ((melFrames + 31) / 32) * 32;
            float[] mel = buildRmvpeMel(audio16k, paddedFrames);
            long[] shape = tensorRank(schema.get("input")) == 4
                ? new long[]{1L, 1L, RMVPE_MELS, paddedFrames}
                : new long[]{1L, RMVPE_MELS, paddedFrames};
            try (OnnxTensor input = floatTensor(mel, shape);
                 OrtSession.Result result = rmvpe.run(Map.of("input", input))) {
                OnnxValue value = result.get(0);
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("rmvpe_output_not_tensor");
                FloatBuffer buffer = ((OnnxTensor) value).getFloatBuffer();
                if (buffer == null) throw new IllegalArgumentException("rmvpe_output_type");
                float[] logits = new float[buffer.remaining()];
                buffer.get(logits);
                int availableFrames = logits.length / RMVPE_BINS;
                int usefulFrames = Math.min(melFrames, availableFrames);
                float[] decoded = new float[Math.max(1, usefulFrames)];
                for (int frame = 0; frame < decoded.length; frame++) {
                    int offset = frame * RMVPE_BINS;
                    int best = 0;
                    float confidence = 0f;
                    for (int bin = 0; bin < RMVPE_BINS && offset + bin < logits.length; bin++) {
                        float p = logits[offset + bin];
                        if (p > confidence) {
                            confidence = p;
                            best = bin;
                        }
                    }
                    decoded[frame] = confidence >= RMVPE_VOICED
                        ? (float) (32.7 * Math.pow(2.0, best / 60.0))
                        : 0f;
                }
                rawPitch = resamplePitch(decoded, targetFrames);
            }
        } else {
            throw new IllegalArgumentException("rmvpe_schema_incompatible");
        }

        if (transpose != 0) {
            float factor = (float) Math.pow(2.0, transpose / 12.0);
            for (int i = 0; i < rawPitch.length; i++) {
                if (rawPitch[i] > 0f) rawPitch[i] *= factor;
            }
        }
        return new Pitch(rawPitch, melQuantize(rawPitch));
    }

    private float[] readPitchOutput(OnnxValue value, int targetFrames) throws Exception {
        if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("rmvpe_output_not_tensor");
        FloatBuffer buffer = ((OnnxTensor) value).getFloatBuffer();
        if (buffer == null) throw new IllegalArgumentException("rmvpe_output_type");
        float[] values = new float[buffer.remaining()];
        buffer.get(values);
        return resamplePitch(values, targetFrames);
    }

    private float[] synthesize(float[] feats, int frames, int channels, long[] pitch, float[] pitchf) throws Exception {
        Map<String, NodeInfo> schema = synth.getInputInfo();
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            if (schema.containsKey("feats")) {
                inputs.put("feats", floatTensor(feats, new long[]{1L, frames, channels}));
                inputs.put("p_len", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{frames}), new long[]{1L}));
                inputs.put("sid", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{0L}), new long[]{1L}));
                if (f0 && schema.containsKey("pitch")) {
                    inputs.put("pitch", OnnxTensor.createTensor(env, LongBuffer.wrap(pitch), new long[]{1L, frames}));
                    String continuous = schema.containsKey("pitchf") ? "pitchf" : "nsff0";
                    inputs.put(continuous, floatTensor(pitchf, new long[]{1L, frames}));
                }
            } else {
                inputs.put("phone", floatTensor(feats, new long[]{1L, frames, channels}));
                inputs.put("phone_lengths", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{frames}), new long[]{1L}));
                inputs.put("sid", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{0L}), new long[]{1L}));
                if (f0 && schema.containsKey("pitch")) {
                    inputs.put("pitch", OnnxTensor.createTensor(env, LongBuffer.wrap(pitch), new long[]{1L, frames}));
                    String continuous = schema.containsKey("nsff0") ? "nsff0" : "pitchf";
                    inputs.put(continuous, floatTensor(pitchf, new long[]{1L, frames}));
                }
            }

            String outputName = synth.getOutputInfo().containsKey("audio")
                ? "audio"
                : synth.getOutputInfo().keySet().iterator().next();
            try (OrtSession.Result result = synth.run(inputs, Set.of(outputName))) {
                OnnxValue value = result.iterator().next().getValue();
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("synth_output_not_tensor");
                FloatBuffer buffer = ((OnnxTensor) value).getFloatBuffer();
                if (buffer == null) throw new IllegalArgumentException("synth_output_type");
                float[] out = new float[buffer.remaining()];
                buffer.get(out);
                for (int i = 0; i < out.length; i++) out[i] = clamp(out[i], -1f, 1f);
                return out;
            }
        } finally {
            closeTensors(inputs);
        }
    }

    private String chooseHubertOutput(OrtSession session) throws Exception {
        for (String name : new String[]{"unit12", "units9", "unit12s", "hidden_states", "last_hidden_state", "embed", "embedder_output"}) {
            if (session.getOutputInfo().containsKey(name)) return name;
        }
        if (!session.getOutputInfo().isEmpty()) return session.getOutputInfo().keySet().iterator().next();
        throw new IllegalArgumentException("hubert_has_no_outputs");
    }

    private static ModelMeta readModelMeta(OrtSession session) throws Exception {
        int rate = 40_000;
        Map<String, NodeInfo> inputs = session.getInputInfo();
        boolean usesF0 = inputs.containsKey("pitch") && (inputs.containsKey("pitchf") || inputs.containsKey("nsff0"));
        Map<String, String> custom = session.getMetadata().getCustomMetadata();

        String direct = firstNonBlank(custom.get("samplingRate"), custom.get("sampleRate"), custom.get("sample_rate"));
        if (direct != null) {
            try { rate = Integer.parseInt(direct.replaceAll("[^0-9]", "")); } catch (Exception ignored) {}
        }
        String raw = custom.get("metadata");
        if (raw != null && !raw.isBlank()) {
            try {
                JSONObject json = new JSONObject(raw);
                rate = json.optInt("samplingRate", json.optInt("sampleRate", rate));
                usesF0 = json.optBoolean("f0", usesF0);
            } catch (Exception ignored) {}
        }
        if (rate < 16_000 || rate > 96_000) rate = 40_000;
        return new ModelMeta(rate, usesF0);
    }

    private float[] buildRmvpeMel(float[] audio, int frames) {
        float[] mel = new float[RMVPE_MELS * frames];
        double[] real = new double[RMVPE_FFT];
        double[] imag = new double[RMVPE_FFT];
        double[] power = new double[RMVPE_FFT / 2 + 1];

        for (int frame = 0; frame < frames; frame++) {
            int center = frame * RMVPE_HOP;
            int start = center - RMVPE_FFT / 2;
            for (int i = 0; i < RMVPE_FFT; i++) {
                int index = start + i;
                real[i] = index >= 0 && index < audio.length ? audio[index] * HANN[i] : 0.0;
                imag[i] = 0.0;
            }
            fft(real, imag);
            for (int bin = 0; bin < power.length; bin++) {
                power[bin] = real[bin] * real[bin] + imag[bin] * imag[bin];
            }
            for (int m = 0; m < RMVPE_MELS; m++) {
                int offset = m * power.length;
                double energy = 0.0;
                for (int bin = 0; bin < power.length; bin++) {
                    energy += power[bin] * MEL_FILTER[offset + bin];
                }
                mel[m * frames + frame] = (float) Math.log(Math.max(1e-5, energy));
            }
        }
        return mel;
    }

    private static float[] buildHann() {
        float[] window = new float[RMVPE_FFT];
        for (int i = 0; i < window.length; i++) {
            window[i] = (float) (0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / RMVPE_FFT));
        }
        return window;
    }

    private static float[] buildMelFilterbank() {
        int bins = RMVPE_FFT / 2 + 1;
        float[] weights = new float[RMVPE_MELS * bins];
        double melMin = hzToMel(30.0);
        double melMax = hzToMel(8_000.0);
        double[] hz = new double[RMVPE_MELS + 2];
        for (int i = 0; i < hz.length; i++) {
            double mel = melMin + (melMax - melMin) * i / (hz.length - 1.0);
            hz[i] = melToHz(mel);
        }
        int[] points = new int[hz.length];
        for (int i = 0; i < points.length; i++) {
            points[i] = Math.max(0, Math.min(bins - 1, (int) Math.floor((RMVPE_FFT + 1) * hz[i] / INPUT_SR)));
        }
        for (int m = 0; m < RMVPE_MELS; m++) {
            int left = points[m];
            int center = Math.max(left + 1, points[m + 1]);
            int right = Math.max(center + 1, points[m + 2]);
            right = Math.min(bins, right);
            for (int bin = left; bin < center && bin < bins; bin++) {
                weights[m * bins + bin] = (bin - left) / (float) Math.max(1, center - left);
            }
            for (int bin = center; bin < right; bin++) {
                weights[m * bins + bin] = (right - bin) / (float) Math.max(1, right - center);
            }
        }
        return weights;
    }

    private static void fft(double[] real, double[] imag) {
        int n = real.length;
        int j = 0;
        for (int i = 1; i < n; i++) {
            int bit = n >> 1;
            while ((j & bit) != 0) {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if (i < j) {
                double t = real[i]; real[i] = real[j]; real[j] = t;
                t = imag[i]; imag[i] = imag[j]; imag[j] = t;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double angle = -2.0 * Math.PI / len;
            double wLenR = Math.cos(angle);
            double wLenI = Math.sin(angle);
            for (int i = 0; i < n; i += len) {
                double wr = 1.0;
                double wi = 0.0;
                for (int k = 0; k < len / 2; k++) {
                    int even = i + k;
                    int odd = even + len / 2;
                    double or = real[odd] * wr - imag[odd] * wi;
                    double oi = real[odd] * wi + imag[odd] * wr;
                    real[odd] = real[even] - or;
                    imag[odd] = imag[even] - oi;
                    real[even] += or;
                    imag[even] += oi;
                    double nextWr = wr * wLenR - wi * wLenI;
                    wi = wr * wLenI + wi * wLenR;
                    wr = nextWr;
                }
            }
        }
    }

    private static float[] downsample48To16(float[] input) {
        int length = input.length / 3;
        float[] out = new float[length];
        for (int i = 0; i < length; i++) {
            int p = i * 3;
            out[i] = (input[p] + input[p + 1] + input[p + 2]) / 3f;
        }
        return out;
    }

    private static float[] upsample2x(float[] input, int frames, int channels) {
        float[] out = new float[frames * 2 * channels];
        for (int frame = 0; frame < frames; frame++) {
            int src = frame * channels;
            int dst = frame * 2 * channels;
            System.arraycopy(input, src, out, dst, channels);
            System.arraycopy(input, src, out, dst + channels, channels);
        }
        return out;
    }

    private static float[] resamplePitch(float[] source, int target) {
        if (target <= 0) return new float[0];
        if (source.length == target) return source.clone();
        if (source.length == 0) return new float[target];
        if (source.length == 1) {
            float[] out = new float[target];
            for (int i = 0; i < target; i++) out[i] = source[0];
            return out;
        }
        float[] out = new float[target];
        double scale = (source.length - 1.0) / Math.max(1.0, target - 1.0);
        for (int i = 0; i < target; i++) {
            double pos = i * scale;
            int a = (int) pos;
            int b = Math.min(source.length - 1, a + 1);
            float f = (float) (pos - a);
            out[i] = source[a] * (1f - f) + source[b] * f;
        }
        return out;
    }

    private static long[] melQuantize(float[] pitchf) {
        final float f0Min = 50f;
        final float f0Max = 1100f;
        final float melMin = (float) (1127.0 * Math.log(1.0 + f0Min / 700.0));
        final float melMax = (float) (1127.0 * Math.log(1.0 + f0Max / 700.0));
        long[] result = new long[pitchf.length];
        for (int i = 0; i < pitchf.length; i++) {
            float scaled = 1f;
            if (pitchf[i] > 0f) {
                float mel = (float) (1127.0 * Math.log(1.0 + pitchf[i] / 700.0));
                scaled = (mel - melMin) * 254f / (melMax - melMin) + 1f;
            }
            result[i] = Math.round(clamp(scaled, 1f, 255f));
        }
        return result;
    }

    private static float[] resampleLinear(float[] source, int targetLength) {
        if (targetLength <= 0) return new float[0];
        if (source.length == targetLength) return source.clone();
        if (source.length == 0) return new float[targetLength];
        if (targetLength == 1) return new float[]{source[0]};
        float[] out = new float[targetLength];
        double scale = (source.length - 1.0) / (targetLength - 1.0);
        for (int i = 0; i < targetLength; i++) {
            double pos = i * scale;
            int a = (int) pos;
            int b = Math.min(source.length - 1, a + 1);
            float f = (float) (pos - a);
            out[i] = source[a] * (1f - f) + source[b] * f;
        }
        return out;
    }

    private OnnxTensor floatTensor(float[] values, long[] shape) throws OrtException {
        return OnnxTensor.createTensor(env, FloatBuffer.wrap(values), shape);
    }

    private OnnxTensor boolTensor(byte[] values, long[] shape) throws OrtException {
        return OnnxTensor.createTensor(env, ByteBuffer.wrap(values), shape, OnnxJavaType.BOOL);
    }

    private static long[] audioShape(NodeInfo info, int length) {
        return tensorRank(info) == 3 ? new long[]{1L, 1L, length} : new long[]{1L, length};
    }

    private static long[] maskShape(NodeInfo info, int length) {
        return tensorRank(info) == 3 ? new long[]{1L, 1L, length} : new long[]{1L, length};
    }

    private static int tensorRank(NodeInfo info) {
        if (info != null && info.getInfo() instanceof TensorInfo) {
            return ((TensorInfo) info.getInfo()).getShape().length;
        }
        return 2;
    }

    private static void closeTensors(Map<String, OnnxTensor> tensors) {
        for (OnnxTensor tensor : tensors.values()) {
            try { tensor.close(); } catch (Exception ignored) {}
        }
    }

    private static int elapsedMs(long start) {
        return (int) Math.min(Integer.MAX_VALUE, (System.nanoTime() - start) / 1_000_000L);
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) if (value != null && !value.isBlank()) return value;
        return null;
    }

    private static double hzToMel(double hz) {
        return 2595.0 * Math.log10(1.0 + hz / 700.0);
    }

    private static double melToHz(double mel) {
        return 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    @Override
    public void close() {
        closeSession(synth);
        closeSession(rmvpe);
        closeSession(hubert);
        synth = null;
        rmvpe = null;
        hubert = null;
    }

    private static void closeSession(OrtSession session) {
        try { if (session != null) session.close(); } catch (Exception ignored) {}
    }

    private static final class SessionOpen {
        final OrtSession session;
        final String backend;
        SessionOpen(OrtSession session, String backend) { this.session = session; this.backend = backend; }
    }

    private static final class ModelMeta {
        final int sampleRate;
        final boolean f0;
        ModelMeta(int sampleRate, boolean f0) { this.sampleRate = sampleRate; this.f0 = f0; }
    }

    private static final class Embedding {
        final float[] values;
        final int frames;
        final int channels;
        Embedding(float[] values, int frames, int channels) {
            this.values = values;
            this.frames = frames;
            this.channels = channels;
        }
    }

    private static final class Pitch {
        final float[] pitchf;
        final long[] coarse;
        Pitch(float[] pitchf, long[] coarse) { this.pitchf = pitchf; this.coarse = coarse; }
    }
}
