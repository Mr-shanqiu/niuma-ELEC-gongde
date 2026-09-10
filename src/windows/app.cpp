#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <gdiplus.h>
#include <objidl.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <memory>
#include <string>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"NiuMaMeritWindow";
constexpr wchar_t kWindowTitle[] = L"牛马电子功德";
constexpr wchar_t kMutexName[] = L"Local\\NiuMaMeritCounter";
constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"NiuMaMerit";
constexpr UINT kCountMessage = WM_APP + 1;
constexpr UINT kScrollMessage = WM_APP + 2;
constexpr UINT_PTR kAnimationTimer = 1;
constexpr int kFishResource = 101;
constexpr int kMalletResource = 102;
constexpr int kDesignWidth = 240;
constexpr int kDesignHeight = 250;
constexpr int kWindowDipWidth = 120;
constexpr int kWindowDipHeight = 125;
constexpr ULONGLONG kScrollGestureGapMs = 180;
constexpr ULONGLONG kTempoResetGapMs = 600;
constexpr int kDefaultStrikeMs = 220;
constexpr int kMinStrikeMs = 120;
constexpr int kMaxStrikeMs = 240;

// Animation constants shared with the macOS client (see WORK_PLAN 5.3/5.5).
constexpr double kTempoFactor = 1.05;
constexpr float kContactPhase = 0.42f;
constexpr float kPlusStartPhase = 0.30f;
constexpr float kPlusEndPhase = 0.70f;

// Context menu command identifiers.
constexpr UINT_PTR kMenuAbout = 1;
constexpr UINT_PTR kMenuPrivacyNotice = 2;
constexpr UINT_PTR kMenuLaunchAtLogin = 3;
constexpr UINT_PTR kMenuQuit = 4;

struct PngResource {
  IStream* stream = nullptr;
  std::unique_ptr<Gdiplus::Image> image;

  ~PngResource() {
    image.reset();
    if (stream != nullptr) {
      stream->Release();
    }
  }

  PngResource(const PngResource&) = delete;
  PngResource& operator=(const PngResource&) = delete;
  PngResource() = default;
};

struct AppState {
  HWND window = nullptr;
  HHOOK keyboardHook = nullptr;
  HHOOK mouseHook = nullptr;
  HANDLE mutex = nullptr;
  ULONG_PTR gdiplusToken = 0;
  UINT dpi = 96;
  int windowWidth = kWindowDipWidth;
  int windowHeight = kWindowDipHeight;
  std::uint64_t total = 0;
  ULONGLONG lastInputTime = 0;
  ULONGLONG lastScrollEventTime = 0;
  double intervalEma = static_cast<double>(kDefaultStrikeMs);
  bool striking = false;
  ULONGLONG strikeStarted = 0;
  int strikeDurationMs = kDefaultStrikeMs;
  bool dirty = false;
  bool timerRunning = false;
};

AppState gState;
PngResource gFish;
PngResource gMallet;

void EnableBestDpiAwareness() {
  using SetContextFn = BOOL(WINAPI*)(HANDLE);
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");
  const auto setContext = reinterpret_cast<SetContextFn>(
      GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
  if (setContext != nullptr &&
      setContext(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4)))) {
    return;
  }

  using SetAwareFn = BOOL(WINAPI*)();
  const auto setAware =
      reinterpret_cast<SetAwareFn>(GetProcAddress(user32, "SetProcessDPIAware"));
  if (setAware != nullptr) {
    setAware();
  }
}

UINT SystemDpi() {
  using GetDpiFn = UINT(WINAPI*)();
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");
  const auto getDpi =
      reinterpret_cast<GetDpiFn>(GetProcAddress(user32, "GetDpiForSystem"));
  if (getDpi != nullptr) {
    return getDpi();
  }

  HDC screen = GetDC(nullptr);
  const int dpi = screen == nullptr ? 96 : GetDeviceCaps(screen, LOGPIXELSX);
  if (screen != nullptr) {
    ReleaseDC(nullptr, screen);
  }
  return dpi > 0 ? static_cast<UINT>(dpi) : 96;
}

int ScaleDip(int dip, UINT dpi) {
  return MulDiv(dip, static_cast<int>(dpi), 96);
}

