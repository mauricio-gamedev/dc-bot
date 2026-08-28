package io.github.astromg01.miovoice;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;

public final class MainActivity extends Activity {
    static final String PREFS = "mio_voice";
    static final String KEY_TOKEN = "token";
    static final String KEY_PRESET = "preset";
    static final String KEY_STATUS = "status";
    static final String KEY_ROUTE = "route";
    static final String KEY_LATENCY = "latency";
    static final String KEY_MONITOR_VOLUME = "monitor_volume";
    static final String KEY_CLEANUP = "cleanup_strength";
    static final String KEY_VAD_ENABLED = "vad_enabled";
    static final String KEY_VAD_ACTIVE = "vad_active";
    static final String KEY_VAD_CONFIDENCE = "vad_confidence";
    static final String KEY_VAD_FOCUS = "vad_focus";
    static final String KEY_NEURAL_ENABLED = "neural_enabled";
    static final String KEY_NEURAL_VOICE_NAME = "neural_voice_name";
    static final String KEY_NEURAL_PITCH = "neural_pitch";
    static final String KEY_NEURAL_STATUS = "neural_status";
    static final String KEY_NEURAL_READY = "neural_ready";
    static final String KEY_NEURAL_LATENCY = "neural_latency";
    static final String KEY_NEURAL_INFERENCE = "neural_inference";
    static final String KEY_NEURAL_DROPS = "neural_drops";

    private static final int PICK_HUBERT = 501;
    private static final int PICK_RMVPE = 502;
    private static final int PICK_SYNTH = 503;

    private TextView connectionView;
    private TextView presetView;
    private TextView routeView;
    private TextView vadView;
    private TextView neuralView;
    private TextView volumeLabel;
    private TextView cleanupLabel;
    private TextView focusLabel;
    private TextView neuralPitchLabel;
    private EditText codeInput;
    private SharedPreferences prefs;
    private Handler statusHandler;

    private final Runnable statusTicker = new Runnable() {
        @Override
        public void run() {
            refreshStatus();
            if (statusHandler != null) statusHandler.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        statusHandler = new Handler(Looper.getMainLooper());
        setContentView(buildUi());
        requestRuntimePermissions();
        refreshStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (statusHandler != null) {
            statusHandler.removeCallbacks(statusTicker);
            statusHandler.post(statusTicker);
        }
    }

    @Override
    protected void onPause() {
        if (statusHandler != null) statusHandler.removeCallbacks(statusTicker);
        super.onPause();
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
        vadView = cardText();
        neuralView = cardText();
        root.addView(connectionView);
        root.addView(presetView);
        root.addView(routeView);
        root.addView(vadView);
        root.addView(neuralView);

        TextView audioTitle = text("Ajustes locais", 18, true);
        audioTitle.setTextColor(Color.WHITE);
        audioTitle.setPadding(0, dp(18), 0, dp(6));
        root.addView(audioTitle);

        volumeLabel = text("", 15, false);
        volumeLabel.setTextColor(Color.LTGRAY);
        root.addView(volumeLabel);

        SeekBar volume = new SeekBar(this);
        volume.setMin(20);
        volume.setMax(100);
        volume.setProgress(prefs.getInt(KEY_MONITOR_VOLUME, 55));
        volume.setOnSeekBarChangeListener(new SimpleSeekListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int safe = clampInt(progress, 20, 100);
                volumeLabel.setText("🔊 Volume do monitor: " + safe + "%");
                if (fromUser) prefs.edit().putInt(KEY_MONITOR_VOLUME, safe).apply();
            }
        });
        root.addView(volume);

        cleanupLabel = text("", 15, false);
        cleanupLabel.setTextColor(Color.LTGRAY);
        cleanupLabel.setPadding(0, dp(4), 0, 0);
        root.addView(cleanupLabel);

