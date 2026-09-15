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

#include "appearance_pack.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cwchar>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"NiuMaMeritWindow";
constexpr wchar_t kPickerClass[] = L"NiuMaMeritAppearancePicker";
constexpr wchar_t kCalendarClass[] = L"NiuMaMeritCalendar";
constexpr wchar_t kMutexName[] = L"Local\\NiuMaMeritCounter";
constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"NiuMaMerit";
constexpr UINT kCountMessage = WM_APP + 1;
constexpr UINT kScrollMessage = WM_APP + 2;
constexpr ULONG_PTR kAppearancePackCopyData = 0x4E4D4750;
constexpr UINT_PTR kAnimationTimer = 1;
constexpr UINT_PTR kDayTimer = 2;
constexpr int kFishResource = 101;
constexpr int kMalletResource = 102;
constexpr int kLuckyCatBaseResource = 104;
constexpr int kLuckyCatActorResource = 105;
constexpr int kChickBaseResource = 106;
constexpr int kChickActorResource = 107;
constexpr int kHamsterHabitatResource = 108;
constexpr int kHamsterActorResource = 109;
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
constexpr UINT_PTR kMenuLaunchAtLogin = 2;
constexpr UINT_PTR kMenuAppearance = 3;
constexpr UINT_PTR kMenuCalendar = 4;
constexpr UINT_PTR kMenuQuit = 5;

bool IsChineseUi() {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
}

const wchar_t* UiText(const wchar_t* chinese, const wchar_t* english) {
  return IsChineseUi() ? chinese : english;
}

const wchar_t* WindowTitle() {
  return UiText(L"牛马电子功德", L"NiuMa Merit");
}

enum class MeritScene : int {
  Woodfish = 0,
  LuckyCat = 1,
  ChickPecking = 2,
  HamsterWheel = 3,
};

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
  std::uint64_t todayTotal = 0;
  std::wstring currentDay;
  ULONGLONG lastInputTime = 0;
  ULONGLONG lastScrollEventTime = 0;
  double intervalEma = static_cast<double>(kDefaultStrikeMs);
  bool striking = false;
  ULONGLONG strikeStarted = 0;
  int strikeDurationMs = kDefaultStrikeMs;
  bool dirty = false;
  bool timerRunning = false;
  MeritScene selectedScene = MeritScene::Woodfish;
  std::string selectedPackId;
};

AppState gState;
PngResource gFish;
PngResource gMallet;
PngResource gLuckyCatBase;
PngResource gLuckyCatActor;
PngResource gChickBase;
PngResource gChickActor;
PngResource gHamsterHabitat;
PngResource gHamsterActor;
niuma::AppearanceCatalog gAppearanceCatalog;

struct PickerState {
  HWND window = nullptr;
  int pendingIndex = 0;
  int scrollRow = 0;
  bool confirmed = false;
};

PickerState gPicker;

struct CalendarState {
  HWND window = nullptr;
  int year = 0;
  int month = 0;
};

CalendarState gCalendar;

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

std::wstring AppearanceDirectory() {
  const std::wstring dataPath = DataPath();
  const size_t separator = dataPath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return {};
  const std::wstring directory = dataPath.substr(0, separator) + L"\\Appearances";
  CreateDirectoryW(directory.c_str(), nullptr);
  return directory;
}

std::string ReadSelectedPackId() {
  const std::wstring path = DataPath();
  if (path.empty()) return {};
  wchar_t value[128] = {};
  GetPrivateProfileStringW(L"state", L"selected_pack_id", L"", value,
                           static_cast<DWORD>(std::size(value)), path.c_str());
  std::string result;
  for (const wchar_t character : std::wstring(value)) {
    if (character > 127) return {};
    result.push_back(static_cast<char>(character));
  }
  return result;
}

niuma::AppearancePack* CurrentAppearancePack() {
  return gState.selectedPackId.empty()
      ? nullptr
      : gAppearanceCatalog.Find(gState.selectedPackId);
}

std::wstring DateKey(const SYSTEMTIME& date) {
  wchar_t key[16] = {};
  swprintf_s(key, L"%04u-%02u-%02u", date.wYear, date.wMonth, date.wDay);
  return key;
}

std::uint64_t ReadDailyTotal(const std::wstring& key) {
  const std::wstring path = DataPath();
  if (path.empty()) return 0;
  wchar_t value[64] = {};
  GetPrivateProfileStringW(L"daily", key.c_str(), L"0", value,
                           static_cast<DWORD>(std::size(value)), path.c_str());
  wchar_t* end = nullptr;
  const unsigned long long result = _wcstoui64(value, &end, 10);
  return end == value ? 0 : static_cast<std::uint64_t>(result);
}

bool EnsureCurrentDay() {
  SYSTEMTIME now = {};
  GetLocalTime(&now);
  const std::wstring today = DateKey(now);
  if (today == gState.currentDay) return false;
  gState.currentDay = today;
  gState.todayTotal = ReadDailyTotal(today);
  return true;
}

int DaysInMonth(int year, int month) {
  static constexpr int days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (month == 2 && (year % 400 == 0 || (year % 4 == 0 && year % 100 != 0))) return 29;
  return days[month - 1];
}

