// Render only the real About dialog in a disposable cloud desktop. The product
// entry, profile, input listeners, associations and startup settings never run.
#define wWinMain NiuMaUnusedApplicationEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <atomic>
#include <iostream>
#include <thread>

namespace {
bool SaveWindow(HWND window, const std::filesystem::path& path) {
  RECT bounds{};
  if (!GetWindowRect(window, &bounds)) return false;
  HDC screen = GetDC(nullptr);
  HDC memory = screen ? CreateCompatibleDC(screen) : nullptr;
  HBITMAP bitmap = memory ? CreateCompatibleBitmap(screen, bounds.right - bounds.left,
      bounds.bottom - bounds.top) : nullptr;
  HGDIOBJ previous = bitmap ? SelectObject(memory, bitmap) : nullptr;
  bool saved = false;
  if (previous && previous != HGDI_ERROR) {
    if (BitBlt(memory, 0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top,
               screen, bounds.left, bounds.top, SRCCOPY | CAPTUREBLT)) {
      const CLSID png{0x557cf406, 0x1a04, 0x11d3, {0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e}};
      Gdiplus::Bitmap image(bitmap, nullptr);
      saved = image.Save(path.c_str(), &png, nullptr) == Gdiplus::Ok;
    }
    SelectObject(memory, previous);
  }
  if (bitmap) DeleteObject(bitmap);
  if (memory) DeleteDC(memory);
  if (screen) ReleaseDC(nullptr, screen);
  return saved;
}
HWND OwnDialog() {
  HWND result = nullptr;
  EnumWindows([](HWND window, LPARAM data) -> BOOL {
    DWORD owner = 0;
    GetWindowThreadProcessId(window, &owner);
    if (owner != GetCurrentProcessId() || !IsWindowVisible(window)) return TRUE;
    wchar_t name[64]{};
    GetClassNameW(window, name, static_cast<int>(std::size(name)));
    if (std::wcscmp(name, L"#32770") != 0) return TRUE;
    *reinterpret_cast<HWND*>(data) = window;
    return FALSE;
  }, reinterpret_cast<LPARAM>(&result));
  return result;
}
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || !std::filesystem::is_directory(argv[1])) return 2;
  const auto directory = std::filesystem::absolute(argv[1]);
  if (std::filesystem::exists(directory / L"about-top.png") ||
      std::filesystem::exists(directory / L"about-group.png")) return 2;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Gdiplus::GdiplusStartupInput startup;
  ULONG_PTR token = 0;
  if (Gdiplus::GdiplusStartup(&token, &startup, nullptr) != Gdiplus::Ok) return 2;
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&controls);
  gIsolatedAcceptance = true;
  gRuntimeCandidate = true;
  gState.dpi = SystemDpi();
  std::atomic<bool> captured{false};
  std::thread observer([&] {
    const auto deadline = GetTickCount64() + 10000;
    HWND dialog = nullptr;
    while (!dialog && GetTickCount64() < deadline) { dialog = OwnDialog(); Sleep(20); }
    if (!dialog) return;
    const HWND viewport = FindWindowExW(dialog, nullptr, L"NiuMaMeritAboutContent", nullptr);
    if (viewport) {
      SetForegroundWindow(dialog);
      SendMessageW(viewport, WM_VSCROLL, SB_TOP, 0);
      RedrawWindow(dialog, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
      Sleep(180);
      const bool top = SaveWindow(dialog, directory / L"about-top.png");
      SendMessageW(viewport, WM_VSCROLL, SB_BOTTOM, 0);
      RedrawWindow(dialog, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
      Sleep(180);
      captured = top && SaveWindow(dialog, directory / L"about-group.png");
    }
    PostMessageW(dialog, WM_COMMAND, IDOK, 0);
  });
  ShowAboutDialog(nullptr);
  observer.join();
  Gdiplus::GdiplusShutdown(token);
  if (SUCCEEDED(com)) CoUninitialize();
  std::cout << "About preview: " << (captured ? "captured" : "failed")
      << "; profile/hooks/system configuration untouched; scan not tested\n";
  return captured ? 0 : 1;
}
