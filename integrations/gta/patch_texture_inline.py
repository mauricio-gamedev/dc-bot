from pathlib import Path
import re

HOOKS = Path("app/src/main/cpp/samp/game/hooks.cpp")


def main() -> None:
    text = HOOKS.read_text(encoding="utf-8-sig")

    # Root cause: the stock ARM64 libGame already contains PVR texture paths at
    # 0x24E4C4 and 0x246D17, but InstallUrezHooks() mutates those strings to DXT
    # during startup. That runtime rewrite is exactly why a PVR cache is opened as
    # player.dxt.tmb. Keep libGame's native PVR strings intact instead of trying to
    # hook TextureDatabaseRuntime::Load after the fact.
    required_fragments = [
        "void InstallUrezHooks()",
        "g_libGTASA + 0x24E4C4",
        "g_libGTASA + 0x246D17",
        "= 'd';",
        "= 'x';",
        "= 't';",
    ]
    for fragment in required_fragments:
        if fragment not in text:
            raise SystemExit(f"Expected upstream DXT rewrite fragment missing: {fragment}")

    pattern = re.compile(
        r"(?m)^(?P<indent>[ \t]*)InstallUrezHooks\(\);[ \t]*$"
    )
    match = pattern.search(text)
    if not match:
        raise SystemExit("InstallSpecialHooks no longer calls InstallUrezHooks")

    indent = match.group("indent")
    replacement = (
        f'{indent}// TextureCompat v4: do NOT rewrite libGame PVR paths to DXT.\n'
        f'{indent}Log("[TextureCompat] v4 | disabled InstallUrezHooks DXT rewrite; keeping native PVR paths");'
    )
    text = text[:match.start()] + replacement + text[match.end():]

    HOOKS.write_text(text, encoding="utf-8")

    verify = HOOKS.read_text(encoding="utf-8")
    assert "[TextureCompat] v4 | disabled InstallUrezHooks DXT rewrite" in verify
    install_special = verify[verify.index("void InstallSpecialHooks()") :]
    install_special = install_special[: install_special.find("}") + 1]
    assert "InstallUrezHooks();" not in install_special

    print("TextureCompat v4: disabled the upstream runtime DXT string rewrite; native PVR paths stay intact.")


if __name__ == "__main__":
    main()
