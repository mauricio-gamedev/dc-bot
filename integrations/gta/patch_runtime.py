from pathlib import Path
import re

BASE_ACTIVITY = Path("app/src/main/java/com/rockstargames/oswrapper/GameActivityBase.java")
MAIN_ACTIVITY = Path("app/src/main/java/com/gta/launcher/activity/MainActivity.java")
SAMP_ACTIVITY = Path("app/src/main/java/com/gta/game/SAMP.java")
GTASA_ACTIVITY = Path("app/src/main/java/com/gta/game/GTASA.java")
GAME_NATIVE = Path("app/src/main/java/com/rockstargames/oswrapper/GameNative.java")
GAME_THREAD = Path("app/src/main/java/com/rockstargames/oswrapper/GameThread.java")
STARTUP_TRACE = Path("app/src/main/java/com/gta/game/StartupTrace.java")


def replace_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return updated


def patch_base_activity() -> None:
    text = BASE_ACTIVITY.read_text(encoding="utf-8")
    text = replace_once(
        text,
        r'File gameDir = new File\(documentsDir, "VICE"\);',
        'File gameDir = new File(documentsDir, "GTA");',
        "GameActivityBase cache directory",
    )
    BASE_ACTIVITY.write_text(text, encoding="utf-8")


def write_startup_trace() -> None:
    STARTUP_TRACE.write_text(
        r'''package com.gta.game;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class StartupTrace {
    private static final File LOG_FILE = new File("/storage/emulated/0/GTA/samp-startup.log");
    private static final File EXIT_INFO_FILE = new File("/storage/emulated/0/GTA/samp-exit-info.log");
    private static final File EXIT_TRACE_FILE = new File("/storage/emulated/0/GTA/samp-exit-trace.txt");

    private StartupTrace() { }

    public static synchronized void reset(String message) {
        write(message, false);
    }

    public static synchronized void log(String message) {
        write(message, true);
    }

    public static synchronized void logThrowable(String stage, Throwable throwable) {
        StringWriter sw = new StringWriter();
        throwable.printStackTrace(new PrintWriter(sw));
        write(stage + "\n" + sw, true);
    }

    public static synchronized void capturePreviousExit(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }

        try {
            ActivityManager activityManager =
                    (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (activityManager == null) {
                writeStandalone(EXIT_INFO_FILE, "ActivityManager unavailable\n", false);
                return;
            }

            List<ApplicationExitInfo> exits =
                    activityManager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 5);
            if (exits == null || exits.isEmpty()) {
                writeStandalone(EXIT_INFO_FILE, "No historical process exit info available\n", false);
                return;
            }

            StringBuilder report = new StringBuilder();
            report.append("Captured at ").append(System.currentTimeMillis()).append('\n');
            int index = 0;
            for (ApplicationExitInfo info : exits) {
                report.append("\n#").append(index++).append('\n');
                report.append("timestamp=").append(info.getTimestamp()).append('\n');
                report.append("process=").append(info.getProcessName()).append('\n');
                report.append("reason=").append(info.getReason()).append('\n');
                report.append("status=").append(info.getStatus()).append('\n');
                report.append("importance=").append(info.getImportance()).append('\n');
                report.append("pss=").append(info.getPss()).append('\n');
                report.append("rss=").append(info.getRss()).append('\n');
                report.append("description=").append(info.getDescription()).append('\n');
            }
            writeStandalone(EXIT_INFO_FILE, report.toString(), false);

            ApplicationExitInfo newest = exits.get(0);
            try (InputStream trace = newest.getTraceInputStream()) {
                if (trace != null) {
                    File parent = EXIT_TRACE_FILE.getParentFile();
                    if (parent != null && !parent.exists()) {
                        parent.mkdirs();
                    }
                    try (FileOutputStream out = new FileOutputStream(EXIT_TRACE_FILE, false)) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = trace.read(buffer)) != -1) {
                            out.write(buffer, 0, read);
                        }
                        out.flush();
                    }
                } else if (EXIT_TRACE_FILE.exists()) {
                    EXIT_TRACE_FILE.delete();
                }
            }
        } catch (Throwable t) {
            writeStandalone(
                    EXIT_INFO_FILE,
                    "capturePreviousExit failed: " + t.getClass().getName() + ": " + t.getMessage() + "\n",
                    false
            );
        }
    }

    private static void write(String message, boolean append) {
        writeStandalone(
                LOG_FILE,
                System.currentTimeMillis() + " | " + message + "\n",
                append
        );
    }

    private static void writeStandalone(File target, String text, boolean append) {
        try {
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (FileOutputStream out = new FileOutputStream(target, append)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Throwable ignored) {
        }
    }
}
''',
        encoding="utf-8",
    )