int MondayOffset(int year, int month) {
  SYSTEMTIME input = {};
  input.wYear = static_cast<WORD>(year); input.wMonth = static_cast<WORD>(month); input.wDay = 1;
  FILETIME file = {};
  SYSTEMTIME normalized = {};
  SystemTimeToFileTime(&input, &file);
  FileTimeToSystemTime(&file, &normalized);
  return (normalized.wDayOfWeek + 6) % 7;
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
  if (!gState.currentDay.empty()) {
    WritePrivateProfileStringW(
        L"daily", gState.currentDay.c_str(),
        std::to_wstring(gState.todayTotal).c_str(), path.c_str());
  }
  WritePrivateProfileStringW(L"state", L"x", x, path.c_str());
  WritePrivateProfileStringW(L"state", L"y", y, path.c_str());
  WritePrivateProfileStringW(
      L"state", L"selected_scene",
      std::to_wstring(static_cast<int>(gState.selectedScene)).c_str(),
      path.c_str());
  const std::wstring selectedPack(
      gState.selectedPackId.begin(), gState.selectedPackId.end());
  WritePrivateProfileStringW(
      L"state", L"selected_pack_id", selectedPack.c_str(), path.c_str());
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

bool LoadAllPngResources() {
  return LoadPngResource(kFishResource, gFish) &&
         LoadPngResource(kMalletResource, gMallet) &&
         LoadPngResource(kLuckyCatBaseResource, gLuckyCatBase) &&
         LoadPngResource(kLuckyCatActorResource, gLuckyCatActor) &&
         LoadPngResource(kChickBaseResource, gChickBase) &&
         LoadPngResource(kChickActorResource, gChickActor) &&
         LoadPngResource(kHamsterHabitatResource, gHamsterHabitat) &&
         LoadPngResource(kHamsterActorResource, gHamsterActor);
}

void ReleasePngResource(PngResource& resource) {
  resource.image.reset();
  if (resource.stream != nullptr) {
    resource.stream->Release();
    resource.stream = nullptr;
  }
}

void ReleaseAllPngResources() {
  ReleasePngResource(gHamsterActor);
  ReleasePngResource(gHamsterHabitat);
  ReleasePngResource(gChickActor);
  ReleasePngResource(gChickBase);
  ReleasePngResource(gLuckyCatActor);
  ReleasePngResource(gLuckyCatBase);
  ReleasePngResource(gMallet);
  ReleasePngResource(gFish);
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

void DrawSceneArtwork(
    Gdiplus::Graphics& graphics, MeritScene scene, float strikeAmount) {
  using Gdiplus::GraphicsState;
  using Gdiplus::RectF;

  if (scene == MeritScene::LuckyCat) {
    graphics.DrawImage(gLuckyCatBase.image.get(), RectF(5.0f, 20.0f, 230.0f, 230.0f));
    const GraphicsState state = graphics.Save();
    constexpr float shoulderX = 30.0f + 230.0f * 362.0f / 600.0f;
    constexpr float shoulderY = 20.0f + 230.0f * 488.0f / 600.0f;
    graphics.TranslateTransform(shoulderX, shoulderY);
    graphics.ScaleTransform(1.0f, 1.0f - 0.20f * strikeAmount);
    graphics.TranslateTransform(-shoulderX, -shoulderY);
    graphics.DrawImage(gLuckyCatActor.image.get(), RectF(30.0f, 20.0f, 230.0f, 230.0f));
    graphics.Restore(state);
    return;
  }

  if (scene == MeritScene::ChickPecking) {
    const RectF rect(5.0f, 18.0f, 230.0f, 230.0f);
    graphics.DrawImage(gChickBase.image.get(), rect);
    const GraphicsState state = graphics.Save();
    graphics.TranslateTransform(4.0f * strikeAmount, 8.0f * strikeAmount);
    graphics.DrawImage(gChickActor.image.get(), rect);
    graphics.Restore(state);
    return;
  }

  if (scene == MeritScene::HamsterWheel) {
    graphics.DrawImage(
        gHamsterHabitat.image.get(), RectF(27.0f, 58.0f, 186.0f, 186.0f));
    const GraphicsState state = graphics.Save();
    constexpr float footX = 137.0f;
    constexpr float footY = 213.0f;
    graphics.TranslateTransform(footX, footY - 3.0f * strikeAmount);
    graphics.ScaleTransform(
        1.0f + 0.012f * strikeAmount, 1.0f - 0.025f * strikeAmount);
    graphics.TranslateTransform(-footX, -footY);
    graphics.DrawImage(
        gHamsterActor.image.get(), RectF(33.0f, 60.0f, 168.0f, 168.0f));
    graphics.Restore(state);
    return;
  }

  Gdiplus::SolidBrush shadow(Gdiplus::Color(62, 0, 0, 0));
  graphics.FillEllipse(&shadow, 34.0f, 227.0f, 172.0f, 18.0f);
  graphics.DrawImage(
      gFish.image.get(), RectF(18.0f, 102.0f, 232.0f, 140.0f));
  const GraphicsState state = graphics.Save();
  graphics.TranslateTransform(280.0f, 90.0f);
  graphics.RotateTransform(6.0f - 10.5f * strikeAmount);
  graphics.TranslateTransform(-280.0f, -90.0f);
  graphics.DrawImage(
      gMallet.image.get(), RectF(72.0f, 63.0f, 214.0f, 54.0f));
  graphics.Restore(state);
}

void DrawScene(Gdiplus::Graphics& graphics, ULONGLONG now) {
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);

  float progress = 0.0f;
  if (gState.striking) {
    const float elapsed =
        static_cast<float>(now - gState.strikeStarted);
    progress =
        std::clamp(elapsed / static_cast<float>(gState.strikeDurationMs),
                   0.0f, 1.0f);
  }

  float strikeAmount = 0.0f;
  if (gState.striking) {
    if (progress < kContactPhase) {
      strikeAmount = SmoothStep(progress / kContactPhase);
    } else {
      strikeAmount = 1.0f - SmoothStep((progress - kContactPhase) /
                                       (1.0f - kContactPhase));
    }
  }
  niuma::AppearancePack* appearancePack = CurrentAppearancePack();
  if (appearancePack != nullptr) {
    niuma::DrawAppearancePack(graphics, *appearancePack, progress);
  } else {
    DrawSceneArtwork(graphics, gState.selectedScene, strikeAmount);
  }

  // Draw the middle band last so the mallet can never cover it.
  if (gState.striking && progress >= kPlusStartPhase &&
      progress <= kPlusEndPhase) {
    DrawCenteredText(
        graphics, L"+1",
        Gdiplus::RectF(
            0.0f,
            appearancePack != nullptr
                ? 250.0f - static_cast<float>(appearancePack->plusY) - 30.0f
                : (gState.selectedScene == MeritScene::Woodfish ? 66.0f : 43.0f),
            240.0f, 30.0f),
        22.0f, 255);
  }

  const std::wstring totalText = std::to_wstring(gState.todayTotal);
  float totalFont = totalText.size() > 24 ? 20.0f :
                    totalText.size() > 18 ? 24.0f : 30.0f;
  DrawCenteredText(graphics, totalText,
                   Gdiplus::RectF(0.0f, 0.0f, 240.0f, 40.0f), totalFont, 255,
                   L"Consolas");
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
  if (EnsureCurrentDay()) {
    RenderLayeredWindow(GetTickCount64());
  }
  if (gState.total == std::numeric_limits<std::uint64_t>::max()) {
    return;
  }
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
  if (gState.todayTotal < std::numeric_limits<std::uint64_t>::max()) {
    ++gState.todayTotal;
  }
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
  if (gCalendar.window != nullptr) InvalidateRect(gCalendar.window, nullptr, FALSE);
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
      UiText(
          L"牛马电子功德只统计按键、鼠标按键和滚轮手势发生的次数。\n\n"
          L"程序不会读取、保存或上传按键内容、鼠标位置、当前应用、"
          L"剪贴板或屏幕内容；程序不包含联网功能。",
          L"NiuMa Merit counts only keyboard presses, mouse button presses, "
          L"and scroll gestures.\n\nIt does not read, save, or upload key content, "
          L"mouse positions, the current app, clipboard data, or screen content. "
          L"The app has no network features."),
      UiText(L"隐私说明", L"Privacy"), MB_OK | MB_ICONINFORMATION);
}