std::wstring DataPath() {
  static const std::wstring path = [] {
    wchar_t folder[MAX_PATH] = {};
    if (FAILED(SHGetFolderPathW(
            nullptr, CSIDL_LOCAL_APPDATA, nullptr, SHGFP_TYPE_CURRENT, folder))) {
      return std::wstring();
    }
    std::wstring directory(folder);
    directory += L"\\NiuMaMerit";
    CreateDirectoryW(directory.c_str(), nullptr);
    return directory + L"\\data.ini";
  }();
  return path;
}

bool StartedAutomatically() {
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments == nullptr) {
    return false;
  }
  bool automatic = false;
  for (int index = 1; index < argumentCount; ++index) {
    if (lstrcmpiW(arguments[index], L"--autostart") == 0) {
      automatic = true;
      break;
    }
  }
  LocalFree(arguments);
  return automatic;
}

bool SetLaunchAtLoginEnabled(bool enabled) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0,
                      KEY_QUERY_VALUE | KEY_SET_VALUE, nullptr, &key,
                      nullptr) != ERROR_SUCCESS) {
    return false;
  }

  LSTATUS status = ERROR_SUCCESS;
  if (enabled) {
    wchar_t executable[MAX_PATH] = {};
    const DWORD length =
        GetModuleFileNameW(nullptr, executable, static_cast<DWORD>(std::size(executable)));
    if (length == 0 || length >= std::size(executable)) {
      RegCloseKey(key);
      return false;
    }
    const std::wstring command =
        L"\"" + std::wstring(executable, length) + L"\" --autostart";
    status = RegSetValueExW(
        key, kRunValue, 0, REG_SZ,
        reinterpret_cast<const BYTE*>(command.c_str()),
        static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
  } else {
    status = RegDeleteValueW(key, kRunValue);
    if (status == ERROR_FILE_NOT_FOUND) {
      status = ERROR_SUCCESS;
    }
  }
  RegCloseKey(key);
  return status == ERROR_SUCCESS;
}

bool IsLaunchAtLoginEnabled() {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_QUERY_VALUE, &key) !=
      ERROR_SUCCESS) {
    return false;
  }
  const LSTATUS status = RegQueryValueExW(
      key, kRunValue, nullptr, nullptr, nullptr, nullptr);
  RegCloseKey(key);
  return status == ERROR_SUCCESS;
}

void SaveLaunchAtLoginPreference(bool enabled) {
  const std::wstring path = DataPath();
  if (path.empty()) {
    return;
  }
  WritePrivateProfileStringW(
      L"state", L"autostart_configured", L"1", path.c_str());
  WritePrivateProfileStringW(
      L"state", L"autostart_enabled", enabled ? L"1" : L"0", path.c_str());
}

void ConfigureLaunchAtLogin() {
  const std::wstring path = DataPath();
  if (path.empty()) {
    return;
  }
  const bool configured =
      GetPrivateProfileIntW(L"state", L"autostart_configured", 0,
                            path.c_str()) == 1;
  const bool preferredEnabled =
      GetPrivateProfileIntW(L"state", L"autostart_enabled", 1,
                            path.c_str()) == 1;
  if (!configured) {
    if (SetLaunchAtLoginEnabled(true)) {
      SaveLaunchAtLoginPreference(true);
    }
  } else if (preferredEnabled) {
    // Refresh the executable path after the app is moved or updated.
    SetLaunchAtLoginEnabled(true);
  }
}

long ReadIniLong(const wchar_t* key, long fallback) {
  const std::wstring path = DataPath();
  if (path.empty()) {
    return fallback;
  }
  wchar_t value[64] = {};
  wchar_t fallbackText[64] = {};
  swprintf_s(fallbackText, L"%ld", fallback);
  GetPrivateProfileStringW(
      L"state", key, fallbackText, value, static_cast<DWORD>(std::size(value)),
      path.c_str());
  wchar_t* end = nullptr;
  const long result = wcstol(value, &end, 10);
  return end == value ? fallback : result;
}

std::uint64_t ReadIniTotal() {
  const std::wstring path = DataPath();
  if (path.empty()) {
    return 0;
  }
  wchar_t value[64] = {};
  GetPrivateProfileStringW(
      L"state", L"total", L"0", value, static_cast<DWORD>(std::size(value)),
      path.c_str());
  wchar_t* end = nullptr;
  const unsigned long long result = _wcstoui64(value, &end, 10);
  return end == value ? 0 : static_cast<std::uint64_t>(result);
}