def patch_main_activity() -> None:
    text = MAIN_ACTIVITY.read_text(encoding="utf-8")

    if "import java.io.File;" not in text:
        text = replace_once(
            text,
            r'(import android\.widget\.Toast;\s*)',
            r'\1\nimport java.io.File;\n',
            "MainActivity File import",
        )

    if "import com.gta.game.StartupTrace;" not in text:
        text = replace_once(
            text,
            r'(import com\.gta\.game\.SAMP;\s*)',
            r'\1\nimport com.gta.game.StartupTrace;\n',
            "MainActivity StartupTrace import",
        )

    text = replace_once(
        text,
        r'(protected void onCreate\(Bundle savedInstanceState\) \{\s*super\.onCreate\(savedInstanceState\);)',
        r'\1\n\n        StartupTrace.capturePreviousExit(this);',
        "MainActivity previous exit capture",
    )

    new_preflight = '''    private void startGameIfReady() {
        if (!storagePermissionGranted) {
            Toast.makeText(this, "Sem acesso ao armazenamento. O jogo não pode iniciar.", Toast.LENGTH_LONG).show();
            return;
        }

        File gtaDir = new File(Environment.getExternalStorageDirectory(), "GTA");
        File[] gtaEntries = gtaDir.listFiles();
        if (!gtaDir.isDirectory() || gtaEntries == null || gtaEntries.length == 0) {
            Log.e("MainActivity", "GTA data missing: " + gtaDir.getAbsolutePath());
            Toast.makeText(
                    this,
                    "Arquivos do GTA não encontrados. Coloque os dados do jogo em /storage/emulated/0/GTA/",
                    Toast.LENGTH_LONG
            ).show();
            return;
        }

        StartupTrace.reset("launcher: GTA preflight passed");
        StartupTrace.log("launcher: starting SAMP activity");
        startGame();
    }

'''

    text = replace_once(
        text,
        r'    private void startGameIfReady\(\) \{.*?\n    \}\n\n(?=    private void setFullScreenMode\(\))',
        new_preflight,
        "MainActivity startGameIfReady",
        flags=re.DOTALL,
    )

    text = replace_once(
        text,
        r'if \(storagePermissionGranted\) \{\s*startGame\(\);\s*\} else \{\s*checkAndRequestStoragePermission\(\);\s*\}',
        '''if (storagePermissionGranted) {
                            startGameIfReady();
                        } else {
                            checkAndRequestStoragePermission();
                        }''',
        "MainActivity start button preflight",
        flags=re.DOTALL,
    )

    MAIN_ACTIVITY.write_text(text, encoding="utf-8")


def patch_gtasa() -> None:
    text = GTASA_ACTIVITY.read_text(encoding="utf-8")
    text = replace_once(
        text,
        r'\s*System\.out\.println\("GTASA onCreate"\);.*?super\.onCreate\(bundle\);',
        '''
        System.out.println("GTASA onCreate");
        StartupTrace.log("GTASA.onCreate: before GameActivityBase.onCreate");
        try {
            super.onCreate(bundle);
            StartupTrace.log("GTASA.onCreate: GameActivityBase.onCreate returned");
        } catch (RuntimeException | Error e) {
            StartupTrace.logThrowable("GTASA.onCreate: GameActivityBase.onCreate failed", e);
            throw e;
        }''',
        "GTASA onCreate tracing",
        flags=re.DOTALL,
    )
    GTASA_ACTIVITY.write_text(text, encoding="utf-8")