void ShowAboutDialog(HWND owner) {
  const std::wstring version = L"0.6.0";
  std::wstring text = IsChineseUi()
      ? L"牛马电子功德 v" + version + L"\n\n"
        L"只统计按键、鼠标按键和滚轮手势发生的次数，不读取具体内容、"
        L"鼠标位置或窗口信息。\n所有数据仅保存在本机，本软件不包含网络请求、"
        L"遥测或自动更新。\n\n客户端源代码依 GPLv3 许可证开放。\n\n项目主页：\n"
      : L"NiuMa Merit v" + version + L"\n\n"
        L"Counts keyboard presses, mouse button presses, and scroll gestures without "
        L"reading specific content, mouse positions, or window information.\n"
        L"All data stays on this computer. The app contains no network requests, "
        L"telemetry, or automatic updates.\n\nClient source code is available under GPLv3."
        L"\n\nProject page:\n";
  text += L"https://github.com/Mr-shanqiu/niuma-ELEC-gongde";
  MessageBoxW(owner, text.c_str(), UiText(L"关于牛马电子功德", L"About NiuMa Merit"),
              MB_OK | MB_ICONINFORMATION);
}

const wchar_t* SceneTitle(MeritScene scene) {
  switch (scene) {
    case MeritScene::LuckyCat: return UiText(L"招财猫", L"Lucky Cat");
    case MeritScene::ChickPecking: return UiText(L"小鸡啄米", L"Pecking Chick");
    case MeritScene::HamsterWheel: return UiText(L"仓鼠跑轮", L"Hamster Wheel");
    default: return UiText(L"默认木鱼", L"Woodfish");
  }
}