        SeekBar cleanup = new SeekBar(this);
        cleanup.setMin(0);
        cleanup.setMax(100);
        cleanup.setProgress(prefs.getInt(KEY_CLEANUP, 82));
        cleanup.setOnSeekBarChangeListener(new SimpleSeekListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int safe = clampInt(progress, 0, 100);
                cleanupLabel.setText("🧹 Limpeza do mic: " + safe + "%");
                if (fromUser) prefs.edit().putInt(KEY_CLEANUP, safe).apply();
            }
        });
        root.addView(cleanup);

        Switch vadSwitch = new Switch(this);
        vadSwitch.setText("🗣️ Detector de voz (WebRTC VAD)");
        vadSwitch.setTextColor(Color.WHITE);
        vadSwitch.setTextSize(15);
        vadSwitch.setPadding(0, dp(8), 0, dp(2));
        vadSwitch.setChecked(prefs.getBoolean(KEY_VAD_ENABLED, true));
        vadSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            prefs.edit().putBoolean(KEY_VAD_ENABLED, isChecked).apply();
            refreshStatus();
        });
        root.addView(vadSwitch);

        focusLabel = text("", 15, false);
        focusLabel.setTextColor(Color.LTGRAY);
        root.addView(focusLabel);

        SeekBar focus = new SeekBar(this);
        focus.setMin(0);
        focus.setMax(100);
        focus.setProgress(prefs.getInt(KEY_VAD_FOCUS, 78));
        focus.setOnSeekBarChangeListener(new SimpleSeekListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int safe = clampInt(progress, 0, 100);
                focusLabel.setText("🎯 Foco da minha voz: " + safe + "%");
                if (fromUser) prefs.edit().putInt(KEY_VAD_FOCUS, safe).apply();
            }
        });
        root.addView(focus);

        volumeLabel.setText("🔊 Volume do monitor: " + volume.getProgress() + "%");
        cleanupLabel.setText("🧹 Limpeza do mic: " + cleanup.getProgress() + "%");
        focusLabel.setText("🎯 Foco da minha voz: " + focus.getProgress() + "%");

        TextView neuralTitle = text("Voz neural personalizada", 18, true);
        neuralTitle.setTextColor(Color.WHITE);
        neuralTitle.setPadding(0, dp(22), 0, dp(6));
        root.addView(neuralTitle);

        Switch neuralSwitch = new Switch(this);
        neuralSwitch.setText("🧠 Usar voz neural RVC (experimental)");
        neuralSwitch.setTextColor(Color.WHITE);
        neuralSwitch.setTextSize(15);
        neuralSwitch.setChecked(prefs.getBoolean(KEY_NEURAL_ENABLED, false));
        neuralSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (isChecked && !neuralModelsReady()) {
                buttonView.setChecked(false);
                prefs.edit().putBoolean(KEY_NEURAL_ENABLED, false).apply();
                toast("Importe ContentVec/HuBERT, RMVPE e uma voz RVC primeiro.");
                return;
            }
            prefs.edit().putBoolean(KEY_NEURAL_ENABLED, isChecked).apply();
            refreshStatus();
        });
        root.addView(neuralSwitch);

        Button importHubert = button("Importar ContentVec / HuBERT (.onnx)");
        importHubert.setOnClickListener(v -> pickOnnx(PICK_HUBERT));
        root.addView(importHubert);

        Button importRmvpe = button("Importar RMVPE (.onnx)");
        importRmvpe.setOnClickListener(v -> pickOnnx(PICK_RMVPE));
        root.addView(importRmvpe);

        Button importVoice = button("Importar voz de personagem RVC (.onnx)");
        importVoice.setOnClickListener(v -> pickOnnx(PICK_SYNTH));
        root.addView(importVoice);

        neuralPitchLabel = text("", 15, false);
        neuralPitchLabel.setTextColor(Color.LTGRAY);
        neuralPitchLabel.setPadding(0, dp(10), 0, 0);
        root.addView(neuralPitchLabel);

        SeekBar neuralPitch = new SeekBar(this);
        neuralPitch.setMin(0);
        neuralPitch.setMax(24);
        neuralPitch.setProgress(clampInt(prefs.getInt(KEY_NEURAL_PITCH, 0) + 12, 0, 24));
        neuralPitch.setOnSeekBarChangeListener(new SimpleSeekListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                int semitones = clampInt(progress - 12, -12, 12);
                String prefix = semitones > 0 ? "+" : "";
                neuralPitchLabel.setText("🎚️ Pitch neural: " + prefix + semitones + " semitons");
                if (fromUser) prefs.edit().putInt(KEY_NEURAL_PITCH, semitones).apply();
            }
        });
        root.addView(neuralPitch);
        int initialPitch = neuralPitch.getProgress() - 12;
        neuralPitchLabel.setText("🎚️ Pitch neural: " + (initialPitch > 0 ? "+" : "") + initialPitch + " semitons");

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
            prefs.edit()
                .putString(KEY_STATUS, "parado")
                .putBoolean(KEY_VAD_ACTIVE, false)
                .putInt(KEY_VAD_CONFIDENCE, 0)
                .putBoolean(KEY_NEURAL_READY, false)
                .apply();
            refreshStatus();
        });
        root.addView(stop);

        Button refresh = button("Atualizar status");
        refresh.setOnClickListener(v -> refreshStatus());
        root.addView(refresh);

        TextView note = text(
            "Protótipo Android v0.1.4: o supressor/AEC continuam locais. O detector agora usa WebRTC VAD muito agressivo + foco de proximidade, então barulho por volume sozinho não abre mais o gate. " +
            "A voz neural usa RVC/ONNX local e exige 3 modelos: ContentVec/HuBERT, RMVPE e o gerador da voz. Nenhum áudio do microfone ou modelo é enviado ao Render. " +
            "O modo neural inicial trabalha em blocos de ~480 ms e pode ficar pesado neste aparelho; o cartão Neural mostra a latência/inferência separadamente. " +
            "Importe somente modelos que você tenha direito de usar.",
            14,
            false
        );
        note.setTextColor(Color.LTGRAY);
        note.setPadding(0, dp(24), 0, 0);
        root.addView(note);

        return scroll;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (requestCode == PICK_HUBERT) {
            importNeuralModel(uri, NeuralVoiceStore.HUBERT, false);
        } else if (requestCode == PICK_RMVPE) {
            importNeuralModel(uri, NeuralVoiceStore.RMVPE, false);
        } else if (requestCode == PICK_SYNTH) {
            importNeuralModel(uri, NeuralVoiceStore.SYNTH, true);
        }
    }

    private void pickOnnx(int requestCode) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/octet-stream", "application/onnx", "*/*"});
        startActivityForResult(intent, requestCode);
    }

    private void importNeuralModel(Uri uri, String targetName, boolean synth) {
        String displayName = NeuralVoiceStore.displayName(this, uri);
        toast("Importando " + displayName + "…");
        new Thread(() -> {
            File target = NeuralVoiceStore.file(this, targetName);
            File backup = new File(target.getParentFile(), target.getName() + ".bak");
            try {
                if (backup.exists()) backup.delete();
                if (target.exists() && !target.renameTo(backup)) {
                    throw new IllegalStateException("Não consegui preparar o backup do modelo atual.");
                }

                File imported = NeuralVoiceStore.importModel(this, uri, targetName);
                if (synth) {
                    RvcNeuralEngine.ModelInfo info = RvcNeuralEngine.inspectSynth(imported, displayName);
                    prefs.edit().putString(KEY_NEURAL_VOICE_NAME, info.label).apply();
                }
                if (backup.exists()) backup.delete();

                runOnUiThread(() -> {
                    refreshStatus();
                    toast((synth ? "Voz RVC" : "Modelo") + " importado: " + displayName);
                });
            } catch (Exception error) {
                try {
                    if (target.exists()) target.delete();
                    if (backup.exists()) backup.renameTo(target);
                } catch (Exception ignored) {}
                runOnUiThread(() -> {
                    refreshStatus();
                    toast("Falha no modelo: " + safeMessage(error));
                });
            }
        }, "mio-neural-import").start();
    }

    private boolean neuralModelsReady() {
        return NeuralVoiceStore.has(this, NeuralVoiceStore.HUBERT)
            && NeuralVoiceStore.has(this, NeuralVoiceStore.RMVPE)
            && NeuralVoiceStore.has(this, NeuralVoiceStore.SYNTH);
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
        if (prefs.getBoolean(KEY_NEURAL_ENABLED, false) && !neuralModelsReady()) {
            prefs.edit().putBoolean(KEY_NEURAL_ENABLED, false).apply();
            toast("Voz neural desligada: faltam modelos locais.");
        }

        Intent service = new Intent(this, VoiceService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        prefs.edit().putString(KEY_STATUS, "iniciando").apply();
        refreshStatus();
    }

    private void refreshStatus() {
        if (prefs == null || connectionView == null) return;
        String token = prefs.getString(KEY_TOKEN, "");
        String status = prefs.getString(KEY_STATUS, token.isEmpty() ? "não vinculado" : "vinculado");
        String preset = prefs.getString(KEY_PRESET, "Normal");
        String route = prefs.getString(KEY_ROUTE, "—");
        int latency = prefs.getInt(KEY_LATENCY, -1);
        boolean vadEnabled = prefs.getBoolean(KEY_VAD_ENABLED, true);
        boolean vadActive = prefs.getBoolean(KEY_VAD_ACTIVE, false);
        int confidence = prefs.getInt(KEY_VAD_CONFIDENCE, 0);
        boolean neuralEnabled = prefs.getBoolean(KEY_NEURAL_ENABLED, false);
        boolean neuralReady = prefs.getBoolean(KEY_NEURAL_READY, false);
        String neuralStatus = prefs.getString(KEY_NEURAL_STATUS, NeuralVoiceStore.status(this));
        String neuralName = prefs.getString(KEY_NEURAL_VOICE_NAME, "Voz RVC");
        int neuralLatency = prefs.getInt(KEY_NEURAL_LATENCY, -1);
        int inference = prefs.getInt(KEY_NEURAL_INFERENCE, -1);
        int drops = prefs.getInt(KEY_NEURAL_DROPS, 0);

        connectionView.setText("📡 Estado: " + status);
        presetView.setText("🎭 Preset Lite: " + preset);
        routeView.setText("🎧 Rota: " + route + "   •   Pipeline Lite: " + (latency >= 0 ? latency + " ms" : "—"));
        if (!vadEnabled) {
            vadView.setText("🗣️ Detector: desligado");
        } else if (vadActive) {
            vadView.setText("🗣️ Detector: VOZ • confiança " + confidence + "%");
        } else {
            vadView.setText("🤫 Detector: silêncio • confiança " + confidence + "%");
        }

        if (!neuralEnabled) {
            neuralView.setText("🧠 Neural: desligado • " + NeuralVoiceStore.status(this));
        } else {
            String timing = neuralLatency >= 0 ? " • estimado " + neuralLatency + " ms" : "";
            if (inference >= 0) timing += " • inferência " + inference + " ms";
            if (drops > 0) timing += " • drops " + drops;
            neuralView.setText("🧠 Neural: " + (neuralReady ? "pronto" : "carregando") + " • " + neuralName + " • " + neuralStatus + timing);
        }
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private static int clampInt(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private abstract static class SimpleSeekListener implements SeekBar.OnSeekBarChangeListener {
        @Override public void onStartTrackingTouch(SeekBar seekBar) {}
        @Override public void onStopTrackingTouch(SeekBar seekBar) {}
    }
}
