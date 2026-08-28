from pathlib import Path

HOOKS = Path("app/src/main/cpp/samp/game/hooks.cpp")

OLD = '''    CHook::InstallPLT(
            g_libGTASA + kTextureDatabaseRuntimeLoadGot,
            &TextureDatabaseRuntimeLoadCompat,
            &g_textureDatabaseRuntimeLoadOriginal);'''

NEW = '''    // TextureCompat v3: hook the real libGame function entry directly.
    // Internal BL calls inside libGame bypass the GOT/PLT slot used by v2.
    CHook::InlineHook(
            g_libGTASA + 0x797A84,
            &TextureDatabaseRuntimeLoadCompat,
            &g_textureDatabaseRuntimeLoadOriginal);'''


def main() -> None:
    text = HOOKS.read_text(encoding="utf-8-sig")

    if OLD not in text:
        raise SystemExit("TextureCompat v2 runtime-load PLT hook block not found")

    text = text.replace(OLD, NEW, 1)
    text = text.replace(
        '[TextureCompat] v2 PLT hooks installed | Load=0x849430 Thumbs=0x84EB88',
        '[TextureCompat] v3 hooks installed | Load=direct@0x797A84 Thumbs=GOT@0x84EB88',
        1,
    )

    HOOKS.write_text(text, encoding="utf-8")

    verify = HOOKS.read_text(encoding="utf-8")
    assert "g_libGTASA + 0x797A84" in verify
    assert "TextureCompat] v3 hooks installed" in verify
    assert OLD not in verify

    print("Patched TextureDatabaseRuntime::Load with direct ARM64 function-entry hook (TextureCompat v3).")


if __name__ == "__main__":
    main()
