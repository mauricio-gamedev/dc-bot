from pathlib import Path
import re

SETTINGS = Path("app/src/main/cpp/samp/settings.cpp")
IMGUI_WRAPPER = Path("app/src/main/cpp/samp/gui/imguiwrapper.cpp")
CPP_ROOT = Path("app/src/main/cpp")


def replace_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return updated


def patch_settings_defaults() -> None:
    text = SETTINGS.read_text(encoding="utf-8-sig")
    text = replace_once(
        text,
        r'''if\s*\(\s*reader\.ParseError\(\)\s*<\s*0\s*\)\s*\{\s*Log\("Error: can't load %s", buff\);\s*std::terminate\(\);\s*return;\s*\}''',
        '''if(reader.ParseError() < 0)
\t{
\t\tLog("Settings file unavailable at %s; continuing with built-in defaults.", buff);
\t}''',
        "settings.ini fallback",
        flags=re.DOTALL,
    )
    SETTINGS.write_text(text, encoding="utf-8")


def patch_imgui_font_fallback() -> None:
    text = IMGUI_WRAPPER.read_text(encoding="utf-8-sig")
    text = replace_once(
        text,
        r'''if\s*\(font\s*==\s*nullptr\)\s*\{\s*Log::addParameter\("font",\s*font\);\s*return\s+false;\s*\}''',
        '''if (font == nullptr)
    {
        font = io.Fonts->AddFontDefault();
    }

    if (font == nullptr)
    {
        Log::addParameter("font", font);
        return false;
    }''',
        "ImGui font fallback",
        flags=re.DOTALL,
    )
    IMGUI_WRAPPER.write_text(text, encoding="utf-8")


def patch_texture_database_runtime_hook() -> None:
    """Force GTA's player/menu texture DB requests to use Android PVR.

    libGame's TextureDatabaseFormat mapping is 1=DXT, 4=PVR, 6=automatic.
    The previous source-level rewrite did not affect the real player/menu loads:
    those calls happen inside the prebuilt libGame.so. ShadowHook already hooks
    libGame symbols in this client, so intercept TextureDatabaseRuntime::Load
    itself and rewrite only player/menu format arguments at runtime.
    """

    extensions = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"}
    install_pattern = re.compile(
        r'(?m)^(?P<indent>[ \t]*)void\s+InstallCrashFixHooks\s*\(\s*\)\s*\{'
    )

    helper = r'''
using TextureDatabaseLoadFn = void* (*)(const char*, bool, int);
static TextureDatabaseLoadFn g_textureDatabaseLoadOriginal = nullptr;

static bool TextureDatabaseNameEquals(const char* value, const char* expected)
{
    if (value == nullptr || expected == nullptr)
        return false;

    while (*value != '\0' && *expected != '\0')
    {
        if (*value != *expected)
            return false;
        ++value;
        ++expected;
    }
    return *value == *expected;
}

static void* TextureDatabaseLoadPvrHook(const char* name, bool fullyLoad, int format)
{
    int forcedFormat = format;
    if (TextureDatabaseNameEquals(name, "player") ||
        TextureDatabaseNameEquals(name, "menu"))
    {
        forcedFormat = 4;
        Log("Texture DB format override | %s: %d -> %d", name, format, forcedFormat);
    }

    if (g_textureDatabaseLoadOriginal == nullptr)
    {
        Log("Texture DB format override | original loader unavailable");
        return nullptr;
    }

    return g_textureDatabaseLoadOriginal(name, fullyLoad, forcedFormat);
}

'''

    hook_install = r'''
    shadowhook_hook_sym_name(
            "libGame.so",
            "_ZN22TextureDatabaseRuntime4LoadEPKcb21TextureDatabaseFormat",
            (void*)TextureDatabaseLoadPvrHook,
            (void**)&g_textureDatabaseLoadOriginal);
    Log("Installed GTA texture database PVR format hook");
'''

    candidates: list[Path] = []
    for path in sorted(CPP_ROOT.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        if "InstallCrashFixHooks" in text and "shadowhook_hook_sym_name" in text:
            candidates.append(path)

    for path in candidates:
        text = path.read_text(encoding="utf-8-sig")
        match = install_pattern.search(text)
        if not match:
            continue

        if "TextureDatabaseLoadPvrHook" not in text:
            text = text[:match.start()] + helper + text[match.start():]
            match = install_pattern.search(text)
            if not match:
                raise SystemExit("InstallCrashFixHooks disappeared after helper insertion")

        if "Installed GTA texture database PVR format hook" not in text:
            brace_end = match.end()
            text = text[:brace_end] + hook_install + text[brace_end:]

        path.write_text(text, encoding="utf-8")
        print(f"Patched runtime TextureDatabaseRuntime::Load hook in {path}")
        return

    raise SystemExit(
        "Unable to locate InstallCrashFixHooks with ShadowHook support for texture DB override"
    )


if __name__ == "__main__":
    patch_settings_defaults()
    patch_imgui_font_fallback()
    patch_texture_database_runtime_hook()

    settings_text = SETTINGS.read_text(encoding="utf-8")
    imgui_text = IMGUI_WRAPPER.read_text(encoding="utf-8")
    assert "std::terminate();" not in settings_text
    assert "continuing with built-in defaults" in settings_text
    assert "AddFontDefault()" in imgui_text

    patched_hook = False
    for path in CPP_ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"}:
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        if "TextureDatabaseLoadPvrHook" in text and "Installed GTA texture database PVR format hook" in text:
            patched_hook = True
            break
    assert patched_hook

    print("Patched native settings, font fallback, and runtime PVR texture override successfully.")
