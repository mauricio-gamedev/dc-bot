package io.github.astromg01.miovoice;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;

import org.json.JSONObject;

import java.io.File;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Minimal on-device RVC inference path for Mio Voice.
 *
 * Compatible with voice-changer style ONNX exports: ContentVec/HuBERT + RMVPE
 * + RVC synthesizer. The audio never leaves the phone.
 */
final class RvcNeuralEngine implements AutoCloseable {
    static final class ModelInfo {
        final String label;
        final int sampleRate;
        final boolean f0;

        ModelInfo(String label, int sampleRate, boolean f0) {
            this.label = label;
            this.sampleRate = sampleRate;
            this.f0 = f0;
        }
    }

    private final OrtEnvironment env = OrtEnvironment.getEnvironment();
    private OrtSession hubert;
    private OrtSession rmvpe;
    private OrtSession synth;
    private ModelInfo modelInfo;
    private String hubertOutput;
    private int embOutputLayer = 12;
    private boolean useFinalProj = false;

    RvcNeuralEngine(File hubertFile, File rmvpeFile, File synthFile, String label) throws Exception {
        if (!hubertFile.isFile() || !rmvpeFile.isFile() || !synthFile.isFile()) {
            throw new IllegalArgumentException("neural_models_missing");
        }
        try {
            hubert = open(hubertFile);
            rmvpe = open(rmvpeFile);
            synth = open(synthFile);
            modelInfo = readModelInfo(synth, label);
            hubertOutput = chooseHubertOutput(hubert);
            validateSchemas();
        } catch (Exception error) {
            close();
            throw error;
        }
    }

