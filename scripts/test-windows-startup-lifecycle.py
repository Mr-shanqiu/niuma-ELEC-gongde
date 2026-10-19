#!/usr/bin/env python3
"""Portable source regression test, not a Windows build or GUI acceptance."""

from pathlib import Path
import shutil
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    opening = text.index("{", start)
    depth = 0
    for index in range(opening, len(text)):
        depth += (text[index] == "{") - (text[index] == "}")
        if depth == 0:
            return text[start:index + 1]
    raise AssertionError("Unclosed block: " + marker)


root = Path(__file__).resolve().parents[1]
source = (root / "src/windows/app.cpp").read_text(encoding="utf-8")
header = (root / "src/windows/appearance_pack.h").read_text(encoding="utf-8")
main = block(source, "int WINAPI wWinMain(")
hook_gate = block(main, "if (PrepareClientStartup(window, pendingAppearancePack))")
assert hook_gate.count("SetWindowsHookExW(") == main.count("SetWindowsHookExW(") == 2
loop_gate = block(main, "if (IsMainWindowAlive(window)) {\n    while (GetMessageW(")
assert "while (GetMessageW(" in loop_gate
shutdown = "Gdiplus::GdiplusShutdown(gState.gdiplusToken);"
shutdowns = source.split(shutdown)
assert len(shutdowns) - 1 == 6
assert all(part.rstrip().endswith("ReleaseAllPngResources();") for part in shutdowns[:-1])
assert source.count("void ReleaseAllPngResources()") == 1
functions = "\n\n".join(block(source, marker) for marker in (
    "void ReleasePngResource(", "void ReleaseAllPngResources()",
    "bool IsMainWindowAlive(", "bool ShowPrivacyNotice(",
    "bool ShowPrivacyNoticeIfNeeded(", "bool PrepareClientStartup("))
catalog = block(header, "class AppearanceCatalog") + ";"