void SaveState() {
  const std::wstring path = DataPath();
  if (path.empty() || gState.window == nullptr) {
    return;
  }

  RECT rect = {};
  GetWindowRect(gState.window, &rect);
  wchar_t total[64] = {};
  wchar_t x[32] = {};
  wchar_t y[32] = {};
  swprintf_s(total, L"%llu", static_cast<unsigned long long>(gState.total));
  swprintf_s(x, L"%ld", rect.left);
  swprintf_s(y, L"%ld", rect.top);
  WritePrivateProfileStringW(L"state", L"total", total, path.c_str());
  WritePrivateProfileStringW(L"state", L"x", x, path.c_str());
  WritePrivateProfileStringW(L"state", L"y", y, path.c_str());
  gState.dirty = false;
}

bool LoadPngResource(int resourceId, PngResource& output) {
  HRSRC resource =
      FindResourceW(nullptr, MAKEINTRESOURCEW(resourceId), RT_RCDATA);
  if (resource == nullptr) {
    return false;
  }
  HGLOBAL loaded = LoadResource(nullptr, resource);
  const DWORD size = SizeofResource(nullptr, resource);
  const void* bytes = LockResource(loaded);
  if (loaded == nullptr || bytes == nullptr || size == 0) {
    return false;
  }

  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, size);
  if (memory == nullptr) {
    return false;
  }
  void* destination = GlobalLock(memory);
  if (destination == nullptr) {
    GlobalFree(memory);
    return false;
  }
  CopyMemory(destination, bytes, size);
  GlobalUnlock(memory);

  IStream* stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(memory, TRUE, &stream))) {
    GlobalFree(memory);
    return false;
  }

  std::unique_ptr<Gdiplus::Image> image(Gdiplus::Image::FromStream(stream));
  if (!image || image->GetLastStatus() != Gdiplus::Ok) {
    image.reset();
    stream->Release();
    return false;
  }

  output.stream = stream;
  output.image = std::move(image);
  return true;
}

float SmoothStep(float value) {
  const float clamped = std::clamp(value, 0.0f, 1.0f);
  return clamped * clamped * (3.0f - 2.0f * clamped);
}

void DrawCenteredText(Gdiplus::Graphics& graphics,
                      const std::wstring& text,
                      const Gdiplus::RectF& rect,
                      float fontSize,
                      BYTE alpha,
                      const wchar_t* family = L"Segoe UI",
                      Gdiplus::FontStyle style = Gdiplus::FontStyleBold) {
  Gdiplus::Font font(family, fontSize, style, Gdiplus::UnitPixel);
  Gdiplus::StringFormat format;
  format.SetAlignment(Gdiplus::StringAlignmentCenter);
  format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  Gdiplus::SolidBrush brush(Gdiplus::Color(alpha, 240, 139, 35));
  graphics.DrawString(
      text.c_str(), -1, &font, rect, &format, &brush);
}

void DrawScene(Gdiplus::Graphics& graphics, ULONGLONG now) {
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);

  const std::wstring totalText = std::to_wstring(gState.total);
  float totalFont = 36.0f;
  if (totalText.size() > 18) {
    totalFont = 27.0f;
  }
  if (totalText.size() > 24) {
    totalFont = 23.0f;
  }
  // Monospaced digits keep the number from jittering as digits are added.
  DrawCenteredText(graphics, totalText,
                   Gdiplus::RectF(0.0f, 0.0f, 240.0f, 40.0f), totalFont, 255,
                   L"Consolas");

  Gdiplus::SolidBrush shadow(Gdiplus::Color(62, 0, 0, 0));
  graphics.FillEllipse(&shadow, 34.0f, 227.0f, 172.0f, 18.0f);

  graphics.DrawImage(
      gFish.image.get(), Gdiplus::RectF(18.0f, 102.0f, 232.0f, 140.0f));

  float progress = 0.0f;
  if (gState.striking) {
    const float elapsed =
        static_cast<float>(now - gState.strikeStarted);
    progress =
        std::clamp(elapsed / static_cast<float>(gState.strikeDurationMs),
                   0.0f, 1.0f);
  }

  float angle = 6.0f;
  if (gState.striking) {
    if (progress < kContactPhase) {
      const float down = SmoothStep(progress / kContactPhase);
      angle = 6.0f + (-4.5f - 6.0f) * down;
    } else {
      const float up = SmoothStep((progress - kContactPhase) /
                                  (1.0f - kContactPhase));
      angle = -4.5f + (6.0f + 4.5f) * up;
    }
  }

  const Gdiplus::GraphicsState transformState = graphics.Save();
  graphics.TranslateTransform(280.0f, 90.0f);
  graphics.RotateTransform(angle);
  graphics.TranslateTransform(-280.0f, -90.0f);
  graphics.DrawImage(
      gMallet.image.get(), Gdiplus::RectF(72.0f, 63.0f, 214.0f, 54.0f));
  graphics.Restore(transformState);

  // Draw the middle band last so the mallet can never cover it.
  if (gState.striking && progress >= kPlusStartPhase &&
      progress <= kPlusEndPhase) {
    DrawCenteredText(
        graphics, L"+1", Gdiplus::RectF(0.0f, 66.0f, 240.0f, 30.0f),
        22.0f, 255);
  }
}

