package miojoplays;

import arc.Core;
import arc.Events;
import arc.util.Threads;
import arc.util.Timer;
import arc.util.serialization.Jval;
import mindustry.Vars;
import mindustry.content.Items;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.mod.Mod;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

public class MiojoPlaysInteractiveMod extends Mod {
    private static final String API_BASE = "https://dc-bot-us5v.onrender.com";
    private static final String TOKEN_KEY = "miojo-interactive-token";
    private static final float POLL_SECONDS = 1.5f;

    private final AtomicBoolean polling = new AtomicBoolean(false);
    private volatile boolean started;

    @Override
    public void init() {
        Events.on(ClientLoadEvent.class, event -> Core.app.post(() -> {
            String token = Core.settings.getString(TOKEN_KEY, "").trim();
            if (token.isEmpty()) {
                requestPairCode();
            } else {
                startPolling();
            }
        }));
    }

    private void requestPairCode() {
        Vars.ui.showTextInput(
            "MiojoPlays Interactive",
            "Digite o código de 6 dígitos gerado por /mindustry vincular no Discord.",
            6,
            "",
            true,
            this::pair
        );
    }

    private void pair(String code) {
        String normalized = code == null ? "" : code.trim();
        if (normalized.length() != 6) {
            Vars.ui.showErrorMessage("Código inválido. Gere outro com /mindustry vincular.");
            return;
        }

        Threads.daemon(() -> {
            try {
                String response = request("POST", "/mindustry/pair", null, "{\"code\":\"" + normalized + "\"}");
                Jval json = Jval.read(response);
                if (!json.getBool("ok", false)) throw new IllegalStateException("Pareamento recusado");

                String token = json.getString("token", "");
                if (token.isEmpty()) throw new IllegalStateException("Token ausente");

                Core.settings.put(TOKEN_KEY, token);
                Core.settings.manualSave();
                Core.app.post(() -> {
                    Vars.ui.showInfo("[accent]MiojoPlays Interactive[] vinculado com sucesso.\n\nO Discord já pode detectar este jogo.");
                    startPolling();
                });
            } catch (Throwable error) {
                Core.app.post(() -> Vars.ui.showErrorMessage("Falha ao vincular com o bot: " + error.getMessage()));
            }
        });
    }

    private void startPolling() {
        if (started) return;
        started = true;
        Timer.schedule(this::poll, 0f, POLL_SECONDS);
    }

    private void poll() {
        String token = Core.settings.getString(TOKEN_KEY, "").trim();
        if (token.isEmpty() || !polling.compareAndSet(false, true)) return;

        Threads.daemon(() -> {
            try {
                String response = request("GET", "/mindustry/pull", token, null);
                Jval json = Jval.read(response);
                Jval action = json.get("action");
                if (action != null && action.isObject()) {
                    String type = action.getString("type", "");
                    String by = action.getString("by", "comunidade");
                    Core.app.post(() -> executeAction(type, by));
                }
            } catch (UnauthorizedException unauthorized) {
                Core.settings.remove(TOKEN_KEY);
                Core.settings.manualSave();
                started = false;
                Core.app.post(() -> {
                    Vars.ui.showErrorMessage("A vinculação expirou. Gere um novo código no Discord.");
                    requestPairCode();
                });
            } catch (Throwable ignored) {
                // Falhas temporárias de internet não encerram a sessão local.
            } finally {
                polling.set(false);
            }
        });
    }

    private void executeAction(String type, String by) {
        if (!Vars.state.isGame()) return;

        switch (type) {
            case "wave_next" -> {
                if (Vars.state.rules.waves) {
                    Vars.logic.runWave();
                    Vars.ui.showInfoToast("[violet]MiojoPlays[]: próxima wave enviada por " + by, 3f);
                }
            }
            case "copper_100" -> {
                var core = Vars.player.team().core();
                if (core != null) {
                    core.items.add(Items.copper, 100);
                    Vars.ui.showInfoToast("[orange]+100 cobre[] enviado por " + by, 3f);
                }
            }
            case "heal_core" -> {
                var core = Vars.player.team().core();
                if (core != null) {
                    core.heal();
                    Vars.ui.showInfoToast("[green]Núcleo curado[] por " + by, 3f);
                }
            }
            default -> {
                // Ações desconhecidas são ignoradas de propósito.
            }
        }
    }

    private String request(String method, String path, String token, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(API_BASE + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(7000);
        connection.setReadTimeout(7000);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);

        if (body != null) {
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(data);
            }
        }

        int status = connection.getResponseCode();
        if (status == 401) throw new UnauthorizedException();

        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder text = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line);
            }
        }
        connection.disconnect();

        if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
        return text.toString();
    }

    private static final class UnauthorizedException extends Exception {
    }
}