void DrawCalendarText(Gdiplus::Graphics& graphics, const std::wstring& text,
                      const Gdiplus::RectF& rect, float size,
                      const Gdiplus::Color& color, bool bold = false) {
  Gdiplus::Font font(L"Microsoft YaHei UI", size,
      bold ? Gdiplus::FontStyleBold : Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::StringFormat format;
  format.SetAlignment(Gdiplus::StringAlignmentCenter);
  format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  format.SetTrimming(Gdiplus::StringTrimmingNone);
  Gdiplus::SolidBrush brush(color);
  graphics.DrawString(text.c_str(), -1, &font, rect, &format, &brush);
}

void PaintMeritCalendar(HWND window) {
  PAINTSTRUCT paint = {};
  HDC dc = BeginPaint(window, &paint);
  Gdiplus::Graphics graphics(dc);
  const float scale = static_cast<float>(gState.dpi) / 96.0f;
  graphics.ScaleTransform(scale, scale);
  graphics.Clear(Gdiplus::Color(255, 248, 240, 225));
  const Gdiplus::Color ink(255, 61, 46, 31);
  const Gdiplus::Color muted(255, 126, 107, 87);
  const Gdiplus::Color accent(255, 199, 99, 31);

  wchar_t monthTitle[32] = {};
  if (IsChineseUi()) swprintf_s(monthTitle, L"%d 年 %d 月", gCalendar.year, gCalendar.month);
  else swprintf_s(monthTitle, L"%d / %02d", gCalendar.year, gCalendar.month);
  DrawCalendarText(graphics, monthTitle, Gdiplus::RectF(90, 18, 380, 34), 22, ink, true);
  DrawCalendarText(graphics, L"<", Gdiplus::RectF(22, 18, 48, 34), 20, ink, true);
  DrawCalendarText(graphics, L">", Gdiplus::RectF(490, 18, 48, 34), 20, ink, true);

  std::uint64_t monthTotal = 0;
  for (int day = 1; day <= DaysInMonth(gCalendar.year, gCalendar.month); ++day) {
    wchar_t key[16] = {};
    swprintf_s(key, L"%04d-%02d-%02d", gCalendar.year, gCalendar.month, day);
    monthTotal += key == gState.currentDay ? gState.todayTotal : ReadDailyTotal(key);
  }
  DrawCalendarText(graphics,
      std::wstring(UiText(L"累计功德  ", L"Total Merit  ")) + std::to_wstring(gState.total),
      Gdiplus::RectF(20, 62, 250, 30), 17, accent, true);
  DrawCalendarText(graphics,
      std::wstring(UiText(L"本月功德  ", L"This Month  ")) + std::to_wstring(monthTotal),
      Gdiplus::RectF(290, 62, 250, 30), 17, accent, true);

  const wchar_t* zhWeekdays[] = {L"一", L"二", L"三", L"四", L"五", L"六", L"日"};
  const wchar_t* enWeekdays[] = {L"MON", L"TUE", L"WED", L"THU", L"FRI", L"SAT", L"SUN"};
  const float left = 14, top = 112, cellWidth = 76, cellHeight = 51;
  for (int column = 0; column < 7; ++column) {
    DrawCalendarText(graphics, IsChineseUi() ? zhWeekdays[column] : enWeekdays[column],
        Gdiplus::RectF(left + column * cellWidth, 94, cellWidth, 20), 11, muted, true);
  }
  SYSTEMTIME today = {};
  GetLocalTime(&today);
  const int offset = MondayOffset(gCalendar.year, gCalendar.month);
  for (int day = 1; day <= DaysInMonth(gCalendar.year, gCalendar.month); ++day) {
    const int slot = offset + day - 1, row = slot / 7, column = slot % 7;
    const Gdiplus::RectF cell(left + column * cellWidth, top + row * cellHeight,
                              cellWidth - 2, cellHeight - 3);
    if (today.wYear == gCalendar.year && today.wMonth == gCalendar.month && today.wDay == day) {
      Gdiplus::SolidBrush highlight(Gdiplus::Color(96, 242, 196, 125));
      graphics.FillRectangle(&highlight, cell);
    }
    wchar_t key[16] = {};
    swprintf_s(key, L"%04d-%02d-%02d", gCalendar.year, gCalendar.month, day);
    const std::uint64_t value =
        key == gState.currentDay ? gState.todayTotal : ReadDailyTotal(key);
    std::wstring text = std::to_wstring(value) +
        (IsChineseUi() ? L"（" : L" (") +
        (day < 10 ? L"0" : L"") + std::to_wstring(day) +
        (IsChineseUi() ? L"）" : L")");
    const float fontSize = text.size() > 12 ? 10.0f : (text.size() > 8 ? 11.0f : 15.0f);
    DrawCalendarText(graphics, text, cell, fontSize, ink, true);
  }
  EndPaint(window, &paint);
}

LRESULT CALLBACK CalendarWindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  (void)wParam;
  switch (message) {
    case WM_PAINT: PaintMeritCalendar(window); return 0;
    case WM_LBUTTONUP: {
      const int x = MulDiv(GET_X_LPARAM(lParam), 96, static_cast<int>(gState.dpi));
      const int y = MulDiv(GET_Y_LPARAM(lParam), 96, static_cast<int>(gState.dpi));
      if (y >= 12 && y <= 60 && (x <= 82 || x >= 478)) {
        gCalendar.month += x <= 82 ? -1 : 1;
        if (gCalendar.month == 0) { gCalendar.month = 12; --gCalendar.year; }
        if (gCalendar.month == 13) { gCalendar.month = 1; ++gCalendar.year; }
        InvalidateRect(window, nullptr, FALSE);
      }
      return 0;
    }
    case WM_CLOSE: DestroyWindow(window); return 0;
    case WM_DESTROY: gCalendar.window = nullptr; return 0;
    default: return DefWindowProcW(window, message, wParam, lParam);
  }
}

