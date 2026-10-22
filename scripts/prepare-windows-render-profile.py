"""Instrument disposable copies of the original and candidate drawing code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
baseline = subprocess.check_output(
    ["git", "show", "7370e7ab5e5be0c626858930ba34af172151d8ce:src/windows/app.cpp"], cwd=root
)
assert hashlib.sha256(baseline).hexdigest() == "348ca1a2464c05831c489c04068707607a7602c6c50e9637962b421cf7dac9a8"
bindings = {}


def once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


previous_commit = "59a2304aee8c83b95889d692ca01d2db9d17fc1b"
previous = subprocess.check_output(["git", "show", previous_commit + ":src/windows/app.cpp"], cwd=root)
for version, source in (("before", baseline), ("previous", previous), ("after", (root / "src/windows/app.cpp").read_bytes())):
    # Windows checkout may use CRLF; instrument the same canonical source text.
    text = source.decode("utf-8").replace("\r\n", "\n")
    bindings[version] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    # The profiling fixture supplies public source artwork directly to the
    # renderer. It never imports a pack or changes any license validation.
    text = once(text, "niuma::AppearancePack* CurrentAppearancePack() {",
        "niuma::AppearancePack* CurrentAppearancePack() {\n"
        "  if (gProfileFixturePack) return gProfileFixturePack;")
    for function, label in (("DrawWidgetText", "text"), ("DrawSceneArtwork", "builtin.artwork"),
                            ("DrawScene", "scene.total"), ("CountGlobalDelivery", "input.handler"),
                            ("RenderLayeredWindow", "frame.total")):
        pattern = rf"(void {function}\([^{{}}]+\)\s*\{{)"
        text, count = re.subn(pattern, rf'\1\n  perf::Scope profileScope("{label}");', text)
        assert count == 1, function
    text = once(text, "    niuma::DrawAppearancePack(graphics, *appearancePack, progress);",
        '    perf::Scope profilePack("pack.artwork");\n'
        "    niuma::DrawAppearancePack(graphics, *appearancePack, progress);")
    begin = text.index("void RenderLayeredWindow(")
    end = text.index("void EnsureAnimationTimer()", begin)
    render = text[begin:end]
    render = once(render, "  HDC screen = GetDC(nullptr);",
        '  perf::Scope profileSurface("surface.prepare");\n  HDC screen = GetDC(nullptr);')
    if version == "after":
        render = once(render, "  HDC memoryDc = gLayeredSurface.dc();",
            "  HDC memoryDc = gLayeredSurface.dc();\n  profileSurface.Stop();")
    else:
        render = once(render, "  {\n    Gdiplus::Graphics graphics(memoryDc);",
            "  profileSurface.Stop();\n  {\n    Gdiplus::Graphics graphics(memoryDc);")
    render = once(render, "  UpdateLayeredWindow(",
        '  if (perf::captureNext) perf::Capture(' +
        ('pixels' if version == 'before' else 'gLayeredSurface.pixels()') +
        ', static_cast<std::size_t>(gState.windowWidth) * gState.windowHeight * 4, gState.windowWidth, gState.windowHeight);\n'
        '  {\n  perf::Scope profileSubmit("window.submit");\n  const BOOL submitted = UpdateLayeredWindow(')
    render = once(render, "RGB(0, 0, 0), &blend, ULW_ALPHA);",
        "RGB(0, 0, 0), &blend, ULW_ALPHA);\n"
        "  if (!submitted) ++perf::submitFailures;\n  }")
    text = text[:begin] + render + text[end:]
    # Preserve the original include locations in the disposable translation unit.
    def absolute_include(match):
        include = (root / "src/windows" / match.group(1)).resolve()
        return f'#include "{include.as_posix()}"' if include.is_file() else match.group(0)
    text = re.sub(r'^#include "([^"]+)"', absolute_include, text, flags=re.M)
    (output / f"profile-app-{version}.cpp").write_text(text, encoding="utf-8")
    pack_source = ((root / "src/windows/appearance_pack.cpp").read_bytes() if version == "after"
        else subprocess.check_output(["git", "show", (previous_commit if version == "previous"
        else "7370e7ab5e5be0c626858930ba34af172151d8ce") + ":src/windows/appearance_pack.cpp"], cwd=root))
    pack_text = pack_source.decode("utf-8").replace("\r\n", "\n")
    bindings[version + "Pack"] = hashlib.sha256(pack_text.encode("utf-8")).hexdigest()
    pack_text = re.sub(r'^#include "([^"]+)"', absolute_include, pack_text, flags=re.M)
    (output / f"profile-pack-{version}.cpp").write_text(pack_text, encoding="utf-8")

bindings["fixtureManifest"] = hashlib.sha256(
    (root / "assets/appearance-packs/offwork-button/manifest.json").read_text(encoding="utf-8").encode("utf-8")).hexdigest()
bindings["lineEndingNormalization"] = "LF"
(output / "render-profile-source.json").write_text(json.dumps(bindings, indent=2), encoding="utf-8")