prelude = r'''
#include <cassert>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
bool graphicsActive = true;
int imagesDestroyed = 0, streamsReleased = 0;
struct TestImage { ~TestImage() { assert(graphicsActive); ++imagesDestroyed; } };
struct TestStream { void Release() { ++streamsReleased; delete this; } };
struct PngResource { std::unique_ptr<TestImage> image; TestStream* stream = nullptr; };
namespace niuma {
struct AppearancePack { std::unique_ptr<TestImage> image; };
'''
prelude += catalog + r'''
bool AppearanceCatalog::Reload(const std::wstring&, std::wstring*) {
  auto pack = std::make_unique<AppearancePack>();
  pack->image = std::make_unique<TestImage>();
  packs_.push_back(std::move(pack));
  return true;
}
}
niuma::AppearanceCatalog gAppearanceCatalog;
PngResource gFish, gMallet, gLuckyCatBase, gLuckyCatActor, gSeaLionBody,
    gSeaLionFlipper, gHamsterHabitat, gHamsterActor;
struct Window { bool alive = true; };
using HWND = Window*;
struct State { HWND window = nullptr; } gState;
constexpr int IDOK = 1, IDCANCEL = 2, MB_OK = 0, MB_ICONINFORMATION = 64;
int storedPrivacy = 0, privacyWrites = 0, dialogs = 0, imports = 0;
int dialogResult = IDOK;
bool closeInDialog = false, closeInImport = false, autostart = false;
std::wstring dataPath = L"data.ini";
bool IsWindow(HWND window) { return window && window->alive; }
std::wstring DataPath() { return dataPath; }
const wchar_t* UiText(const wchar_t*, const wchar_t* english) { return english; }
int GetPrivateProfileIntW(const wchar_t*, const wchar_t*, int, const wchar_t*) {
  return storedPrivacy;
}
bool WritePrivateProfileStringW(const wchar_t*, const wchar_t* key,
                               const wchar_t* value, const wchar_t*) {
  assert(std::wstring(key) == L"privacy_shown" && std::wstring(value) == L"1");
  ++privacyWrites; storedPrivacy = 1; return true;
}
int MessageBoxW(HWND owner, const wchar_t*, const wchar_t*, unsigned) {
  ++dialogs;
  if (closeInDialog) { owner->alive = false; gState.window = nullptr; }
  return dialogResult;
}
bool StartedAutomatically() { return autostart; }
void ImportAppearancePack(HWND owner, const std::wstring&, bool success) {
  assert(success); ++imports;
  if (closeInImport) { owner->alive = false; gState.window = nullptr; }
}
'''
cases = r'''
void Reset(Window& window) {
  window.alive = true; gState.window = &window;
  storedPrivacy = privacyWrites = dialogs = imports = 0;
  dialogResult = IDOK;
  closeInDialog = closeInImport = autostart = false;
  dataPath = L"data.ini";
}
int main() {
  Window window, other;
  Reset(window);
  assert(PrepareClientStartup(&window, L"pack") && privacyWrites == 1 && imports == 1);
  Reset(window); dialogResult = IDCANCEL;
  assert(!PrepareClientStartup(&window, L"pack") && privacyWrites == 0 && imports == 0);
  Reset(window); dialogResult = 0;
  assert(!PrepareClientStartup(&window, L"pack") && privacyWrites == 0 && imports == 0);
  Reset(window); closeInDialog = true;
  assert(!PrepareClientStartup(&window, L"pack") && privacyWrites == 0 && imports == 0);
  Reset(window); window.alive = false;
  assert(!PrepareClientStartup(&window, L"pack") && dialogs == 0 && imports == 0);
  Reset(window); storedPrivacy = 1;
  assert(PrepareClientStartup(&window, L"pack") && dialogs == 0 && privacyWrites == 0 && imports == 1);
  Reset(window); autostart = true;
  assert(PrepareClientStartup(&window, L"pack") && dialogs == 0 && privacyWrites == 0 && imports == 1);
  Reset(window); closeInImport = true;
  assert(!PrepareClientStartup(&window, L"pack") && privacyWrites == 1 && imports == 1);
  Reset(window); dataPath.clear();
  assert(PrepareClientStartup(&window, L"pack") && dialogs == 1 && privacyWrites == 0);
  Reset(window); dataPath.clear(); dialogResult = IDCANCEL;
  assert(!PrepareClientStartup(&window, L"pack") && privacyWrites == 0 && imports == 0);
  Reset(window); gState.window = &other;
  assert(!PrepareClientStartup(&window, L"pack") && dialogs == 0 && imports == 0);
  PngResource* resources[] = {&gFish, &gMallet, &gLuckyCatBase, &gLuckyCatActor,
      &gSeaLionBody, &gSeaLionFlipper, &gHamsterHabitat, &gHamsterActor};
  for (auto resource : resources) {
    resource->image = std::make_unique<TestImage>();
    resource->stream = new TestStream();
  }
  assert(gAppearanceCatalog.Reload(L"packs", nullptr));
  ReleaseAllPngResources();
  assert(gAppearanceCatalog.packs().empty() && imagesDestroyed == 9 && streamsReleased == 8);
  graphicsActive = false;
  ReleaseAllPngResources();
  assert(imagesDestroyed == 9 && streamsReleased == 8);
  std::cout << "PASS: 11 startup cases; catalog/resource teardown and repeated cleanup\n";
}
'''
compiler = shutil.which("clang++") or shutil.which("c++")
if not compiler:
    raise SystemExit("No local C++ compiler; no tools were installed.")
with tempfile.TemporaryDirectory(prefix="gongde-win-lifecycle-") as directory:
    cpp = Path(directory) / "lifecycle.cpp"
    executable = Path(directory) / "lifecycle-test"
    cpp.write_text(prelude + functions + cases, encoding="utf-8")
    subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra", "-pedantic",
                    str(cpp), "-o", str(executable)], check=True, timeout=40)
    subprocess.run([str(executable)], check=True, timeout=10)
print("PASS: both hook installs gated; cancelled/destroyed startup skips message loop; all 6 shutdown sites release first")
print("Scope: extracted production functions with Win32/GDI+ substitutes, not native Windows GUI acceptance")
for marker in ("void ReleaseAllPngResources()", "bool IsMainWindowAlive(",
               "bool ShowPrivacyNoticeIfNeeded(", "bool PrepareClientStartup(",
               "if (PrepareClientStartup(window, pendingAppearancePack))"):
    print("src/windows/app.cpp:%d %s" % (source[:source.index(marker)].count("\n") + 1, marker))
