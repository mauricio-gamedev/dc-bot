package io.github.astromg01.miovoice;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    static final String PREFS = "mio_voice";
    static final String KEY_TOKEN = "token";
    static final String KEY_PRESET = "preset";
    static final String KEY_STATUS = "status";
    static final String KEY_ROUTE = "route";
    static final String KEY_LATENCY = "latency";

    private TextView connectionView;
    private TextView presetView;
    private TextView routeView;
    private EditText codeInput;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        setContentView(buildUi());
        requestRuntimePermissions();
        refreshStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(9, 7, 15));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(28), dp(22), dp(28));
        scroll.addView(root);

        TextView title = text("Mio Voice", 28, true);
        title.setTextColor(Color.rgb(190, 130, 255));
        root.addView(title);

        TextView subtitle = text("MiojoPlays • Voice System", 15, false);
        subtitle.setTextColor(Color.LTGRAY);
        subtitle.setPadding(0, dp(4), 0, dp(24));
        root.addView(subtitle);

        connectionView = cardText();
        presetView = cardText();
        routeView = cardText();
        root.addView(connectionView);
        root.addView(presetView);
        root.addView(routeView);

        TextView pairTitle = text("Vincular com o bot", 18, true);
        pairTitle.setTextColor(Color.WHITE);
        pairTitle.setPadding(0, dp(24), 0, dp(8));
        root.addView(pairTitle);

        codeInput = new EditText(this);
        codeInput.setHint("Código de 6 dígitos do /voz vincular");
        codeInput.setHintTextColor(Color.GRAY);
        codeInput.setTextColor(Color.WHITE);
        codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
        codeInput.setSingleLine(true);
        root.addView(codeInput, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(56)
        ));

        Button pair = button("Vincular Android");
        pair.setOnClickListener(v -> pairDevice());
        root.addView(pair);

        Button start = button("Iniciar Voice Monitor");
        start.setOnClickListener(v -> startVoice());
        root.addView(start);

        Button stop = button("Parar processamento");
        stop.setOnClickListener(v -> {
            stopService(new Intent(this, VoiceService.class));
            prefs.edit().putString(KEY_STATUS, "parado").apply();
            refreshStatus();
        });
        root.addView(stop);

        Button refresh = button("Atualizar status");
        refresh.setOnClickListener(v -> refreshStatus());
        root.addView(refresh);

        TextView note = text(
            "Protótipo Android v0.1.1: o áudio é processado localmente e nunca é enviado ao Render. " +
            "O monitor agora evita misturar a voz original com a transformada e usa cancelamento de eco quando o aparelho oferece suporte. " +
            "Para testar sem microfonia, prefira fone/headset. O modo microfone virtual para jogos continua experimental porque o Android comum " +
            "bloqueia a substituição do microfone de outro app.",
            14,
            false
        );
        note.setTextColor(Color.LTGRAY);
        note.setPadding(0, dp(24), 0, 0);
        root.addView(note);

        return scroll;
    }

    private TextView cardText() {
        TextView view = text("—", 16, false);
        view.setTextColor(Color.WHITE);
        view.setBackgroundColor(Color.rgb(28, 23, 38));
        view.setPadding(dp(16), dp(14), dp(16), dp(14));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, 0, 0, dp(8));
        view.setLayoutParams(params);
        return view;
    }

    private TextView text(String value, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setGravity(Gravity.START);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(54)
        );
        params.setMargins(0, dp(10), 0, 0);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS}, 10);
        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 10);
        }
    }

    private void pairDevice() {
        String code = codeInput.getText().toString().trim();
        if (code.length() != 6) {
            toast("Digite o código de 6 dígitos.");
            return;
        }

        connectionView.setText("🔄 Vinculando...");
        new Thread(() -> {
            try {
                VoiceApi.PairResult result = VoiceApi.pair(code);
                prefs.edit()
                    .putString(KEY_TOKEN, result.token)
                    .putString(KEY_PRESET, result.presetLabel)
                    .putString(KEY_STATUS, "vinculado")
                    .apply();
                runOnUiThread(() -> {
                    codeInput.setText("");
                    refreshStatus();
                    toast("Android vinculado ao Mio Voice.");
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    prefs.edit().putString(KEY_STATUS, "erro de vínculo").apply();
                    refreshStatus();
                    toast("Falha ao vincular: " + safeMessage(error));
                });
            }
        }, "mio-voice-pair").start();
    }

    private void startVoice() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestRuntimePermissions();
            toast("Libere o microfone e toque novamente.");
            return;
        }
        if (prefs.getString(KEY_TOKEN, "").isEmpty()) {
            toast("Use /voz vincular e vincule o Android primeiro.");
            return;
        }

        Intent service = new Intent(this, VoiceService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        prefs.edit().putString(KEY_STATUS, "iniciando").apply();
        refreshStatus();
    }

    private void refreshStatus() {
        String token = prefs.getString(KEY_TOKEN, "");
        String status = prefs.getString(KEY_STATUS, token.isEmpty() ? "não vinculado" : "vinculado");
        String preset = prefs.getString(KEY_PRESET, "Normal");
        String route = prefs.getString(KEY_ROUTE, "—");
        int latency = prefs.getInt(KEY_LATENCY, -1);

        connectionView.setText("📡 Estado: " + status);
        presetView.setText("🎭 Preset: " + preset);
        routeView.setText("🎧 Rota: " + route + "   •   Latência: " + (latency >= 0 ? latency + " ms" : "—"));
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