def patch_samp() -> None:
    text = SAMP_ACTIVITY.read_text(encoding="utf-8")
    new_oncreate = '''    @Override
    public void onCreate(Bundle savedInstanceState) {
        Log.i(TAG, "**** onCreate");
        StartupTrace.log("SAMP.onCreate: entered");
        try {
            super.onCreate(savedInstanceState);
            StartupTrace.log("SAMP.onCreate: super returned");

            StartupTrace.log("SAMP.onCreate: creating UI helpers");
            mDialog     = new DialogManager(this);
            mAttachEdit = new AttachEdit(this);
            mLoadingScreen = new LoadingScreen(this);
            instance = this;
            StartupTrace.log("SAMP.onCreate: UI helpers ready");

            StartupTrace.log("SAMP.onCreate: initializeSAMP begin");
            initializeSAMP();
            StartupTrace.log("SAMP.onCreate: initializeSAMP returned");
        } catch (UnsatisfiedLinkError e) {
            StartupTrace.logThrowable("SAMP.onCreate: UnsatisfiedLinkError", e);
            Log.e(TAG, e.getMessage());
        } catch (RuntimeException | Error e) {
            StartupTrace.logThrowable("SAMP.onCreate: fatal Java error", e);
            throw e;
        }
    }

'''
    text = replace_once(
        text,
        r'    @Override\n    public void onCreate\(Bundle savedInstanceState\) \{.*?\n    \}\n\n(?=    private native void initializeSAMP\(\);)',
        new_oncreate,
        "SAMP onCreate tracing",
        flags=re.DOTALL,
    )
    SAMP_ACTIVITY.write_text(text, encoding="utf-8")


def patch_game_native() -> None:
    text = GAME_NATIVE.read_text(encoding="utf-8")
    if "import com.gta.game.StartupTrace;" not in text:
        text = replace_once(
            text,
            r'(import com\.bytedance\.shadowhook\.ShadowHook;\s*)',
            r'\1\nimport com.gta.game.StartupTrace;\n',
            "GameNative StartupTrace import",
        )

    new_static = '''    static {
        StartupTrace.log("GameNative: static initializer entered");
        try {
            StartupTrace.log("GameNative: ShadowHook.init begin");
            ShadowHook.init(new ShadowHook.ConfigBuilder()
                    .setMode(ShadowHook.Mode.UNIQUE)
                    .build());
            StartupTrace.log("GameNative: ShadowHook.init returned");

            StartupTrace.log("GameNative: loading libGame.so");
            System.loadLibrary("Game");
            StartupTrace.log("GameNative: libGame.so loaded");

            StartupTrace.log("GameNative: loading libsamp.so");
            System.loadLibrary("samp");
            StartupTrace.log("GameNative: libsamp.so loaded");
        } catch (RuntimeException | Error e) {
            StartupTrace.logThrowable("GameNative: static initializer failed", e);
            throw e;
        }
    }
'''
    text = replace_once(
        text,
        r'    static \{.*?\n    \}',
        new_static.rstrip(),
        "GameNative static initializer tracing",
        flags=re.DOTALL,
    )
    GAME_NATIVE.write_text(text, encoding="utf-8")


