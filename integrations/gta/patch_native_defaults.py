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


def patch_texture_database_compat() -> None:
    """Install deterministic libGame PLT hooks for texture database format selection.

    The previous ShadowHook symbol hook compiled but did not run on the device. The
    pinned ARM64 libGame calls TextureDatabaseRuntime::Load through GOT slot 0x849430
    and TextureDatabase::LoadThumbs through GOT slot 0x84EB88. Hook those exact PLT/GOT
    entries, auto-detect the texture format that actually exists in /GTA/texdb, and
    keep TextureDatabase::loadedFormat synchronized with the selected variant.
    """

    extensions = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"}
    install_pattern = re.compile(
        r'(?m)^(?P<indent>[ \t]*)(?:static\s+)?void\s+InstallCrashFixHooks\s*\(\s*\)\s*\{'
    )

    helper = r'''
// GTA TextureCompat v2: deterministic PLT hooks for the pinned ARM64 libGame.
static constexpr uintptr_t kTextureDatabaseRuntimeLoadGot = 0x849430;
static constexpr uintptr_t kTextureDatabaseLoadThumbsGot = 0x84EB88;

using TextureDatabaseRuntimeLoadFn = TextureDatabaseRuntime* (*)(const char*, bool, TextureDatabaseFormat);
using TextureDatabaseLoadThumbsFn = bool (*)(TextureDatabase*, TextureDatabaseFormat, bool);

static TextureDatabaseRuntimeLoadFn g_textureDatabaseRuntimeLoadOriginal = nullptr;
static TextureDatabaseLoadThumbsFn g_textureDatabaseLoadThumbsOriginal = nullptr;

static const char* TextureDatabaseFormatSuffix(TextureDatabaseFormat format)
{
    switch (format)
    {
        case DF_UNC: return "unc";
        case DF_DXT: return "dxt";
        case DF_360: return "360";
        case DF_PS3: return "ps3";
        case DF_PVR: return "pvr";
        case DF_ETC: return "etc";
        default: return nullptr;
    }
}

static bool TextureDatabaseVariantExists(const char* name, TextureDatabaseFormat format)
{
    if (name == nullptr || *name == '\0' || g_pszStorage == nullptr)
        return false;

    const char* suffix = TextureDatabaseFormatSuffix(format);
    if (suffix == nullptr)
        return false;

    char path[512]{};
    const int written = snprintf(
            path,
            sizeof(path),
            "%stexdb/%s/%s.%s.tmb",
            g_pszStorage,
            name,
            name,
            suffix);

    if (written <= 0 || static_cast<size_t>(written) >= sizeof(path))
        return false;

    return access(path, R_OK) == 0;
}

static TextureDatabaseFormat DetectTextureDatabaseFormat(
        const char* name,
        TextureDatabaseFormat requested)
{
    // Preserve the requested format when its files really exist.
    if (requested >= DF_UNC && requested <= DF_ETC &&
        TextureDatabaseVariantExists(name, requested))
    {
        return requested;
    }

    // Android packages in the wild may contain one of these variants regardless
    // of the GPU. Prefer actual on-disk data over libGame's automatic GPU choice.
    static constexpr TextureDatabaseFormat kCandidates[] = {
            DF_PVR,
            DF_ETC,
            DF_DXT,
            DF_UNC,
            DF_360,
            DF_PS3,
    };

    for (TextureDatabaseFormat candidate : kCandidates)
    {
        if (TextureDatabaseVariantExists(name, candidate))
            return candidate;
    }

    return requested;
}

static TextureDatabaseRuntime* TextureDatabaseRuntimeLoadCompat(
        const char* name,
        bool fullyLoad,
        TextureDatabaseFormat requested)
{
    if (g_textureDatabaseRuntimeLoadOriginal == nullptr)
    {
        Log("[TextureCompat] runtime loader unavailable");
        return nullptr;
    }

    const TextureDatabaseFormat selected = DetectTextureDatabaseFormat(name, requested);
    Log("[TextureCompat] Load %s | requested=%d selected=%d",
        name != nullptr ? name : "<null>",
        static_cast<int>(requested),
        static_cast<int>(selected));

    return g_textureDatabaseRuntimeLoadOriginal(name, fullyLoad, selected);
}

static bool TextureDatabaseLoadThumbsCompat(
        TextureDatabase* database,
        TextureDatabaseFormat requested,
        bool setEntries)
{
    if (g_textureDatabaseLoadThumbsOriginal == nullptr)
    {
        Log("[TextureCompat] thumb loader unavailable");
        return false;
    }

    const char* name = database != nullptr ? database->name : nullptr;
    const TextureDatabaseFormat selected = DetectTextureDatabaseFormat(name, requested);

    if (database != nullptr)
        database->loadedFormat = selected;

    Log("[TextureCompat] Thumbs %s | requested=%d selected=%d",
        name != nullptr ? name : "<null>",
        static_cast<int>(requested),
        static_cast<int>(selected));

    return g_textureDatabaseLoadThumbsOriginal(database, selected, setEntries);
}

'''

    hook_install = r'''
    CHook::InstallPLT(
            g_libGTASA + kTextureDatabaseRuntimeLoadGot,
            &TextureDatabaseRuntimeLoadCompat,
            &g_textureDatabaseRuntimeLoadOriginal);
    CHook::InstallPLT(
            g_libGTASA + kTextureDatabaseLoadThumbsGot,
            &TextureDatabaseLoadThumbsCompat,
            &g_textureDatabaseLoadThumbsOriginal);
    Log("[TextureCompat] v2 PLT hooks installed | Load=0x849430 Thumbs=0x84EB88");
'''

    candidates: list[Path] = []
    occurrence_context: list[str] = []
    for path in sorted(CPP_ROOT.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        if "InstallCrashFixHooks" in text:
            candidates.append(path)
            index = text.find("InstallCrashFixHooks")
            start = max(0, text.rfind("\n", 0, max(0, index - 300)))
            end = text.find("\n", min(len(text), index + 600))
            if end == -1:
                end = min(len(text), index + 600)
            occurrence_context.append(f"{path}:\n{text[start:end].strip()}")

    for path in candidates:
        text = path.read_text(encoding="utf-8-sig")
        match = install_pattern.search(text)
        if not match:
            continue

        if "GTA TextureCompat v2" not in text:
            text = text[:match.start()] + helper + text[match.start():]
            match = install_pattern.search(text)
            if not match:
                raise SystemExit("InstallCrashFixHooks disappeared after TextureCompat insertion")

        if "[TextureCompat] v2 PLT hooks installed" not in text:
            brace_end = match.end()
            text = text[:brace_end] + hook_install + text[brace_end:]

        path.write_text(text, encoding="utf-8")
        print(f"Patched deterministic TextureCompat PLT hooks in {path}")
        return

    print("InstallCrashFixHooks source candidates:")
    for snippet in occurrence_context:
        print("\n---\n" + snippet)
    raise SystemExit("Unable to match InstallCrashFixHooks definition for TextureCompat")


if __name__ == "__main__":
    patch_settings_defaults()
    patch_imgui_font_fallback()
    patch_texture_database_compat()

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
        if (
            "GTA TextureCompat v2" in text
            and "kTextureDatabaseRuntimeLoadGot = 0x849430" in text
            and "kTextureDatabaseLoadThumbsGot = 0x84EB88" in text
            and "[TextureCompat] v2 PLT hooks installed" in text
        ):
            patched_hook = True
            break
    assert patched_hook

    print("Patched native defaults and deterministic TextureCompat v2 successfully.")
