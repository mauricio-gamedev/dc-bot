package io.github.astromg01.miovoice;

import com.konovalov.vad.webrtc.Vad;
import com.konovalov.vad.webrtc.VadWebRTC;
import com.konovalov.vad.webrtc.config.FrameSize;
import com.konovalov.vad.webrtc.config.Mode;
import com.konovalov.vad.webrtc.config.SampleRate;

/**
 * Speech detector for the game microphone path.
 *
 * WebRTC VAD decides whether a 10 ms frame resembles human speech. Mio Voice
 * adds a near-field energy check and transient rejection so a fan, tap, click
 * or distant room noise is less likely to open the gate.
 */
final class StrictVad implements AutoCloseable {
    static final class Result {
        final boolean speech;
        final int confidence;

        Result(boolean speech, int confidence) {
            this.speech = speech;
            this.confidence = confidence;
        }
    }

    private static final int FRAME = 480; // 10 ms @ 48 kHz

    private final VadWebRTC vad;
    private final short[] frame = new short[FRAME];
    private int framePosition = 0;

    private float noiseRms = 0.0035f;
    private float nearVoiceRms = 0.035f;
    private boolean lastSpeech = false;
    private int lastConfidence = 0;

    StrictVad() {
        vad = Vad.builder()
            .setSampleRate(SampleRate.SAMPLE_RATE_48K)
            .setFrameSize(FrameSize.FRAME_SIZE_480)
            .setMode(Mode.VERY_AGGRESSIVE)
            .setSpeechDurationMs(40)
            .setSilenceDurationMs(220)
            .build();
    }

    Result analyze(short[] input, int length, float focus, boolean enabled) {
        if (!enabled || input == null || length <= 0) {
            lastSpeech = false;
            lastConfidence = 0;
            return new Result(false, 0);
        }

        float safeFocus = clamp(focus, 0f, 1f);
        for (int i = 0; i < length; i++) {
            frame[framePosition++] = input[i];
            if (framePosition == FRAME) {
                evaluateFrame(safeFocus);
                framePosition = 0;
            }
        }
        return new Result(lastSpeech, lastConfidence);
    }

    private void evaluateFrame(float focus) {
        double energy = 0.0;
        float peak = 0f;
        int zeroCrossings = 0;
        float previous = frame[0] / 32768f;
        for (short value : frame) {
            float sample = value / 32768f;
            energy += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
            if ((sample >= 0f) != (previous >= 0f)) zeroCrossings++;
            previous = sample;
        }

        float rms = (float) Math.sqrt(energy / FRAME);
        float currentNoise = Math.max(0.0008f, noiseRms);
        float snrDb = (float) (20.0 * Math.log10((rms + 1.0e-5f) / (currentNoise + 1.0e-5f)));
        float crest = peak / Math.max(0.0001f, rms);
        float zcr = zeroCrossings / (float) FRAME;

        boolean webRtcSpeech;
        try {
            webRtcSpeech = vad.isSpeech(frame);
        } catch (Exception ignored) {
            webRtcSpeech = false;
        }

        // Focus raises both SNR and near-field requirements. At 100%, a short
        // distant sound needs to be substantially louder than the learned room
        // floor and still look like speech to WebRTC before the gate opens.
        float requiredSnr = 5.0f + focus * 6.5f;
        float floorMultiplier = 2.0f + focus * 2.2f;
        float absoluteFloor = 0.0028f + focus * 0.0032f;
        float learnedNearFloor = nearVoiceRms * (0.12f + focus * 0.10f);
        float requiredRms = Math.max(absoluteFloor, Math.max(currentNoise * floorMultiplier, learnedNearFloor));

        // Sharp clicks/taps tend to have a huge crest factor and almost no
        // sustained speech texture. Very low/high zero-crossing frames are also
        // suspicious unless the signal is clearly strong.
        boolean transientLike = crest > (7.8f - focus * 1.8f) && rms < 0.07f;
        boolean textureOk = (zcr > 0.008f && zcr < 0.34f) || rms > requiredRms * 2.2f;
        boolean candidate = webRtcSpeech
            && rms >= requiredRms
            && snrDb >= requiredSnr
            && !transientLike
            && textureOk;

        if (candidate) {
            // Learn the typical close voice level slowly. This makes distant
            // speech/noise less likely to take over after the user has spoken.
            nearVoiceRms += (rms - nearVoiceRms) * 0.035f;
            nearVoiceRms = clamp(nearVoiceRms, 0.010f, 0.20f);
        } else if (!webRtcSpeech && rms < currentNoise * 2.5f) {
            float rate = rms < noiseRms ? 0.055f : 0.006f;
            noiseRms += (rms - noiseRms) * rate;
            noiseRms = clamp(noiseRms, 0.0008f, 0.035f);
        }

        int confidence = Math.round(clamp((snrDb - requiredSnr + 5f) / 15f, 0f, 1f) * 100f);
        if (candidate) confidence = Math.max(55, confidence);
        else if (!webRtcSpeech) confidence = Math.min(confidence, 18);

        lastSpeech = candidate;
        lastConfidence = candidate
            ? Math.max(lastConfidence > 0 ? Math.round(lastConfidence * 0.55f) : 0, confidence)
            : Math.max(0, Math.round(lastConfidence * 0.55f));
    }

    @Override
    public void close() {
        try {
            vad.close();
        } catch (Exception ignored) {}
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }
}
