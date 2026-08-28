from pathlib import Path
import re

SETTINGS = Path("app/src/main/cpp/samp/settings.cpp")
IMGUI_WRAPPER = Path("app/src/main/cpp/samp/gui/imguiwrapper.cpp")


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


if __name__ == "__main__":
    patch_settings_defaults()
    patch_imgui_font_fallback()

    settings_text = SETTINGS.read_text(encoding="utf-8")
    imgui_text = IMGUI_WRAPPER.read_text(encoding="utf-8")
    assert "std::terminate();" not in settings_text
    assert "continuing with built-in defaults" in settings_text
    assert "AddFontDefault()" in imgui_text
    print("Patched native settings and font fallbacks successfully.")