void ShowMeritCalendar(HWND owner) {
  if (gCalendar.window == nullptr) {
    SYSTEMTIME now = {};
    GetLocalTime(&now);
    gCalendar.year = now.wYear; gCalendar.month = now.wMonth;
    RECT desired = {0, 0, ScaleDip(560, gState.dpi), ScaleDip(430, gState.dpi)};
    AdjustWindowRectEx(&desired, WS_CAPTION | WS_SYSMENU, FALSE, WS_EX_TOOLWINDOW);
    gCalendar.window = CreateWindowExW(
        WS_EX_TOOLWINDOW, kCalendarClass, UiText(L"功德日历", L"Merit Calendar"),
        WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT,
        desired.right - desired.left, desired.bottom - desired.top,
        owner, nullptr, GetModuleHandleW(nullptr), nullptr);
  }
  if (gCalendar.window != nullptr) {
    ShowWindow(gCalendar.window, SW_SHOW);
    SetForegroundWindow(gCalendar.window);
    InvalidateRect(gCalendar.window, nullptr, FALSE);
  }
}

constexpr int kPickerDeleteButton = 1001;

int PickerItemCount() {
  return 4 + static_cast<int>(gAppearanceCatalog.packs().size());
}

int CurrentPickerIndex() {
  if (!gState.selectedPackId.empty()) {
    const auto& packs = gAppearanceCatalog.packs();
    for (size_t index = 0; index < packs.size(); ++index) {
      if (packs[index]->id == gState.selectedPackId)
        return 4 + static_cast<int>(index);
    }
  }
  return static_cast<int>(gState.selectedScene);
}

std::wstring PickerItemTitle(int index) {
  if (index < 4) return SceneTitle(static_cast<MeritScene>(index));
  const auto& pack = gAppearanceCatalog.packs()[static_cast<size_t>(index - 4)];
  return IsChineseUi() ? pack->nameZh : pack->nameEn;
}

RECT PickerCardRect(int index, UINT dpi) {
  const int left = ScaleDip(16 + (index % 2) * 172, dpi);
  const int top = ScaleDip(14 + (index / 2 - gPicker.scrollRow) * 142, dpi);
  return {left, top, left + ScaleDip(156, dpi), top + ScaleDip(130, dpi)};
}

void PaintAppearancePicker(HWND window) {
  PAINTSTRUCT paint = {};
  HDC dc = BeginPaint(window, &paint);
  RECT client = {};
  GetClientRect(window, &client);
  FillRect(dc, &client, reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1));
  Gdiplus::Graphics graphics(dc);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
  for (int index = 0; index < PickerItemCount(); ++index) {
    const RECT card = PickerCardRect(index, dpi);
    if (card.bottom <= 0 || card.top >= ScaleDip(442, dpi)) continue;
    const bool selected = index == gPicker.pendingIndex;
    Gdiplus::SolidBrush background(selected
        ? Gdiplus::Color(255, 255, 244, 226)
        : Gdiplus::Color(255, 250, 250, 250));
    Gdiplus::Pen border(selected
        ? Gdiplus::Color(255, 224, 119, 31)
        : Gdiplus::Color(255, 205, 205, 205),
        selected ? static_cast<float>(ScaleDip(3, dpi)) : 1.0f);
    const Gdiplus::RectF cardRect(
        static_cast<float>(card.left), static_cast<float>(card.top),
        static_cast<float>(card.right - card.left),
        static_cast<float>(card.bottom - card.top));
    graphics.FillRectangle(&background, cardRect);
    graphics.DrawRectangle(&border, cardRect);

    Gdiplus::Bitmap thumbnail(240, 250, PixelFormat32bppARGB);
    Gdiplus::Graphics thumbnailGraphics(&thumbnail);
    thumbnailGraphics.Clear(Gdiplus::Color(0, 0, 0, 0));
    thumbnailGraphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    thumbnailGraphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    if (index < 4) {
      DrawSceneArtwork(thumbnailGraphics, static_cast<MeritScene>(index), 0.0f);
    } else {
      niuma::DrawAppearancePack(
          thumbnailGraphics,
          *gAppearanceCatalog.packs()[static_cast<size_t>(index - 4)], 0.0f);
    }
    graphics.DrawImage(&thumbnail, Gdiplus::RectF(
        static_cast<float>(card.left + ScaleDip(20, dpi)),
        static_cast<float>(card.top + ScaleDip(3, dpi)),
        static_cast<float>(ScaleDip(116, dpi)),
        static_cast<float>(ScaleDip(96, dpi))));

    Gdiplus::Font font(L"Microsoft YaHei UI", static_cast<float>(ScaleDip(14, dpi)),
                       Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::StringFormat format;
    format.SetAlignment(Gdiplus::StringAlignmentCenter);
    format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::SolidBrush text(Gdiplus::Color(255, 62, 52, 43));
    const std::wstring title = PickerItemTitle(index);
    graphics.DrawString(title.c_str(), -1, &font,
        Gdiplus::RectF(static_cast<float>(card.left),
            static_cast<float>(card.top + ScaleDip(100, dpi)),
            static_cast<float>(card.right - card.left),
            static_cast<float>(ScaleDip(25, dpi))), &format, &text);
  }
  EndPaint(window, &paint);
}

