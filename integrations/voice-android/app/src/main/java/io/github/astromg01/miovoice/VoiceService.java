package io.github.astromg01.miovoice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;

import java.util.concurrent.atomic.AtomicBoolean;

public final class VoiceService extends Service {
    private static final String CHANNEL_ID = "mio_voice_engine";
    private static final int NOTIFICATION_ID = 4209;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private AudioEngine engine;
    private Thread pollThread;
    private SharedPreferences prefs;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        engine = new AudioEngine(this);
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Conectando ao Mio Voice..."));
        if (running.compareAndSet(false, true)) {
            applyLocalAudioSettings();
            prefs.edit().putString(MainActivity.KEY_STATUS, "processando").apply();
            engine.start();
            pollThread = new Thread(this::pollLoop, "mio-voice-poll");
            pollThread.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running.set(false);
        if (pollThread != null) pollThread.interrupt();
        if (engine != null) engine.stop();
        prefs.edit().putString(MainActivity.KEY_STATUS, "parado").apply();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pollLoop() {
        long lastRevision = -1;
        int reportCounter = 0;

        while (running.get()) {
            String token = prefs.getString(MainActivity.KEY_TOKEN, "");
            if (token.isEmpty()) {
                prefs.edit().putString(MainActivity.KEY_STATUS, "não vinculado").apply();
                stopSelf();
                return;
            }

            int sleepMs = 1000;
            try {
                applyLocalAudioSettings();
                VoiceApi.Config config = VoiceApi.pull(token);
                sleepMs = config.pollAfterMs;
                if (config.revision != lastRevision) {
                    engine.setConfig(config);
                    lastRevision = config.revision;
                }

                int volume = prefs.getInt(MainActivity.KEY_MONITOR_VOLUME, 55);
                int cleanup = prefs.getInt(MainActivity.KEY_CLEANUP, 82);
                updateNotification(
                    "Ativo • " + config.label + " • efeito " + config.intensity + "% • vol " + volume + "% • limpeza " + cleanup + "%"
                );

                String route = detectRoute();
                int latency = engine.getEstimatedLatencyMs();
                prefs.edit()
                    .putString(MainActivity.KEY_STATUS, engine.isRunning() ? "ativo" : "erro de áudio")
                    .putString(MainActivity.KEY_PRESET, config.label)
                    .putString(MainActivity.KEY_ROUTE, route)
                    .putInt(MainActivity.KEY_LATENCY, latency)
                    .apply();

                reportCounter++;
                if (reportCounter >= 5) {
                    reportCounter = 0;
                    VoiceApi.report(token, route, Math.max(0, latency));
                }
            } catch (Exception error) {
                String message = error.getMessage() == null ? "erro de rede" : error.getMessage();
                prefs.edit().putString(MainActivity.KEY_STATUS, "offline: " + message).apply();
                if ("unauthorized".equals(message)) {
                    prefs.edit().remove(MainActivity.KEY_TOKEN).apply();
                    stopSelf();
                    return;
                }
                sleepMs = 2500;
            }

            try {
                Thread.sleep(sleepMs);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void applyLocalAudioSettings() {
        int volume = Math.max(20, Math.min(100, prefs.getInt(MainActivity.KEY_MONITOR_VOLUME, 55)));
        int cleanup = Math.max(0, Math.min(100, prefs.getInt(MainActivity.KEY_CLEANUP, 82)));
        engine.setMonitorVolume(volume / 100f);
        engine.setCleanupStrength(cleanup / 100f);
    }

    private String detectRoute() {
        AudioManager manager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int type = device.getType();
            if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                || type == AudioDeviceInfo.TYPE_USB_HEADSET
                || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                || type == AudioDeviceInfo.TYPE_BLE_HEADSET
                || type == AudioDeviceInfo.TYPE_BLE_SPEAKER) {
                return "headset";
            }
        }
        return "monitor";
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Mio Voice",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Processamento local do microfone do Mio Voice.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Mio Voice")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, notification(text));
    }
}