    static ModelInfo inspectSynth(File synthFile, String label) throws Exception {
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions options = new OrtSession.SessionOptions();
             OrtSession session = env.createSession(synthFile.getAbsolutePath(), options)) {
            if (!session.getInputInfo().containsKey("feats")
                || !session.getInputInfo().containsKey("p_len")
                || !session.getInputInfo().containsKey("sid")) {
                throw new IllegalArgumentException("rvc_synth_schema_incompatible");
            }
            return readModelInfo(session, label);
        }
    }

    ModelInfo getModelInfo() {
        return modelInfo;
    }

    float[] convert48k(float[] audio48k, int transpose) throws Exception {
        if (audio48k == null || audio48k.length < 4800) {
            throw new IllegalArgumentException("neural_chunk_too_short");
        }
        float[] audio16k = downsample48To16(audio48k);
        Embedding embedding = extractEmbedding(audio16k);
        Pitch pitch = modelInfo.f0 ? extractPitch(audio16k, transpose) : null;

        int frames2x = embedding.frames * 2;
        float[] features2x = upsample2x(embedding.values, embedding.frames, embedding.channels);
        int targetFrames = pitch == null ? frames2x : Math.min(frames2x, pitch.pitchf.length);
        float[] features = features2x;
        if (targetFrames != frames2x) {
            features = new float[targetFrames * embedding.channels];
            System.arraycopy(features2x, 0, features, 0, features.length);
        }

        long[] coarse = null;
        float[] pitchf = null;
        if (pitch != null) {
            coarse = new long[targetFrames];
            pitchf = new float[targetFrames];
            System.arraycopy(pitch.coarse, 0, coarse, 0, targetFrames);
            System.arraycopy(pitch.pitchf, 0, pitchf, 0, targetFrames);
        }

        float[] generated = synthesize(features, targetFrames, embedding.channels, coarse, pitchf);
        int rateConvertedLength = Math.max(1, Math.round(generated.length * 48_000f / modelInfo.sampleRate));
        float[] at48k = resampleLinear(generated, rateConvertedLength);

        if (at48k.length == audio48k.length) return at48k;
        return resampleLinear(at48k, audio48k.length);
    }

    private OrtSession open(File file) throws OrtException {
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        options.setIntraOpNumThreads(2);
        options.setInterOpNumThreads(1);
        return env.createSession(file.getAbsolutePath(), options);
    }

    private void validateSchemas() throws OrtException {
        requireInput(hubert, "audio");
        requireInput(rmvpe, "waveform");
        requireInput(rmvpe, "threshold");
        requireInput(synth, "feats");
        requireInput(synth, "p_len");
        requireInput(synth, "sid");
        if (modelInfo.f0) {
            requireInput(synth, "pitch");
            requireInput(synth, "pitchf");
        }

        NodeInfo feats = synth.getInputInfo().get("feats");
        if (feats != null && feats.getInfo() instanceof TensorInfo) {
            OnnxJavaType type = ((TensorInfo) feats.getInfo()).type;
            if (type != OnnxJavaType.FLOAT) {
                throw new IllegalArgumentException("rvc_fp16_not_supported_yet");
            }
        }
    }

    private static void requireInput(OrtSession session, String name) throws OrtException {
        if (!session.getInputInfo().containsKey(name)) {
            throw new IllegalArgumentException("onnx_input_missing:" + name);
        }
    }

    private Embedding extractEmbedding(float[] audio16k) throws Exception {
        try (OnnxTensor audio = OnnxTensor.createTensor(env, FloatBuffer.wrap(audio16k), new long[]{1L, audio16k.length});
             OrtSession.Result result = hubert.run(Map.of("audio", audio), Set.of(hubertOutput))) {
            OnnxValue value = result.iterator().next().getValue();
            if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("hubert_output_not_tensor");
            OnnxTensor tensor = (OnnxTensor) value;
            long[] shape = tensor.getInfo().getShape();
            if (shape.length != 3 || shape[0] != 1L || shape[1] <= 0 || shape[2] <= 0) {
                throw new IllegalArgumentException("hubert_output_shape");
            }
            FloatBuffer buffer = tensor.getFloatBuffer();
            if (buffer == null) throw new IllegalArgumentException("hubert_output_type");
            float[] values = new float[buffer.remaining()];
            buffer.get(values);
            return new Embedding(values, (int) shape[1], (int) shape[2]);
        }
    }

    private Pitch extractPitch(float[] audio16k, int transpose) throws Exception {
        try (OnnxTensor waveform = OnnxTensor.createTensor(env, FloatBuffer.wrap(audio16k), new long[]{1L, audio16k.length});
             OnnxTensor threshold = OnnxTensor.createTensor(env, FloatBuffer.wrap(new float[]{0.30f}), new long[]{1L})) {
            Map<String, OnnxTensor> inputs = new HashMap<>();
            inputs.put("waveform", waveform);
            inputs.put("threshold", threshold);
            try (OrtSession.Result result = rmvpe.run(inputs)) {
                OnnxValue value = result.get(0);
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("rmvpe_output_not_tensor");
                FloatBuffer buffer = ((OnnxTensor) value).getFloatBuffer();
                if (buffer == null) throw new IllegalArgumentException("rmvpe_output_type");
                float[] pitchf = new float[buffer.remaining()];
                buffer.get(pitchf);

                if (transpose != 0) {
                    float factor = (float) Math.pow(2.0, transpose / 12.0);
                    for (int i = 0; i < pitchf.length; i++) pitchf[i] *= factor;
                }
                long[] coarse = melQuantize(pitchf);
                return new Pitch(pitchf, coarse);
            }
        }
    }

    private float[] synthesize(
        float[] feats,
        int frames,
        int channels,
        long[] pitch,
        float[] pitchf
    ) throws Exception {
        Map<String, OnnxTensor> inputs = new HashMap<>();
        try {
            inputs.put("feats", OnnxTensor.createTensor(env, FloatBuffer.wrap(feats), new long[]{1L, frames, channels}));
            inputs.put("p_len", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{frames}), new long[]{1L}));
            inputs.put("sid", OnnxTensor.createTensor(env, LongBuffer.wrap(new long[]{0L}), new long[]{1L}));
            if (modelInfo.f0) {
                inputs.put("pitch", OnnxTensor.createTensor(env, LongBuffer.wrap(pitch), new long[]{1L, frames}));
                inputs.put("pitchf", OnnxTensor.createTensor(env, FloatBuffer.wrap(pitchf), new long[]{1L, frames}));
            }

            Set<String> requested = synth.getOutputInfo().containsKey("audio") ? Set.of("audio") : synth.getOutputInfo().keySet();
            try (OrtSession.Result result = synth.run(inputs, requested)) {
                OnnxValue value = result.iterator().next().getValue();
                if (!(value instanceof OnnxTensor)) throw new IllegalArgumentException("synth_output_not_tensor");
                FloatBuffer buffer = ((OnnxTensor) value).getFloatBuffer();
                if (buffer == null) throw new IllegalArgumentException("synth_output_type");
                float[] audio = new float[buffer.remaining()];
                buffer.get(audio);
                for (int i = 0; i < audio.length; i++) audio[i] = clamp(audio[i], -1f, 1f);
                return audio;
            }
        } finally {
            for (OnnxTensor tensor : inputs.values()) {
                try { tensor.close(); } catch (Exception ignored) {}
            }
        }
    }

    private String chooseHubertOutput(OrtSession session) throws OrtException {
        String preferred;
        if (embOutputLayer == 9 && useFinalProj) preferred = "units9";
        else if (embOutputLayer == 12 && useFinalProj) preferred = "unit12s";
        else preferred = "unit12";
        if (session.getOutputInfo().containsKey(preferred)) return preferred;
        for (String candidate : new String[]{"unit12", "units9", "unit12s"}) {
            if (session.getOutputInfo().containsKey(candidate)) return candidate;
        }
        if (!session.getOutputInfo().isEmpty()) return session.getOutputInfo().keySet().iterator().next();
        throw new IllegalArgumentException("hubert_has_no_outputs");
    }

    private static ModelInfo readModelInfo(OrtSession session, String label) throws Exception {
        int sampleRate = 40_000;
        boolean f0 = true;
        String raw = session.getMetadata().getCustomMetadata().get("metadata");
        if (raw != null && !raw.isBlank()) {
            JSONObject metadata = new JSONObject(raw);
            sampleRate = metadata.optInt("samplingRate", metadata.optInt("sampleRate", sampleRate));
            f0 = metadata.optBoolean("f0", f0);
        }
        if (sampleRate < 16_000 || sampleRate > 96_000) {
            throw new IllegalArgumentException("rvc_sample_rate_invalid");
        }
        return new ModelInfo(label == null || label.isBlank() ? "Voz RVC" : label, sampleRate, f0);
    }

    private static float[] downsample48To16(float[] input) {
        int length = input.length / 3;
        float[] output = new float[length];
        for (int i = 0; i < length; i++) {
            int p = i * 3;
            output[i] = (input[p] + input[p + 1] + input[p + 2]) / 3f;
        }
        return output;
    }

    private static float[] upsample2x(float[] input, int frames, int channels) {
        float[] output = new float[frames * 2 * channels];
        for (int frame = 0; frame < frames; frame++) {
            int source = frame * channels;
            int target = frame * 2 * channels;
            System.arraycopy(input, source, output, target, channels);
            System.arraycopy(input, source, output, target + channels, channels);
        }
        return output;
    }

    private static long[] melQuantize(float[] pitchf) {
        final float f0Min = 50f;
        final float f0Max = 1100f;
        final float melMin = (float) (1127.0 * Math.log(1.0 + f0Min / 700.0));
        final float melMax = (float) (1127.0 * Math.log(1.0 + f0Max / 700.0));
        long[] result = new long[pitchf.length];
        for (int i = 0; i < pitchf.length; i++) {
            float f = pitchf[i];
            float scaled = 1f;
            if (f > 0f) {
                float mel = (float) (1127.0 * Math.log(1.0 + f / 700.0));
                if (mel > 0f) scaled = (mel - melMin) * 254f / (melMax - melMin) + 1f;
            }
            result[i] = Math.round(clamp(scaled, 1f, 255f));
        }
        return result;
    }

    private static float[] resampleLinear(float[] source, int targetLength) {
        if (source.length == targetLength) return source.clone();
        if (source.length == 0) return new float[targetLength];
        if (targetLength <= 1) return new float[]{source[0]};
        float[] output = new float[targetLength];
        double scale = (source.length - 1.0) / (targetLength - 1.0);
        for (int i = 0; i < targetLength; i++) {
            double position = i * scale;
            int a = (int) position;
            int b = Math.min(source.length - 1, a + 1);
            float fraction = (float) (position - a);
            output[i] = source[a] * (1f - fraction) + source[b] * fraction;
        }
        return output;
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
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {}
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
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

        Pitch(float[] pitchf, long[] coarse) {
            this.pitchf = pitchf;
            this.coarse = coarse;
        }
    }
}