def patch_game_thread() -> None:
    text = GAME_THREAD.read_text(encoding="utf-8")

    if "import com.gta.game.StartupTrace;" not in text:
        text = replace_once(
            text,
            r'(import android\.view\.SurfaceHolder;\s*)',
            r'\1\nimport com.gta.game.StartupTrace;\n',
            "GameThread StartupTrace import",
        )

    text = replace_once(
        text,
        r'(\s*private static ExecutorThread current;\s*)',
        r'\1    private static boolean tracedFirstDraw = false;\n',
        "GameThread first draw field",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnActivityCreated\(new GamePlatformServices\(activity, view\), firstInit\);',
        r'\1StartupTrace.log("GameThread: implOnActivityCreated begin");'
        r'\1GameNative.implOnActivityCreated(new GamePlatformServices(activity, view), firstInit);'
        r'\1StartupTrace.log("GameThread: implOnActivityCreated returned");',
        "GameThread activity created trace",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnInitialSetup\(deviceInfo, assets, finalNames, finalPaths\);',
        r'\1StartupTrace.log("GameThread: implOnInitialSetup begin path=" + finalPaths[0]);'
        r'\1GameNative.implOnInitialSetup(deviceInfo, assets, finalNames, finalPaths);'
        r'\1StartupTrace.log("GameThread: implOnInitialSetup returned");',
        "GameThread initial setup trace",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnSurfaceCreated\(\);',
        r'\1StartupTrace.log("GameThread: implOnSurfaceCreated begin");'
        r'\1GameNative.implOnSurfaceCreated();'
        r'\1StartupTrace.log("GameThread: implOnSurfaceCreated returned");',
        "GameThread surface created trace",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnSurfaceChanged\(surface, width, height\);',
        r'\1StartupTrace.log("GameThread: implOnSurfaceChanged begin " + width + "x" + height);'
        r'\1GameNative.implOnSurfaceChanged(surface, width, height);'
        r'\1StartupTrace.log("GameThread: implOnSurfaceChanged returned");',
        "GameThread surface changed trace",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnResume\(\);',
        r'\1StartupTrace.log("GameThread: implOnResume begin");'
        r'\1GameNative.implOnResume();'
        r'\1StartupTrace.log("GameThread: implOnResume returned");',
        "GameThread resume trace",
    )

    text = replace_once(
        text,
        r'(\s*)GameNative\.implOnDrawFrame\(f\);',
        r'\1if (!GameThread.tracedFirstDraw) {'
        r'\1    StartupTrace.log("GameThread: first implOnDrawFrame begin");'
        r'\1}'
        r'\1GameNative.implOnDrawFrame(f);'
        r'\1if (!GameThread.tracedFirstDraw) {'
        r'\1    StartupTrace.log("GameThread: first implOnDrawFrame returned");'
        r'\1    GameThread.tracedFirstDraw = true;'
        r'\1}',
        "GameThread first draw trace",
    )

    text = replace_once(
        text,
        r'''        @Override
        public void run\(\) \{
            // FIX #2: removed useless try/catch InterruptedException — guardedRun\(\) doesn't throw it
            guardedRun\(\);
        \}''',
        '''        @Override
        public void run() {
            StartupTrace.log("GameThread.ExecutorThread: run entered");
            try {
                guardedRun();
                StartupTrace.log("GameThread.ExecutorThread: guardedRun returned");
            } catch (RuntimeException | Error e) {
                StartupTrace.logThrowable("GameThread.ExecutorThread: Java failure", e);
                throw e;
            }
        }''',
        "GameThread executor run trace",
    )

    GAME_THREAD.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    patch_base_activity()
    write_startup_trace()
    patch_main_activity()
    patch_gtasa()
    patch_samp()
    patch_game_native()
    patch_game_thread()

    base_text = BASE_ACTIVITY.read_text(encoding="utf-8")
    main_text = MAIN_ACTIVITY.read_text(encoding="utf-8")
    samp_text = SAMP_ACTIVITY.read_text(encoding="utf-8")
    native_text = GAME_NATIVE.read_text(encoding="utf-8")
    thread_text = GAME_THREAD.read_text(encoding="utf-8")
    trace_text = STARTUP_TRACE.read_text(encoding="utf-8")
    assert 'new File(documentsDir, "GTA")' in base_text
    assert "Arquivos do GTA não encontrados" in main_text
    assert "StartupTrace.reset" in main_text
    assert "capturePreviousExit" in main_text
    assert "initializeSAMP begin" in samp_text
    assert "loading libGame.so" in native_text
    assert "implOnInitialSetup begin" in thread_text
    assert "first implOnDrawFrame begin" in thread_text
    assert "samp-exit-info.log" in trace_text
    assert STARTUP_TRACE.exists()
    print("Patched runtime cache root and deep on-device startup/native crash diagnostics successfully.")
