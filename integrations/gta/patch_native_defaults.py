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
        '''if(reader.ParseError() < 0)\n\t{\n\t\tLog("Settings file unavailable at %s; continuing with built-in defaults.", buff);\n\t}''',
        "settings.ini fallback",
        flags=re.DOTALL,
    )
    SETTINGS.write_text(text, encoding="utf-8")


def patch_imgui_font_fallback() -> None:
    text = IMGUI_WRAPPER.read_text(encoding="utf-8-sig")
    text = replace_once(
        text,
        r'''if\s*\(font\s*==\s*nullptr\)\s*\{\s*Log::addParameter\("font",\s*font\);\s*return\s+false;\s*\}''',
        '''if (font == nullptr)\n    {\n        font = io.Fonts->AddFontDefault();\n    }\n\n    if (font == nullptr)\n    {\n        Log::addParameter("font", font);\n        return false;\n    }''',
        "ImGui font fallback",
        flags=re.DOTALL,
    )
    IMGUI_WRAPPER.write_text(text, encoding="utf-8")


def _pvr_format_expression(original: str) -> str | None:
    value = original.strip()
    if re.fullmatch(r"[0-9]+", value):
        return "4"
    if "TextureDatabaseFormat" in value:
        return "(TextureDatabaseFormat)4"
    return None


def patch_android_texture_database_formats() -> None:
    """Use the cache's native Android PVR format for player/menu databases.

    GTA SA Android texture DB format ids are: 1=DXT, 4=PVR, 6=automatic.
    This client currently reaches player.dxt.tmb on the test cache, while the
    cache contains player.pvr.{dat,tmb,toc}. We only rewrite explicit
    TextureDatabaseRuntime::Load-style calls for player/playerhi/menu and keep
    the SAMP texture database untouched.
    """

    extensions = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"}
    target_names = ("playerhi", "player", "menu")
    patched_calls: list[str] = []
    candidate_context: list[str] = []

    direct_call = re.compile(
        r'''(?P<prefix>(?:TextureDatabaseRuntime\s*::\s*Load|LoadTextureDatabase|TextureDatabaseRuntime_Load)\s*\(\s*"(?P<name>playerhi|player|menu)"\s*,\s*[^,()\n]+\s*,\s*)(?P<format>[^)\n]+)(?P<suffix>\))'''
    )

    generic_three_arg = re.compile(
        r'''(?P<prefix>\(\s*"(?P<name>playerhi|player|menu)"\s*,\s*(?:false|true|0|1)\s*,\s*)(?P<format>(?:\(\s*TextureDatabaseFormat\s*\)\s*)?[0-9]+|TextureDatabaseFormat[^,;\n)]*)(?P<suffix>\))'''
    )

    for path in sorted(CPP_ROOT.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue

        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue

        if not any(f'"{name}"' in text for name in target_names):
            continue

        for match in re.finditer(r"TextureDatabaseRuntime|playerhi|\"player\"|\"menu\"", text):
            start = max(0, text.rfind("\n", 0, match.start() - 220))
            end = text.find("\n", match.end() + 260)
            if end == -1:
                end = min(len(text), match.end() + 260)
            snippet = text[start:end].strip()
            if snippet and snippet not in candidate_context:
                candidate_context.append(f"{path}:\n{snippet}")
            if len(candidate_context) >= 24:
                break

        def rewrite(match: re.Match[str]) -> str:
            replacement = _pvr_format_expression(match.group("format"))
            if replacement is None:
                return match.group(0)
            name = match.group("name")
            patched_calls.append(
                f"{path}: {name}: {match.group('format').strip()} -> {replacement}"
            )
            return match.group("prefix") + replacement + match.group("suffix")

        updated = direct_call.sub(rewrite, text)
        updated = generic_three_arg.sub(rewrite, updated)

        if updated != text:
            path.write_text(updated, encoding="utf-8")

    if not patched_calls:
        print("No explicit player/menu texture format call was patched.")
        print("Candidate native source context follows:")
        for snippet in candidate_context:
            print("\n---\n" + snippet)
        raise SystemExit("Unable to locate the GTA texture database format selection call")

    print("Patched Android GTA texture database formats:")
    for item in patched_calls:
        print(" - " + item)


if __name__ == "__main__":
    patch_settings_defaults()
    patch_imgui_font_fallback()
    patch_android_texture_database_formats()

    settings_text = SETTINGS.read_text(encoding="utf-8")
    imgui_text = IMGUI_WRAPPER.read_text(encoding="utf-8")
    assert "std::terminate();" not in settings_text
    assert "continuing with built-in defaults" in settings_text
    assert "AddFontDefault()" in imgui_text
    print("Patched native settings, font fallback, and Android texture formats successfully.")