LRESULT CALLBACK PickerWindowProcedure(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_CREATE: {
      const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
      CreateWindowW(L"BUTTON", UiText(L"删除所选", L"Delete Selected"),
          WS_CHILD | WS_VISIBLE,
          ScaleDip(16, dpi), ScaleDip(456, dpi), ScaleDip(112, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPickerDeleteButton)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"确认", L"Confirm"), WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
          ScaleDip(188, dpi), ScaleDip(456, dpi), ScaleDip(72, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDOK)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"取消", L"Cancel"), WS_CHILD | WS_VISIBLE,
          ScaleDip(272, dpi), ScaleDip(456, dpi), ScaleDip(72, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDCANCEL)),
          GetModuleHandleW(nullptr), nullptr);
      return 0;
    }
    case WM_PAINT:
      PaintAppearancePicker(window);
      return 0;
    case WM_LBUTTONUP: {
      const POINT point = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
      const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
      for (int index = 0; index < PickerItemCount(); ++index) {
        const RECT card = PickerCardRect(index, dpi);
        if (PtInRect(&card, point)) {
          gPicker.pendingIndex = index;
          InvalidateRect(window, nullptr, FALSE);
          break;
        }
      }
      return 0;
    }
    case WM_MOUSEWHEEL: {
      const int maximumRow = std::max(0, (PickerItemCount() + 1) / 2 - 3);
      gPicker.scrollRow = std::clamp(
          gPicker.scrollRow + (GET_WHEEL_DELTA_WPARAM(wParam) < 0 ? 1 : -1),
          0, maximumRow);
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(wParam) == kPickerDeleteButton) {
        if (gPicker.pendingIndex < 4) {
          MessageBoxW(window,
              UiText(L"内置形象不能删除。", L"Built-in appearances cannot be deleted."),
              WindowTitle(), MB_OK | MB_ICONINFORMATION);
          return 0;
        }
        const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 4);
        if (packIndex >= gAppearanceCatalog.packs().size()) return 0;
        const std::string id = gAppearanceCatalog.packs()[packIndex]->id;
        if (MessageBoxW(window,
                UiText(L"删除所选的本地形象包？",
                       L"Delete the selected local appearance pack?"),
                WindowTitle(), MB_YESNO | MB_ICONQUESTION) != IDYES) return 0;
        std::wstring error;
        if (!gAppearanceCatalog.Delete(id, &error)) {
          MessageBoxW(window, error.c_str(), WindowTitle(), MB_OK | MB_ICONERROR);
          return 0;
        }
        if (gState.selectedPackId == id) {
          gState.selectedPackId.clear();
          gState.selectedScene = MeritScene::Woodfish;
          gState.dirty = true;
          SaveState();
          RenderLayeredWindow(GetTickCount64());
        }
        gPicker.pendingIndex = std::min(
            gPicker.pendingIndex, std::max(0, PickerItemCount() - 1));
        InvalidateRect(window, nullptr, FALSE);
        return 0;
      }
      if (LOWORD(wParam) == IDOK || LOWORD(wParam) == IDCANCEL) {
        gPicker.confirmed = LOWORD(wParam) == IDOK;
        DestroyWindow(window);
        return 0;
      }
      break;
    case WM_CLOSE:
      gPicker.confirmed = false;
      DestroyWindow(window);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

