from pathlib import Path
import re

BASE_ACTIVITY = Path("app/src/main/java/com/rockstargames/oswrapper/GameActivityBase.java")
MAIN_ACTIVITY = Path("app/src/main/java/com/gta/launcher/activity/MainActivity.java")


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


def patch_main_activity() -> None:
    text = MAIN_ACTIVITY.read_text(encoding="utf-8")

    if "import java.io.File;" not in text:
        text = replace_once(
            text,
            r'(import android\.widget\.Toast;\s*)',
            r'\1\nimport java.io.File;\n',
            "MainActivity File import",
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


if __name__ == "__main__":
    patch_base_activity()
    patch_main_activity()

    base_text = BASE_ACTIVITY.read_text(encoding="utf-8")
    main_text = MAIN_ACTIVITY.read_text(encoding="utf-8")
    assert 'new File(documentsDir, "GTA")' in base_text
    assert "Arquivos do GTA não encontrados" in main_text
    assert "startGameIfReady();" in main_text
    print("Patched runtime cache root and launcher preflight successfully.")