void RenderLayeredWindow(ULONGLONG now) {
  if (gState.window == nullptr || !gFish.image || !gMallet.image) {
    return;
  }

  HDC screen = GetDC(nullptr);
  if (screen == nullptr) {
    return;
  }
  HDC memoryDc = CreateCompatibleDC(screen);
  if (memoryDc == nullptr) {
    ReleaseDC(nullptr, screen);
    return;
  }

  BITMAPINFO bitmap = {};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = gState.windowWidth;
  bitmap.bmiHeader.biHeight = -gState.windowHeight;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  bitmap.bmiHeader.biCompression = BI_RGB;

  void* pixels = nullptr;
  HBITMAP surface =
      CreateDIBSection(screen, &bitmap, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (surface == nullptr) {
    DeleteDC(memoryDc);
    ReleaseDC(nullptr, screen);
    return;
  }
  HGDIOBJ previous = SelectObject(memoryDc, surface);
  ZeroMemory(
      pixels,
      static_cast<SIZE_T>(gState.windowWidth) *
          static_cast<SIZE_T>(gState.windowHeight) * 4);

  {
    Gdiplus::Graphics graphics(memoryDc);
    graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
    const float scale =
        static_cast<float>(gState.windowWidth) /
        static_cast<float>(kDesignWidth);
    graphics.ScaleTransform(scale, scale);
    DrawScene(graphics, now);
  }

  RECT rect = {};
  GetWindowRect(gState.window, &rect);
  POINT destination = {rect.left, rect.top};
  POINT source = {0, 0};
  SIZE size = {gState.windowWidth, gState.windowHeight};
  BLENDFUNCTION blend = {
      AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
  UpdateLayeredWindow(
      gState.window, screen, &destination, &size, memoryDc, &source,
      RGB(0, 0, 0), &blend, ULW_ALPHA);

  SelectObject(memoryDc, previous);
  DeleteObject(surface);
  DeleteDC(memoryDc);
  ReleaseDC(nullptr, screen);
}

void EnsureAnimationTimer() {
  if (!gState.timerRunning && gState.window != nullptr) {
    SetTimer(gState.window, kAnimationTimer, 16, nullptr);
    gState.timerRunning = true;
  }
}

void CountOneOperation() {
  const ULONGLONG now = GetTickCount64();
  int nextDuration = kDefaultStrikeMs;

  if (gState.lastInputTime != 0) {
    const ULONGLONG interval = now - gState.lastInputTime;
    if (interval <= kTempoResetGapMs) {
      gState.intervalEma =
          gState.intervalEma * 0.65 +
          static_cast<double>(interval) * 0.35;
      nextDuration = std::clamp(
          static_cast<int>(std::lround(gState.intervalEma * kTempoFactor)),
          kMinStrikeMs, kMaxStrikeMs);
    } else {
      gState.intervalEma = static_cast<double>(kDefaultStrikeMs);
    }
  }

  gState.lastInputTime = now;
  ++gState.total;
  gState.dirty = true;

  // There is deliberately no animation queue. Counts are immediate, while
  // rapid inputs merely allow the next visible strike to use a shorter cycle.
  if (!gState.striking) {
    gState.striking = true;
    gState.strikeStarted = now;
    gState.strikeDurationMs = nextDuration;
  }

  const bool wasRunning = gState.timerRunning;
  EnsureAnimationTimer();
  if (!wasRunning) {
    RenderLayeredWindow(now);
  }
}

void CountScrollGesture() {
  const ULONGLONG now = GetTickCount64();
  const bool startsNewGesture =
      gState.lastScrollEventTime == 0 ||
      now - gState.lastScrollEventTime > kScrollGestureGapMs;
  gState.lastScrollEventTime = now;
  if (startsNewGesture) {
    CountOneOperation();
  }
}

LRESULT CALLBACK KeyboardHook(
    int code, WPARAM message, LPARAM data) {
  (void)data;
  if (code == HC_ACTION &&
      (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) &&
      gState.window != nullptr) {
    PostMessageW(gState.window, kCountMessage, 0, 0);
  }
  return CallNextHookEx(gState.keyboardHook, code, message, data);
}

LRESULT CALLBACK MouseHook(
    int code, WPARAM message, LPARAM data) {
  (void)data;
  if (code == HC_ACTION && gState.window != nullptr) {
    switch (message) {
      case WM_LBUTTONDOWN:
      case WM_RBUTTONDOWN:
      case WM_MBUTTONDOWN:
      case WM_XBUTTONDOWN:
        PostMessageW(gState.window, kCountMessage, 0, 0);
        break;
      case WM_MOUSEWHEEL:
      case WM_MOUSEHWHEEL:
        PostMessageW(gState.window, kScrollMessage, 0, 0);
        break;
      default:
        break;
    }
  }
  return CallNextHookEx(gState.mouseHook, code, message, data);
}

void ShowPrivacyNotice(HWND owner) {
  MessageBoxW(
      owner,
      L"牛马电子功德只统计按键、鼠标按键和滚轮手势发生的次数。\n\n"
      L"程序不会读取、保存或上传按键内容、鼠标位置、当前应用、"
      L"剪贴板或屏幕内容；程序不包含联网功能。",
      L"隐私说明", MB_OK | MB_ICONINFORMATION);
}

void ShowAboutDialog(HWND owner) {
  const std::wstring version = L"0.3.0";
  std::wstring text = L"牛马电子功德 v" + version + L"\n\n";
  text += L"本软件完全离线运行，不包含网络请求、遥测或自动更新功能。\n";
  text += L"如需获取最新版本，请访问以下网址手动下载：\n\n";
  text += L"https://github.com/Mr-shanqiu/niuma-ELEC-gongde";
  MessageBoxW(owner, text.c_str(), L"关于牛马电子功德",
              MB_OK | MB_ICONINFORMATION);
}

void ShowPrivacyNoticeIfNeeded(HWND owner) {
  const std::wstring path = DataPath();
  if (path.empty() ||
      GetPrivateProfileIntW(L"state", L"privacy_shown", 0, path.c_str()) == 1) {
    return;
  }

  ShowPrivacyNotice(owner);
  WritePrivateProfileStringW(
      L"state", L"privacy_shown", L"1", path.c_str());
}

void ClampWindowToWorkArea() {
  if (gState.window == nullptr) {
    return;
  }
  RECT rect = {};
  GetWindowRect(gState.window, &rect);
  HMONITOR monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
  MONITORINFO info = {sizeof(info)};
  if (!GetMonitorInfoW(monitor, &info)) {
    return;
  }

  const LONG maximumX =
      std::max(info.rcWork.left,
               info.rcWork.right - static_cast<LONG>(gState.windowWidth));
  const LONG maximumY =
      std::max(info.rcWork.top,
               info.rcWork.bottom - static_cast<LONG>(gState.windowHeight));
  const LONG x = std::clamp(rect.left, info.rcWork.left, maximumX);
  const LONG y = std::clamp(rect.top, info.rcWork.top, maximumY);
  SetWindowPos(
      gState.window, nullptr, x, y, 0, 0,
      SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void ApplyWindowDpi(HWND window) {
  using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");
  const auto getDpiForWindow = reinterpret_cast<GetDpiForWindowFn>(
      GetProcAddress(user32, "GetDpiForWindow"));
  if (getDpiForWindow == nullptr) {
    return;
  }
  const UINT windowDpi = getDpiForWindow(window);
  if (windowDpi == 0 || windowDpi == gState.dpi) {
    return;
  }

  gState.dpi = windowDpi;
  gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
  gState.windowHeight = ScaleDip(kWindowDipHeight, gState.dpi);
  RECT rect = {};
  GetWindowRect(window, &rect);
  SetWindowPos(window, nullptr, rect.left, rect.top, gState.windowWidth,
               gState.windowHeight, SWP_NOZORDER | SWP_NOACTIVATE);
}

void ShowContextMenu(HWND window, POINT screenPoint) {
  HMENU menu = CreatePopupMenu();
  if (menu == nullptr) {
    return;
  }
  AppendMenuW(menu, MF_STRING, kMenuAbout, L"关于牛马电子功德");
  AppendMenuW(menu, MF_STRING, kMenuPrivacyNotice, L"隐私说明");
  AppendMenuW(
      menu,
      MF_STRING | (IsLaunchAtLoginEnabled() ? MF_CHECKED : MF_UNCHECKED),
      kMenuLaunchAtLogin, L"登录后自动启动");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kMenuQuit, L"退出");

  const int command = TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
      screenPoint.x, screenPoint.y, 0, window, nullptr);
  DestroyMenu(menu);

  if (command == static_cast<int>(kMenuAbout)) {
    ShowAboutDialog(window);
  } else if (command == static_cast<int>(kMenuPrivacyNotice)) {
    ShowPrivacyNotice(window);
  } else if (command == static_cast<int>(kMenuLaunchAtLogin)) {
    const bool enabled = !IsLaunchAtLoginEnabled();
    if (SetLaunchAtLoginEnabled(enabled)) {
      SaveLaunchAtLoginPreference(enabled);
    } else {
      MessageBoxW(window, L"无法修改登录启动项，请稍后重试。",
                  kWindowTitle, MB_OK | MB_ICONERROR);
    }
  } else if (command == static_cast<int>(kMenuQuit)) {
    DestroyWindow(window);
  }
}

LRESULT CALLBACK WindowProcedure(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_CREATE:
      gState.window = window;
      return 0;

    case kCountMessage:
      CountOneOperation();
      return 0;

    case kScrollMessage:
      CountScrollGesture();
      return 0;

    case WM_TIMER: {
      if (wParam != kAnimationTimer) {
        break;
      }
      const ULONGLONG now = GetTickCount64();
      bool needsRender = gState.striking;
      if (gState.striking &&
          now - gState.strikeStarted >=
              static_cast<ULONGLONG>(gState.strikeDurationMs)) {
        gState.striking = false;
        needsRender = true;
      }
      if (needsRender) {
        RenderLayeredWindow(now);
      }
      if (gState.dirty && gState.lastInputTime != 0 &&
          now - gState.lastInputTime >= 500) {
        SaveState();
      }
      if (!gState.striking && !gState.dirty) {
        KillTimer(window, kAnimationTimer);
        gState.timerRunning = false;
      }
      return 0;
    }

    case WM_DPICHANGED: {
      const UINT newDpi = HIWORD(wParam);
      const RECT* suggested = reinterpret_cast<const RECT*>(lParam);
      gState.dpi = newDpi == 0 ? 96 : newDpi;
      gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
      gState.windowHeight = ScaleDip(kWindowDipHeight, gState.dpi);
      SetWindowPos(
          window, nullptr, suggested->left, suggested->top,
          gState.windowWidth, gState.windowHeight,
          SWP_NOZORDER | SWP_NOACTIVATE);
      ClampWindowToWorkArea();
      RenderLayeredWindow(GetTickCount64());
      return 0;
    }

    case WM_DISPLAYCHANGE:
      ClampWindowToWorkArea();
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case WM_NCHITTEST:
      return HTCAPTION;

    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;

    case WM_NCRBUTTONUP: {
      POINT point = {
          GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
      ShowContextMenu(window, point);
      return 0;
    }

    case WM_CONTEXTMENU: {
      POINT point = {
          GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
      if (point.x == -1 && point.y == -1) {
        RECT rect = {};
        GetWindowRect(window, &rect);
        point = {rect.left + rect.right / 2, rect.top + rect.bottom / 2};
      }
      ShowContextMenu(window, point);
      return 0;
    }

    case WM_ENDSESSION:
      if (wParam != 0) {
        SaveState();
      }
      return 0;

    case WM_DESTROY:
      if (gState.timerRunning) {
        KillTimer(window, kAnimationTimer);
        gState.timerRunning = false;
      }
      SaveState();
      gState.window = nullptr;
      PostQuitMessage(0);
      return 0;

    default:
      break;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

}  // namespace

int WINAPI wWinMain(
    HINSTANCE instance, HINSTANCE, PWSTR, int) {
  EnableBestDpiAwareness();

  gState.mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  if (gState.mutex == nullptr) {
    return 1;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    CloseHandle(gState.mutex);
    gState.mutex = nullptr;
    return 0;
  }

  const HRESULT comResult =
      CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  Gdiplus::GdiplusStartupInput startupInput;
  if (Gdiplus::GdiplusStartup(
          &gState.gdiplusToken, &startupInput, nullptr) != Gdiplus::Ok) {
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  if (!LoadPngResource(kFishResource, gFish) ||
      !LoadPngResource(kMalletResource, gMallet)) {
    MessageBoxW(
        nullptr, L"木鱼图像资源加载失败。", kWindowTitle,
        MB_OK | MB_ICONERROR);
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  WNDCLASSEXW windowClass = {};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.lpfnWndProc = WindowProcedure;
  windowClass.hInstance = instance;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_HAND);
  windowClass.lpszClassName = kWindowClass;
  if (RegisterClassExW(&windowClass) == 0) {
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  gState.dpi = SystemDpi();
  gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
  gState.windowHeight = ScaleDip(kWindowDipHeight, gState.dpi);
  gState.total = ReadIniTotal();

  RECT workArea = {};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
  const long missing = std::numeric_limits<long>::min();
  long x = ReadIniLong(L"x", missing);
  long y = ReadIniLong(L"y", missing);
  if (x == missing || y == missing) {
    x = workArea.right - gState.windowWidth - ScaleDip(24, gState.dpi);
    y = workArea.bottom - gState.windowHeight - ScaleDip(24, gState.dpi);
  }

  HWND window = CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      kWindowClass, kWindowTitle, WS_POPUP,
      static_cast<int>(x), static_cast<int>(y),
      gState.windowWidth, gState.windowHeight,
      nullptr, nullptr, instance, nullptr);
  if (window == nullptr) {
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  // A per-monitor aware process must size itself from the DPI of the monitor
  // that actually hosts the window, which can differ from the system DPI.
  ApplyWindowDpi(window);
  ClampWindowToWorkArea();
  RenderLayeredWindow(GetTickCount64());
  ShowWindow(window, SW_SHOWNOACTIVATE);
  SetWindowPos(
      window, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

  ConfigureLaunchAtLogin();
  if (!StartedAutomatically()) {
    ShowPrivacyNoticeIfNeeded(window);
  }

  gState.keyboardHook =
      SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHook, instance, 0);
  gState.mouseHook =
      SetWindowsHookExW(WH_MOUSE_LL, MouseHook, instance, 0);
  if (gState.keyboardHook == nullptr || gState.mouseHook == nullptr) {
    MessageBoxW(
        window, L"无法启动全局键盘或鼠标计数。", kWindowTitle,
        MB_OK | MB_ICONERROR);
    DestroyWindow(window);
  }

  MSG message = {};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (gState.keyboardHook != nullptr) {
    UnhookWindowsHookEx(gState.keyboardHook);
  }
  if (gState.mouseHook != nullptr) {
    UnhookWindowsHookEx(gState.mouseHook);
  }

  gMallet.image.reset();
  if (gMallet.stream != nullptr) {
    gMallet.stream->Release();
    gMallet.stream = nullptr;
  }
  gFish.image.reset();
  if (gFish.stream != nullptr) {
    gFish.stream->Release();
    gFish.stream = nullptr;
  }

  Gdiplus::GdiplusShutdown(gState.gdiplusToken);
  ReleaseMutex(gState.mutex);
  CloseHandle(gState.mutex);
  if (SUCCEEDED(comResult)) {
    CoUninitialize();
  }
  return static_cast<int>(message.wParam);
}
