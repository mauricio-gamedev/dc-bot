package io.github.astromg01.miovoice;

import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class VoiceApi {
    static final String BASE_URL = "https://dc-bot-us5v.onrender.com";

    static final class PairResult {
        final String token;
        final String presetLabel;

        PairResult(String token, String presetLabel) {
            this.token = token;
            this.presetLabel = presetLabel;
        }
    }

    static final class Config {
        final long revision;
        final String preset;
        final String label;
        final int intensity;
        final double mix;
        final double pitch;
        final double formant;
        final double bass;
        final double presence;
        final double drive;
        final double reverb;
        final double robot;
        final int pollAfterMs;

        Config(long revision, JSONObject config, int pollAfterMs) {
            this.revision = revision;
            this.preset = config.optString("preset", "normal");
            this.label = config.optString("label", "Normal");
            this.intensity = config.optInt("intensity", 70);
            this.mix = config.optDouble("mix", 0.7);
            JSONObject dsp = config.optJSONObject("dsp");
            if (dsp == null) dsp = new JSONObject();
            this.pitch = dsp.optDouble("pitch", 0.0);
            this.formant = dsp.optDouble("formant", 0.0);
            this.bass = dsp.optDouble("bass", 0.0);
            this.presence = dsp.optDouble("presence", 0.0);
            this.drive = dsp.optDouble("drive", 0.0);
            this.reverb = dsp.optDouble("reverb", 0.0);
            this.robot = dsp.optDouble("robot", 0.0);
            this.pollAfterMs = Math.max(500, Math.min(5000, pollAfterMs));
        }

        static Config normal() {
            try {
                JSONObject value = new JSONObject();
                value.put("preset", "normal");
                value.put("label", "Normal");
                value.put("intensity", 70);
                value.put("mix", 0.7);
                value.put("dsp", new JSONObject());
                return new Config(0, value, 1000);
            } catch (Exception impossible) {
                throw new IllegalStateException(impossible);
            }
        }
    }

    static PairResult pair(String code) throws Exception {
        JSONObject body = deviceReport("monitor");
        body.put("code", code);
        JSONObject response = request("POST", "/voice/pair", null, body);
        String token = response.optString("token", "");
        if (token.isEmpty()) throw new IllegalStateException("token ausente");
        JSONObject config = response.optJSONObject("config");
        String label = config == null ? "Normal" : config.optString("label", "Normal");
        return new PairResult(token, label);
    }

    static Config pull(String token) throws Exception {
        JSONObject response = request("GET", "/voice/pull", token, null);
        JSONObject config = response.optJSONObject("config");
        if (config == null) throw new IllegalStateException("config ausente");
        return new Config(
            response.optLong("revision", 0),
            config,
            response.optInt("pollAfterMs", 1000)
        );
    }

    static void report(String token, String route, int latencyMs) throws Exception {
        JSONObject body = deviceReport(route);
        body.put("latencyMs", Math.max(0, latencyMs));
        request("POST", "/voice/report", token, body);
    }

    private static JSONObject deviceReport(String route) throws Exception {
        JSONObject body = new JSONObject();
        body.put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
        body.put("androidVersion", Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")");
        body.put("engine", "mio-dsp-java-v1");
        body.put("route", route);
        return body;
    }

    private static JSONObject request(String method, String path, String token, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
        connection.setConnectTimeout(12_000);
        connection.setReadTimeout(12_000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "MioVoice-Android/0.1");
        if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);

        if (body != null) {
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }
        }

        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(stream);
        connection.disconnect();

        JSONObject response = text.isEmpty() ? new JSONObject() : new JSONObject(text);
        if (code < 200 || code >= 300 || !response.optBoolean("ok", false)) {
            String error = response.optString("error", "HTTP " + code);
            throw new IllegalStateException(error);
        }
        return response;
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }

    private VoiceApi() {}
}