void ShowAppearancePicker(HWND owner) {
  gPicker.pendingIndex = CurrentPickerIndex();
  gPicker.scrollRow = std::max(0, gPicker.pendingIndex / 2 - 2);
  gPicker.confirmed = false;
  const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
  RECT desired = {0, 0, ScaleDip(360, dpi), ScaleDip(502, dpi)};
  AdjustWindowRectEx(&desired, WS_CAPTION | WS_SYSMENU, FALSE, WS_EX_TOOLWINDOW);
  const int width = desired.right - desired.left;
  const int height = desired.bottom - desired.top;
  RECT ownerRect = {};
  GetWindowRect(owner, &ownerRect);
  MONITORINFO monitorInfo = {sizeof(monitorInfo)};
  GetMonitorInfoW(MonitorFromWindow(owner, MONITOR_DEFAULTTONEAREST), &monitorInfo);
  const int proposedX = ownerRect.left + (gState.windowWidth - width) / 2;
  const int proposedY = ownerRect.top + (gState.windowHeight - height) / 2;
  const int pickerX = std::clamp(
      proposedX, static_cast<int>(monitorInfo.rcWork.left),
      static_cast<int>(monitorInfo.rcWork.right) - width);
  const int pickerY = std::clamp(
      proposedY, static_cast<int>(monitorInfo.rcWork.top),
      static_cast<int>(monitorInfo.rcWork.bottom) - height);
  gPicker.window = CreateWindowExW(
      WS_EX_TOOLWINDOW, kPickerClass, UiText(L"更换形象", L"Change Appearance"), WS_CAPTION | WS_SYSMENU,
      pickerX, pickerY,
      width, height, owner, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (gPicker.window == nullptr) return;
  EnableWindow(owner, FALSE);
  ShowWindow(gPicker.window, SW_SHOW);
  MSG message = {};
  while (IsWindow(gPicker.window)) {
    const BOOL result = GetMessageW(&message, nullptr, 0, 0);
    if (result <= 0) {
      if (result == 0) PostQuitMessage(static_cast<int>(message.wParam));
      break;
    }
    if (!IsDialogMessageW(gPicker.window, &message)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  EnableWindow(owner, TRUE);
  SetActiveWindow(owner);
  gPicker.window = nullptr;
  if (gPicker.confirmed) {
    if (gPicker.pendingIndex < 4) {
      gState.selectedScene = static_cast<MeritScene>(gPicker.pendingIndex);
      gState.selectedPackId.clear();
    } else {
      const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 4);
      if (packIndex >= gAppearanceCatalog.packs().size()) return;
      gState.selectedPackId = gAppearanceCatalog.packs()[packIndex]->id;
    }
    gState.dirty = true;
    gState.striking = true;
    gState.strikeStarted = GetTickCount64();
    gState.strikeDurationMs = 800;
    SaveState();
    EnsureAnimationTimer();
    RenderLayeredWindow(gState.strikeStarted);
  }
}

std::wstring AppearancePackArgument() {
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments == nullptr) return {};
  std::wstring result;
  for (int index = 1; index < argumentCount; ++index) {
    const std::wstring argument(arguments[index]);
    if (niuma::IsAppearancePackPath(argument)) {
      result = argument;
      break;
    }
  }
  LocalFree(arguments);
  return result;
}

void ImportAppearancePack(HWND owner, const std::wstring& sourcePath,
                          bool showSuccess) {
  std::wstring error;
  std::string installedId;
  if (!gAppearanceCatalog.Install(
          sourcePath, AppearanceDirectory(), &installedId, &error)) {
    MessageBoxW(owner, error.c_str(),
                UiText(L"形象包导入失败", L"Appearance Pack Import Failed"),
                MB_OK | MB_ICONERROR);
    return;
  }
  if (gAppearanceCatalog.Find(installedId) == nullptr) {
    MessageBoxW(owner,
        UiText(L"形象包导入后无法重新读取。",
               L"The imported appearance pack could not be reloaded."),
        UiText(L"形象包导入失败", L"Appearance Pack Import Failed"),
        MB_OK | MB_ICONERROR);
    return;
  }
  gState.selectedPackId = installedId;
  gState.dirty = true;
  SaveState();
  RenderLayeredWindow(GetTickCount64());
  if (showSuccess) {
    MessageBoxW(owner,
        UiText(L"形象包已安全导入并启用。",
               L"The appearance pack was safely imported and enabled."),
        WindowTitle(), MB_OK | MB_ICONINFORMATION);
  }
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
  AppendMenuW(menu, MF_STRING, kMenuAbout,
              UiText(L"关于牛马电子功德", L"About NiuMa Merit"));
  AppendMenuW(
      menu,
      MF_STRING | (IsLaunchAtLoginEnabled() ? MF_CHECKED : MF_UNCHECKED),
      kMenuLaunchAtLogin, UiText(L"登录后自动启动", L"Start at Login"));
  AppendMenuW(menu, MF_STRING, kMenuAppearance,
              UiText(L"更换形象", L"Change Appearance"));
  AppendMenuW(menu, MF_STRING, kMenuCalendar,
              UiText(L"功德日历…", L"Merit Calendar…"));
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kMenuQuit, UiText(L"退出", L"Exit"));

  const int command = TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
      screenPoint.x, screenPoint.y, 0, window, nullptr);
  DestroyMenu(menu);

  if (command == static_cast<int>(kMenuAbout)) {
    ShowAboutDialog(window);
  } else if (command == static_cast<int>(kMenuLaunchAtLogin)) {
    const bool enabled = !IsLaunchAtLoginEnabled();
    if (SetLaunchAtLoginEnabled(enabled)) {
      SaveLaunchAtLoginPreference(enabled);
    } else {
      MessageBoxW(window,
                  UiText(L"无法修改登录启动项，请稍后重试。",
                         L"Unable to change login startup. Please try again."),
                  WindowTitle(), MB_OK | MB_ICONERROR);
    }
  } else if (command == static_cast<int>(kMenuAppearance)) {
    ShowAppearancePicker(window);
  } else if (command == static_cast<int>(kMenuCalendar)) {
    ShowMeritCalendar(window);
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

    case WM_COPYDATA: {
      const auto* copy = reinterpret_cast<const COPYDATASTRUCT*>(lParam);
      if (copy == nullptr || copy->dwData != kAppearancePackCopyData ||
          copy->lpData == nullptr || copy->cbData < sizeof(wchar_t) ||
          copy->cbData % sizeof(wchar_t) != 0) return FALSE;
      const auto* path = static_cast<const wchar_t*>(copy->lpData);
      const size_t characters = copy->cbData / sizeof(wchar_t);
      if (path[characters - 1] != L'\0') return FALSE;
      const std::wstring sourcePath(path);
      if (!niuma::IsAppearancePackPath(sourcePath)) return FALSE;
      ImportAppearancePack(window, sourcePath, true);
      return TRUE;
    }

    case WM_TIMER: {
      if (wParam == kDayTimer) {
        if (EnsureCurrentDay()) RenderLayeredWindow(GetTickCount64());
        if (gCalendar.window != nullptr) InvalidateRect(gCalendar.window, nullptr, FALSE);
        return 0;
      }
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
        point = {(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2};
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
      KillTimer(window, kDayTimer);
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

  const std::wstring pendingAppearancePack = AppearancePackArgument();

  gState.mutex = CreateMutexW(nullptr, TRUE, kMutexName);
  if (gState.mutex == nullptr) {
    return 1;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (!pendingAppearancePack.empty()) {
      HWND existingWindow = nullptr;
      for (int attempt = 0; attempt < 20 && existingWindow == nullptr; ++attempt) {
        existingWindow = FindWindowW(kWindowClass, nullptr);
        if (existingWindow == nullptr) Sleep(50);
      }
      if (existingWindow != nullptr) {
        COPYDATASTRUCT copy = {};
        copy.dwData = kAppearancePackCopyData;
        copy.cbData = static_cast<DWORD>(
            (pendingAppearancePack.size() + 1) * sizeof(wchar_t));
        copy.lpData = const_cast<wchar_t*>(pendingAppearancePack.c_str());
        SendMessageTimeoutW(existingWindow, WM_COPYDATA, 0,
                            reinterpret_cast<LPARAM>(&copy),
                            SMTO_ABORTIFHUNG, 5000, nullptr);
      }
    }
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

  if (!LoadAllPngResources()) {
    MessageBoxW(
        nullptr, UiText(L"形象资源加载失败。",
                        L"Appearance resources could not be loaded."), WindowTitle(),
        MB_OK | MB_ICONERROR);
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  std::wstring catalogError;
  if (!gAppearanceCatalog.Reload(AppearanceDirectory(), &catalogError)) {
    MessageBoxW(nullptr, catalogError.c_str(), WindowTitle(), MB_OK | MB_ICONERROR);
  }

  WNDCLASSEXW windowClass = {};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.lpfnWndProc = WindowProcedure;
  windowClass.hInstance = instance;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_HAND);
  windowClass.lpszClassName = kWindowClass;
  if (RegisterClassExW(&windowClass) == 0) {
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) {
      CoUninitialize();
    }
    return 1;
  }

  WNDCLASSEXW pickerClass = {};
  pickerClass.cbSize = sizeof(pickerClass);
  pickerClass.lpfnWndProc = PickerWindowProcedure;
  pickerClass.hInstance = instance;
  pickerClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  pickerClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  pickerClass.lpszClassName = kPickerClass;
  if (RegisterClassExW(&pickerClass) == 0) {
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) CoUninitialize();
    return 1;
  }

  WNDCLASSEXW calendarClass = {};
  calendarClass.cbSize = sizeof(calendarClass);
  calendarClass.lpfnWndProc = CalendarWindowProcedure;
  calendarClass.hInstance = instance;
  calendarClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  calendarClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  calendarClass.lpszClassName = kCalendarClass;
  if (RegisterClassExW(&calendarClass) == 0) {
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) CoUninitialize();
    return 1;
  }

  gState.dpi = SystemDpi();
  gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
  gState.windowHeight = ScaleDip(kWindowDipHeight, gState.dpi);
  gState.total = ReadIniTotal();
  EnsureCurrentDay();
  const long selectedScene = ReadIniLong(L"selected_scene", 0);
  gState.selectedScene = selectedScene >= 0 && selectedScene <= 3
      ? static_cast<MeritScene>(selectedScene)
      : MeritScene::Woodfish;
  gState.selectedPackId = ReadSelectedPackId();
  if (gAppearanceCatalog.Find(gState.selectedPackId) == nullptr) {
    gState.selectedPackId.clear();
  }

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
      kWindowClass, WindowTitle(), WS_POPUP,
      static_cast<int>(x), static_cast<int>(y),
      gState.windowWidth, gState.windowHeight,
      nullptr, nullptr, instance, nullptr);
  if (window == nullptr) {
    ReleaseAllPngResources();
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
  SetTimer(window, kDayTimer, 30000, nullptr);

  wchar_t executable[MAX_PATH] = {};
  if (GetModuleFileNameW(nullptr, executable,
                         static_cast<DWORD>(std::size(executable))) != 0) {
    std::wstring associationError;
    niuma::RegisterAppearancePackAssociation(executable, &associationError);
  }

  ConfigureLaunchAtLogin();
  if (!StartedAutomatically()) {
    ShowPrivacyNoticeIfNeeded(window);
  }
  if (!pendingAppearancePack.empty()) {
    ImportAppearancePack(window, pendingAppearancePack, true);
  }

  gState.keyboardHook =
      SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHook, instance, 0);
  gState.mouseHook =
      SetWindowsHookExW(WH_MOUSE_LL, MouseHook, instance, 0);
  if (gState.keyboardHook == nullptr || gState.mouseHook == nullptr) {
    MessageBoxW(
        window, UiText(L"无法启动全局键盘或鼠标计数。",
                       L"Unable to start global keyboard or mouse counting."), WindowTitle(),
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

  ReleaseAllPngResources();

  Gdiplus::GdiplusShutdown(gState.gdiplusToken);
  ReleaseMutex(gState.mutex);
  CloseHandle(gState.mutex);
  if (SUCCEEDED(comResult)) {
    CoUninitialize();
  }
  return static_cast<int>(message.wParam);
}
