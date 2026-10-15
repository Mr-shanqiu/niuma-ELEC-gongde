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
#include <bcrypt.h>

#include "appearance_pack.h"
#include "app_version.h"
#include "../offwork_clock.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cwchar>
#include <ctime>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <vector>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "bcrypt.lib")

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
constexpr UINT_PTR kOffworkTimer = 3;
constexpr UINT kOffworkSessionChange = 0x02B1;  // WM_WTSSESSION_CHANGE
constexpr int kFishResource = 101;
constexpr int kMalletResource = 102;
constexpr int kLuckyCatBaseResource = 104;
constexpr int kLuckyCatActorResource = 105;
constexpr int kSeaLionBodyResource = 106;
constexpr int kSeaLionFlipperResource = 107;
constexpr int kHamsterHabitatResource = 108;
constexpr int kHamsterActorResource = 109;
constexpr int kDesignWidth = 240;
constexpr int kDesignHeight = 250;
constexpr int kWindowDipWidth = 120;
constexpr int kWindowDipHeight = 125;
constexpr int kOffworkDipHeight = 44;
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
constexpr UINT_PTR kMenuCountStatus = 6;
constexpr UINT_PTR kMenuGuide = 7;
constexpr UINT_PTR kMenuOffwork = 8;
constexpr wchar_t kCountStatusClass[] = L"NiuMaMeritCountStatus";
constexpr int kStatusText = 4001;
constexpr int kStatusStart = 4002;
constexpr int kStatusRetry = 4003;
constexpr int kStatusClose = 4004;

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
  SeaLionBellyPat = 2,
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

// Ephemeral event counts and monotonic relative times only. Never inspect
// hook payloads or foreground windows.
struct CountingCheck {
  HWND window = nullptr;
  bool observedCount = false;
  bool deliveryFault = false;
  DWORD keyboardError = ERROR_SUCCESS;
  DWORD mouseError = ERROR_SUCCESS;
  bool active = false;
  bool counting = false;
  unsigned int generation = 0;
  unsigned int listenerGeneration = 0;
  ULONGLONG starts = 0;
  ULONGLONG ends = 0;
  ULONGLONG lastRelative = 0;
  std::uint64_t keys = 0;
  std::uint64_t clicks = 0;
  std::uint64_t scrolls = 0;
  std::uint64_t handled = 0;
  std::uint64_t expected = 0;
  std::uint64_t counted = 0;
  std::wstring result;
};

CountingCheck gCountingCheck;
std::vector<std::string> gNewlyImportedIds;
std::vector<std::string> gLastImportedIds;
PngResource gFish;
PngResource gMallet;
PngResource gLuckyCatBase;
PngResource gLuckyCatActor;
PngResource gSeaLionBody;
PngResource gSeaLionFlipper;
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

// Separate from merit counts and their save/animation timer. A missing record
// means "not recorded", never a claim that the user left work on time.
struct OffworkDayRecord {
  bool present = false;
  bool dirty = false;
  int seconds = 0;
  int targetMinutes = 18 * 60;
  std::time_t updatedAt = 0;
};

struct OffworkState {
  bool enabled = false;
  int hour = 18;
  int minute = 0;
  bool settingsDirty = false;
  bool timerRunning = false;
  bool suspended = false;
  bool baselineValid = false;
  bool awakeClockValid = false;
  ULONGLONG lastTick = 0;
  ULONGLONG lastAwake = 0;
  ULONGLONG lastFlush = 0;
  LONG zoneBias = 0;
  niuma::OffworkSnapshot snapshot;
  std::map<std::wstring, OffworkDayRecord> days;
  HMODULE sessionLibrary = nullptr;
  HWND dialog = nullptr;
};

OffworkState gOffwork;

int MainWindowDipHeight() {
  return kWindowDipHeight + (gOffwork.enabled ? kOffworkDipHeight : 0);
}

std::wstring OffworkWide(const std::string& value) {
  return std::wstring(value.begin(), value.end());
}

std::wstring OffworkTimeText(int seconds) {
  return OffworkWide(niuma::OffworkDuration(seconds));
}

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
  if (gState.selectedPackId.empty() && gState.selectedScene != MeritScene::Woodfish) {
    gState.selectedScene = MeritScene::Woodfish;
    gState.dirty = true;
  }
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

void LoadOffworkSettings() {
  const std::wstring path = DataPath();
  if (!path.empty()) {
    gOffwork.enabled = GetPrivateProfileIntW(L"offwork", L"enabled", 0, path.c_str()) == 1;
    const int hour = static_cast<int>(GetPrivateProfileIntW(L"offwork", L"hour", 18, path.c_str()));
    const int minute = static_cast<int>(GetPrivateProfileIntW(L"offwork", L"minute", 0, path.c_str()));
    gOffwork.hour = hour >= 0 && hour < 24 ? hour : 18;
    gOffwork.minute = minute >= 0 && minute < 60 ? minute : 0;
  }
  gOffwork.lastFlush = GetTickCount64();
}

OffworkDayRecord& OffworkDay(const std::wstring& key) {
  const auto found = gOffwork.days.find(key);
  if (found != gOffwork.days.end()) return found->second;
  OffworkDayRecord record;
  const std::wstring path = DataPath();
  if (!path.empty()) {
    wchar_t value[128] = {};
    GetPrivateProfileStringW(L"offwork_daily", key.c_str(), L"", value,
        static_cast<DWORD>(std::size(value)), path.c_str());
    long long updated = 0;
    if (swscanf_s(value, L"%d,%d,%lld", &record.seconds,
                  &record.targetMinutes, &updated) == 3 &&
        record.seconds > 0 && record.seconds <= 172800 &&
        record.targetMinutes >= 0 && record.targetMinutes < 1440 && updated > 0) {
      record.present = true;
      record.updatedAt = static_cast<std::time_t>(updated);
    }
  }
  return gOffwork.days.emplace(key, record).first->second;
}

void UpdateOffworkDay(const niuma::OffworkSnapshot& snapshot, int seconds,
                      std::time_t updatedAt) {
  auto& record = OffworkDay(OffworkWide(snapshot.dayKey));
  const bool present = seconds > 0;
  if (record.present == present && (!present ||
      (record.seconds == seconds && record.targetMinutes == snapshot.targetMinutes &&
       record.updatedAt == updatedAt))) return;
  record.present = present;
  record.seconds = seconds;
  record.targetMinutes = snapshot.targetMinutes;
  record.updatedAt = updatedAt;
  record.dirty = true;
}

bool FlushOffwork() {
  const std::wstring path = DataPath();
  if (path.empty()) return false;
  bool success = true;
  bool wrote = false;
  if (gOffwork.settingsDirty) {
    const bool enabledSaved = WritePrivateProfileStringW(L"offwork", L"enabled",
        gOffwork.enabled ? L"1" : L"0", path.c_str()) != FALSE;
    const bool hourSaved = WritePrivateProfileStringW(L"offwork", L"hour",
        std::to_wstring(gOffwork.hour).c_str(), path.c_str()) != FALSE;
    const bool minuteSaved = WritePrivateProfileStringW(L"offwork", L"minute",
        std::to_wstring(gOffwork.minute).c_str(), path.c_str()) != FALSE;
    success = enabledSaved && hourSaved && minuteSaved;
    gOffwork.settingsDirty = !success;
    wrote = true;
  }
  for (auto& entry : gOffwork.days) {
    auto& record = entry.second;
    if (!record.dirty) continue;
    // Version-one daily value: elapsed seconds, target minute, actual sample time.
    const std::wstring value = std::to_wstring(record.seconds) + L"," +
        std::to_wstring(record.targetMinutes) + L"," +
        std::to_wstring(static_cast<long long>(record.updatedAt));
    const bool saved = WritePrivateProfileStringW(L"offwork_daily", entry.first.c_str(),
        record.present ? value.c_str() : nullptr, path.c_str()) != FALSE;
    record.dirty = !saved;
    success = saved && success;
    wrote = true;
  }
  if (wrote && !WritePrivateProfileStringW(nullptr, nullptr, nullptr, path.c_str())) {
    // Keep the snapshots retryable if flushing the profile cache failed.
    for (auto& entry : gOffwork.days) entry.second.dirty = true;
    gOffwork.settingsDirty = true;
    success = false;
  }
  // Failed storage is retried at the next interval or lifecycle event, not 1 Hz.
  gOffwork.lastFlush = GetTickCount64();
  return success;
}

bool OffworkAwakeTime(ULONGLONG& value) {
  using QueryFn = BOOL(WINAPI*)(PULONGLONG);
  static const auto query = reinterpret_cast<QueryFn>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "QueryUnbiasedInterruptTime"));
  return query && query(&value);
}

void RefreshOffwork(bool allowMidnight = true, bool flush = false) {
  if (!gOffwork.enabled || gOffwork.suspended) {
    if (flush) FlushOffwork();
    return;
  }
  // The display and record always share exactly one wall-clock sample.
  const auto snapshot = niuma::EvaluateOffwork(std::time(nullptr), gOffwork.hour, gOffwork.minute);
  const ULONGLONG tick = GetTickCount64();
  ULONGLONG awake = 0;
  const bool hasAwake = OffworkAwakeTime(awake);
  TIME_ZONE_INFORMATION zone = {};
  const DWORD zoneId = GetTimeZoneInformation(&zone);
  const LONG bias = zone.Bias + (zoneId == TIME_ZONE_ID_DAYLIGHT ? zone.DaylightBias : zone.StandardBias);
  if (!snapshot.valid) {
    gOffwork.snapshot = snapshot;
    gOffwork.baselineValid = false;
    if (flush) FlushOffwork();
    return;
  }
  const auto& previous = gOffwork.snapshot;
  const bool changedDay = previous.valid && previous.dayKey != snapshot.dayKey;
  if (changedDay) {
    const ULONGLONG elapsed = tick - gOffwork.lastTick;
    const double wallSeconds = std::difftime(snapshot.sampledAt, previous.sampledAt);
    const bool continuouslyAwake = hasAwake && gOffwork.awakeClockValid
        ? awake >= gOffwork.lastAwake &&
          std::fabs(static_cast<double>(awake - gOffwork.lastAwake) / 10000.0 -
                    static_cast<double>(elapsed)) < 1000.0
        : elapsed <= 5000;
    // No yesterday/missing-day synthesis after sleep, restart, timezone or clock
    // changes. Only an observed continuous transition gets the 23:59:59 value.
    if (allowMidnight && gOffwork.baselineValid && continuouslyAwake &&
        bias == gOffwork.zoneBias && wallSeconds >= 0 &&
        std::fabs(wallSeconds - static_cast<double>(elapsed) / 1000.0) < 2.0 &&
        snapshot.sampledAt >= previous.nextMidnightAt &&
        niuma::EvaluateOffwork(previous.nextMidnightAt, gOffwork.hour, gOffwork.minute).dayKey == snapshot.dayKey) {
      UpdateOffworkDay(previous, niuma::OffworkFinalDaySeconds(previous), previous.nextMidnightAt - 1);
    }
    FlushOffwork();
  }
  gOffwork.snapshot = snapshot;
  gOffwork.lastTick = tick;
  gOffwork.lastAwake = awake;
  gOffwork.awakeClockValid = hasAwake;
  gOffwork.zoneBias = bias;
  gOffwork.baselineValid = true;
  UpdateOffworkDay(snapshot, snapshot.overtimeSeconds, snapshot.sampledAt);
  if (flush || changedDay || tick - gOffwork.lastFlush >= 60000) FlushOffwork();
  if (gCalendar.window) InvalidateRect(gCalendar.window, nullptr, FALSE);
}

bool SyncOffworkTimer() {
  const bool run = gOffwork.enabled && !gOffwork.suspended;
  if (!run && gOffwork.timerRunning) {
    KillTimer(gState.window, kOffworkTimer);
    gOffwork.timerRunning = false;
  } else if (run && !gOffwork.timerRunning && gState.window) {
    gOffwork.timerRunning = SetTimer(gState.window, kOffworkTimer, 1000, nullptr) != 0;
  }
  return !run || gOffwork.timerRunning;
}

void RegisterOffworkSessionNotifications(HWND window) {
  gOffwork.sessionLibrary = LoadLibraryW(L"wtsapi32.dll");
  if (!gOffwork.sessionLibrary) return;
  using RegisterFn = BOOL(WINAPI*)(HWND, DWORD);
  const auto registerSession = reinterpret_cast<RegisterFn>(
      GetProcAddress(gOffwork.sessionLibrary, "WTSRegisterSessionNotification"));
  if (registerSession) registerSession(window, 0);  // This session only.
}

void UnregisterOffworkSessionNotifications(HWND window) {
  if (!gOffwork.sessionLibrary) return;
  using UnregisterFn = BOOL(WINAPI*)(HWND);
  const auto unregisterSession = reinterpret_cast<UnregisterFn>(
      GetProcAddress(gOffwork.sessionLibrary, "WTSUnRegisterSessionNotification"));
  if (unregisterSession) unregisterSession(window);
  FreeLibrary(gOffwork.sessionLibrary);
  gOffwork.sessionLibrary = nullptr;
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
         LoadPngResource(kMalletResource, gMallet);
}

void ReleasePngResource(PngResource& resource) {
  resource.image.reset();
  if (resource.stream != nullptr) {
    resource.stream->Release();
    resource.stream = nullptr;
  }
}

void ReleaseAllPngResources() {
  // The catalog also owns GDI+ images. Release it before GDI+ or COM stops,
  // including on the startup-failure paths that share this cleanup function.
  gAppearanceCatalog = niuma::AppearanceCatalog{};
  ReleasePngResource(gHamsterActor);
  ReleasePngResource(gHamsterHabitat);
  ReleasePngResource(gSeaLionFlipper);
  ReleasePngResource(gSeaLionBody);
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

  if (scene == MeritScene::SeaLionBellyPat) {
    graphics.DrawImage(gSeaLionBody.image.get(), RectF(34.0f, 82.0f, 172.0f, 168.0f));
    const GraphicsState state = graphics.Save();
    constexpr float anchorX = 159.65f;
    constexpr float anchorY = 146.6f;
    graphics.TranslateTransform(anchorX - 3.0f * strikeAmount,
                                anchorY + 2.0f * strikeAmount);
    graphics.RotateTransform(48.0f * strikeAmount);
    graphics.TranslateTransform(-anchorX, -anchorY);
    graphics.DrawImage(gSeaLionFlipper.image.get(), RectF(152.0f, 140.0f, 51.0f, 66.0f));
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
    if (gOffwork.enabled) {
      // Below the original 240x250 artwork, including imported packs and +1.
      Gdiplus::SolidBrush background(Gdiplus::Color(230, 255, 249, 238));
      graphics.FillRectangle(&background, Gdiplus::RectF(8, 254, 224, 80));
      const auto& snapshot = gOffwork.snapshot;
      Gdiplus::SolidBrush ink(snapshot.valid && snapshot.overtime
          ? Gdiplus::Color(255, 188, 86, 22) : Gdiplus::Color(255, 65, 70, 73));
      Gdiplus::StringFormat format;
      format.SetAlignment(Gdiplus::StringAlignmentCenter);
      format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
      format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
      Gdiplus::Font labelFont(L"Microsoft YaHei UI", 20, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      Gdiplus::Font numberFont(L"Consolas", 32, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
      const wchar_t* label = !snapshot.valid ? UiText(L"时间不可用", L"Time unavailable") :
          snapshot.overtime ? UiText(L"已加班", L"Overtime") : UiText(L"距下班", L"Until off work");
      const std::wstring duration = snapshot.valid ? OffworkTimeText(snapshot.overtime
          ? snapshot.overtimeSeconds : snapshot.remainingSeconds) : L"--:--:--";
      graphics.DrawString(label, -1, &labelFont, Gdiplus::RectF(12, 258, 216, 28), &format, &ink);
      graphics.DrawString(duration.c_str(), -1, &numberFont,
          Gdiplus::RectF(12, 286, 216, 42), &format, &ink);
    }
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
  if (gCountingCheck.counting) ++gCountingCheck.expected;
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
  if (gCountingCheck.counting) ++gCountingCheck.counted;
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

void QueueGlobalInput(UINT message, unsigned int kind) {
  const ULONGLONG now = GetTickCount64();
  const bool observing = gCountingCheck.active &&
      now >= gCountingCheck.starts && now < gCountingCheck.ends;
  if (observing) {
    if (kind == 1) ++gCountingCheck.keys;
    else if (kind == 2) ++gCountingCheck.clicks;
    else ++gCountingCheck.scrolls;
    gCountingCheck.lastRelative = now - gCountingCheck.starts;
  }
  if (!PostMessageW(gState.window, message, gCountingCheck.listenerGeneration,
          observing ? static_cast<LPARAM>(gCountingCheck.generation) : 0)) {
    gCountingCheck.deliveryFault = true;
  }
}

LRESULT CALLBACK KeyboardHook(
    int code, WPARAM message, LPARAM data) {
  (void)data;
  if (code == HC_ACTION &&
      (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) &&
      gState.window != nullptr) {
    QueueGlobalInput(kCountMessage, 1);
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
        QueueGlobalInput(kCountMessage, 2);
        break;
      case WM_MOUSEWHEEL:
      case WM_MOUSEHWHEEL:
        QueueGlobalInput(kScrollMessage, 3);
        break;
      default:
        break;
    }
  }
  return CallNextHookEx(gState.mouseHook, code, message, data);
}

void CountGlobalDelivery(bool scroll, LPARAM generation, WPARAM listenerGeneration) {
  const std::uint64_t before = gState.total;
  gCountingCheck.counting = generation != 0 &&
      static_cast<unsigned int>(generation) == gCountingCheck.generation;
  if (gCountingCheck.counting) ++gCountingCheck.handled;
  if (scroll) CountScrollGesture();
  else CountOneOperation();
  gCountingCheck.counting = false;
  if (gState.total > before && listenerGeneration == gCountingCheck.listenerGeneration)
    gCountingCheck.observedCount = true;
}

void RestartGlobalListeners() {
  ++gCountingCheck.listenerGeneration;
  if (gState.keyboardHook != nullptr) UnhookWindowsHookEx(gState.keyboardHook);
  if (gState.mouseHook != nullptr) UnhookWindowsHookEx(gState.mouseHook);
  gCountingCheck.observedCount = false;
  gCountingCheck.deliveryFault = false;
  HINSTANCE instance = GetModuleHandleW(nullptr);
  gState.keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHook, instance, 0);
  gCountingCheck.keyboardError = gState.keyboardHook ? ERROR_SUCCESS : GetLastError();
  gState.mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseHook, instance, 0);
  gCountingCheck.mouseError = gState.mouseHook ? ERROR_SUCCESS : GetLastError();
}

std::wstring CountingStatusTitle() {
  if (!gState.keyboardHook && !gState.mouseHook)
    return UiText(L"仅点击小伙伴计数", L"Pet-click Counting Only");
  if (!gState.keyboardHook || !gState.mouseHook)
    return UiText(L"待检查：部分监听未建立", L"Check Needed: Partial Listener");
  if (gCountingCheck.deliveryFault)
    return UiText(L"待检查：监听与计数结果不一致", L"Check Needed: Counting Mismatch");
  if (!gCountingCheck.observedCount)
    return UiText(L"待检查：监听已建立，尚未观察到计数",
                  L"Check Pending: Listener Ready, No Count Observed");
  return UiText(L"全局监听已收到事件并计数", L"Global Events Received and Counted");
}

void RefreshCountingStatus() {
  if (!gCountingCheck.window) return;
  const ULONGLONG now = GetTickCount64();
  const std::uint64_t events =
      gCountingCheck.keys + gCountingCheck.clicks + gCountingCheck.scrolls;
  if (gCountingCheck.active && now >= gCountingCheck.ends) {
    gCountingCheck.active = false;
    if (events == 0) {
      gCountingCheck.observedCount = false;
      gCountingCheck.result = UiText(
          L"未观察到输入，不能判断失败。若确实在其他应用操作过，请重试监听后再测；否则可直接重新自检。",
          L"No input observed; this is not a failure verdict. If you used another app, retry the listener and check again; otherwise repeat the check.");
    } else if (gCountingCheck.handled != events ||
               gCountingCheck.expected != gCountingCheck.counted) {
      gCountingCheck.deliveryFault = true;
      gCountingCheck.result = UiText(
          L"收到事件，但计数未完全更新。请重试监听；总数已达上限时也不会继续增加。",
          L"Events arrived but counts did not fully update. Retry the listener; counts also stop at the numeric limit.");
    } else if (gCountingCheck.expected == 0) {
      gCountingCheck.result = UiText(
          L"只观察到同一段连续滚动，未开始新手势；停一下再试，不判失败。",
          L"Only an existing scroll gesture was observed. Pause and retry; no failure inferred.");
    } else {
      gCountingCheck.deliveryFault = false;
      gCountingCheck.result = UiText(
          L"本次观察到的输入已计数。未发生的输入类型未判断；请自行确认刚才已切到其他应用。",
          L"Observed inputs were counted. Unused input types are not assessed; please confirm you switched to another app.");
    }
  }
  std::wstring progress = gCountingCheck.result.empty()
      ? UiText(L"尚未开始自检。", L"No check started.") : gCountingCheck.result;
  if (gCountingCheck.active) {
    if (now < gCountingCheck.starts) {
      progress = UiText(L"准备中：请切换到其他应用。2 秒后开始记录。",
                        L"Get ready: switch to another app. Recording starts after 2 seconds.");
    } else {
      progress = UiText(L"记录中，剩余秒数：", L"Recording; seconds left: ") +
          std::to_wstring((gCountingCheck.ends - now + 999) / 1000);
    }
  }
  std::wstring text = CountingStatusTitle();
  text += UiText(
      L"\r\n\r\n点击开始后切到其他应用，按几次键、点击或滚动；10 秒后回来。程序不读取当前应用，请自行确认已切换。\r\n\r\n",
      L"\r\n\r\nStart, switch to another app, type, click or scroll, then return after 10 seconds. The app does not inspect the active app; please confirm you switched.\r\n\r\n");
  text += progress;
  text += UiText(L"\r\n\r\n收到按键事件：", L"\r\n\r\nKey events received: ") + std::to_wstring(gCountingCheck.keys);
  text += UiText(L"\r\n鼠标按键：", L"\r\nMouse clicks: ") + std::to_wstring(gCountingCheck.clicks);
  text += UiText(L"\r\n滚动事件：", L"\r\nScroll events: ") + std::to_wstring(gCountingCheck.scrolls);
  text += UiText(L"\r\n按规则应增加：", L"\r\nExpected count increase: ") + std::to_wstring(gCountingCheck.expected);
  text += UiText(L"；实际增加：", L"; actual increase: ") + std::to_wstring(gCountingCheck.counted);
  text += UiText(L"\r\n最后事件距开始的毫秒数：", L"\r\nLast event, milliseconds after start: ") +
      std::to_wstring(gCountingCheck.lastRelative);
  text += UiText(L"（无事件时为 0）。连续滚动按一次手势计数。", L" (0 if none). Continuous scrolling counts as one gesture.");
  text += UiText(L"\r\n\r\n键盘监听句柄：", L"\r\n\r\nKeyboard listener handle: ");
  text += gState.keyboardHook ? UiText(L"已建立", L"created") : UiText(L"未建立", L"unavailable");
  text += UiText(L"；鼠标监听句柄：", L"; mouse listener handle: ");
  text += gState.mouseHook ? UiText(L"已建立", L"created") : UiText(L"未建立", L"unavailable");
  if (!gState.keyboardHook)
    text += UiText(L"；键盘错误码 ", L"; keyboard error ") + std::to_wstring(gCountingCheck.keyboardError);
  if (!gState.mouseHook)
    text += UiText(L"；鼠标错误码 ", L"; mouse error ") + std::to_wstring(gCountingCheck.mouseError);
  text += UiText(
      L"。句柄存在不保证仍在收到输入，请以实际自检为准。\r\n\r\nWindows 安全桌面、会话切换或监听超时可能影响监听。可点“重试监听”，不需要开启 macOS 权限，也不要求管理员提权或关闭安全保护。\r\n\r\n自检仅在内存中保留事件次数与相对时间；不读取或保存具体键值、内容、坐标、应用或窗口信息。不联网。",
      L". A handle alone does not prove input is still arriving; use the check.\r\n\r\nWindows secure desktops, session changes or listener timeouts can affect input. Retry the listener; no macOS permissions, elevation or disabling security is required.\r\n\r\nOnly event counts and relative times are kept in memory, never key values, contents, coordinates, apps or window information. No networking.");
  SetDlgItemTextW(gCountingCheck.window, kStatusText, text.c_str());
  EnableWindow(GetDlgItem(gCountingCheck.window, kStatusStart), !gCountingCheck.active);
}

void LayoutCountingStatus(HWND window) {
  RECT client = {};
  GetClientRect(window, &client);
  const UINT dpi = gState.dpi ? gState.dpi : 96;
  const int margin = ScaleDip(16, dpi);
  const int buttonHeight = ScaleDip(32, dpi);
  const int bottom = client.bottom - margin - buttonHeight;
  MoveWindow(GetDlgItem(window, kStatusText), margin, margin,
      std::max(1, static_cast<int>(client.right) - 2 * margin),
      std::max(1, bottom - 2 * margin), TRUE);
  const int width = std::max(1, (static_cast<int>(client.right) - 4 * margin) / 3);
  for (int i = 0; i < 3; ++i) {
    MoveWindow(GetDlgItem(window, kStatusStart + i),
        margin + i * (width + margin), bottom, width, buttonHeight, TRUE);
  }
}

LRESULT CALLBACK CountingStatusProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_CREATE:
      gCountingCheck.window = window;
      CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
          WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_TABSTOP | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
          0, 0, 1, 1, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusText)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"开始 10 秒自检", L"Start 10-second Check"),
          WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON, 0, 0, 1, 1,
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusStart)), GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"重试监听", L"Retry Listener"),
          WS_CHILD | WS_VISIBLE | WS_TABSTOP, 0, 0, 1, 1,
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusRetry)), GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"关闭", L"Close"),
          WS_CHILD | WS_VISIBLE | WS_TABSTOP, 0, 0, 1, 1,
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStatusClose)), GetModuleHandleW(nullptr), nullptr);
      for (int id = kStatusText; id <= kStatusClose; ++id)
        SendDlgItemMessageW(window, id, WM_SETFONT,
            reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
      SetTimer(window, 1, 1000, nullptr);
      LayoutCountingStatus(window);
      RefreshCountingStatus();
      return 0;
    case WM_SIZE:
      LayoutCountingStatus(window);
      return 0;
    case WM_GETMINMAXINFO: {
      auto* limits = reinterpret_cast<MINMAXINFO*>(lParam);
      const UINT dpi = gState.dpi ? gState.dpi : 96;
      limits->ptMinTrackSize.x = ScaleDip(500, dpi);
      limits->ptMinTrackSize.y = ScaleDip(400, dpi);
      return 0;
    }
    case WM_TIMER:
      RefreshCountingStatus();
      return 0;
    case WM_COMMAND:
      if (LOWORD(wParam) == kStatusStart && !gCountingCheck.active) {
        ++gCountingCheck.generation;
        if (gCountingCheck.generation == 0) ++gCountingCheck.generation;
        gCountingCheck.keys = gCountingCheck.clicks = gCountingCheck.scrolls = 0;
        gCountingCheck.handled = gCountingCheck.expected = gCountingCheck.counted = 0;
        gCountingCheck.lastRelative = 0;
        gCountingCheck.result.clear();
        gCountingCheck.starts = GetTickCount64() + 2000;
        gCountingCheck.ends = gCountingCheck.starts + 10000;
        gCountingCheck.active = true;
        RefreshCountingStatus();
        return 0;
      }
      if (LOWORD(wParam) == kStatusRetry) {
        gCountingCheck.active = false;
        ++gCountingCheck.generation;
        gCountingCheck.result = UiText(L"监听已重试，请重新开始自检。", L"Listener retried. Start a new check.");
        RestartGlobalListeners();
        RefreshCountingStatus();
        return 0;
      }
      if (LOWORD(wParam) == kStatusClose || LOWORD(wParam) == IDCANCEL) {
        DestroyWindow(window);
        return 0;
      }
      break;
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, 1);
      if (gCountingCheck.active)
        gCountingCheck.result = UiText(L"自检已取消，未作故障判断。", L"Check cancelled; no failure inferred.");
      gCountingCheck.active = false;
      gCountingCheck.window = nullptr;
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

void ShowCountingStatus(HWND owner) {
  if (!gCountingCheck.window) {
    WNDCLASSEXW cls = {};
    cls.cbSize = sizeof(cls);
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpfnWndProc = CountingStatusProcedure;
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    cls.lpszClassName = kCountStatusClass;
    if (!RegisterClassExW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return;
    const UINT dpi = gState.dpi ? gState.dpi : 96;
    gCountingCheck.window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT,
        kCountStatusClass, UiText(L"计数状态与自检", L"Counting Status & Check"),
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME,
        CW_USEDEFAULT, CW_USEDEFAULT, ScaleDip(640, dpi), ScaleDip(570, dpi),
        owner, nullptr, cls.hInstance, nullptr);
  }
  if (!gCountingCheck.window) return;
  ShowWindow(gCountingCheck.window, SW_SHOW);
  SetForegroundWindow(gCountingCheck.window);
  RefreshCountingStatus();
}

bool IsMainWindowAlive(HWND owner) {
  return owner != nullptr && gState.window == owner && IsWindow(owner);
}

bool ShowPrivacyNotice(HWND owner) {
  return MessageBoxW(
      owner,
      UiText(
          L"1. 按住小伙伴拖动，放到喜欢的位置。\n"
          L"2. 右键小伙伴，可以换形象、看日历和退出。\n"
          L"3. Windows 通常无需额外授权；需要帮助时，右键打开“关于”，查看 Windows 权限与计数帮助。\n\n"
          L"牛马电子功德只统计按键、鼠标按键和滚轮手势发生的次数。\n\n"
          L"程序不会读取、保存或上传按键内容、鼠标位置、当前应用、"
          L"剪贴板或屏幕内容；程序不包含联网功能。",
          L"1. Drag your companion to move it.\n"
          L"2. Right-click it to change appearance, view the calendar, or quit.\n"
          L"3. Windows normally needs no extra permission. Open About for Windows permissions and counting help.\n\n"
          L"NiuMa Merit counts only keyboard presses, mouse button presses, "
          L"and scroll gestures.\n\nIt does not read, save, or upload key content, "
          L"mouse positions, the current app, clipboard data, or screen content. "
          L"The app has no network features."),
      UiText(L"先记住三件事", L"Three Things to Get Started"), MB_OK | MB_ICONINFORMATION) == IDOK;
}

constexpr int kAboutHelpLink = 3090;

struct AboutDialogState {
  std::wstring text;
  PngResource douyin;
  HWND viewport = nullptr;
  HWND helpLink = nullptr;
  HFONT font = nullptr;
  WNDPROC buttonProcedure = nullptr;
  int padding = 16;
  int lineHeight = 16;
  int textHeight = 0;
  int helpHeight = 0;
  int imageWidth = 260;
  int imageHeight = 260;
  int contentWidth = 0;
  int contentHeight = 0;
  int viewportWidth = 0;
  int viewportHeight = 0;
  int scrollX = 0;
  int scrollY = 0;
  int wheelDelta = 0;
  int horizontalWheelDelta = 0;
};

void ScrollAboutContent(AboutDialogState& state, int x, int y) {
  state.scrollX = std::clamp(x, 0,
      std::max(0, state.contentWidth - state.viewportWidth));
  state.scrollY = std::clamp(y, 0,
      std::max(0, state.contentHeight - state.viewportHeight));
  SCROLLINFO info = {};
  info.cbSize = sizeof(info);
  info.fMask = SIF_POS;
  info.nPos = state.scrollX;
  SetScrollInfo(state.viewport, SB_HORZ, &info, TRUE);
  info.nPos = state.scrollY;
  SetScrollInfo(state.viewport, SB_VERT, &info, TRUE);
  if (state.helpLink) {
    MoveWindow(state.helpLink, state.padding - state.scrollX,
        state.padding * 2 + state.textHeight - state.scrollY,
        std::max(1, state.contentWidth - state.padding * 2), state.helpHeight, TRUE);
  }
  InvalidateRect(state.viewport, nullptr, FALSE);
}

void MeasureAboutContent(AboutDialogState& state) {
  RECT client = {};
  GetClientRect(state.viewport, &client);
  state.viewportWidth = static_cast<int>(client.right);
  state.viewportHeight = static_cast<int>(client.bottom);
  // Keep the image size independent of the viewport. Narrow work areas scroll
  // horizontally rather than downscaling the original embedded image again.
  state.contentWidth = std::max(state.viewportWidth,
                               state.imageWidth + state.padding * 2);
  RECT measured = {0, 0, state.contentWidth - state.padding * 2, 0};
  HDC dc = GetDC(state.viewport);
  HGDIOBJ oldFont = SelectObject(dc, state.font);
  DrawTextW(dc, state.text.c_str(), -1, &measured,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
  TEXTMETRICW metrics = {};
  GetTextMetricsW(dc, &metrics);
  state.lineHeight = std::max(1, static_cast<int>(metrics.tmHeight +
                                               metrics.tmExternalLeading));
  SelectObject(dc, oldFont);
  ReleaseDC(state.viewport, dc);
  state.textHeight = static_cast<int>(measured.bottom) + 4;
  state.helpHeight = state.lineHeight + state.padding;
  state.contentHeight = state.padding * 4 + state.textHeight +
                        state.helpHeight + state.imageHeight;

  SCROLLINFO info = {};
  info.cbSize = sizeof(info);
  // Reserve both native scrollbars even when disabled, keeping text wrapping
  // stable as the viewport changes and avoiding scrollbar/layout oscillation.
  info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS | SIF_DISABLENOSCROLL;
  info.nMax = std::max(0, state.contentWidth - 1);
  info.nPage = static_cast<UINT>(state.viewportWidth);
  info.nPos = state.scrollX;
  SetScrollInfo(state.viewport, SB_HORZ, &info, TRUE);
  info.nMax = std::max(0, state.contentHeight - 1);
  info.nPage = static_cast<UINT>(state.viewportHeight);
  info.nPos = state.scrollY;
  SetScrollInfo(state.viewport, SB_VERT, &info, TRUE);
  ScrollAboutContent(state, state.scrollX, state.scrollY);
}

bool IsAboutScrollKey(WPARAM key) {
  return key == VK_UP || key == VK_DOWN || key == VK_LEFT || key == VK_RIGHT ||
         key == VK_PRIOR || key == VK_NEXT || key == VK_HOME || key == VK_END;
}

LRESULT CALLBACK AboutContentProcedure(HWND window, UINT message,
                                       WPARAM wParam, LPARAM lParam) {
  auto* state = reinterpret_cast<AboutDialogState*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    state = static_cast<AboutDialogState*>(
        reinterpret_cast<const CREATESTRUCTW*>(lParam)->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(state));
    state->viewport = window;
  }
  if (!state) return DefWindowProcW(window, message, wParam, lParam);
  switch (message) {
    case WM_CREATE:
      state->helpLink = CreateWindowExW(0, L"BUTTON",
          UiText(L"Windows 权限与计数帮助", L"Windows permissions and counting help"),
          WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
          0, 0, 1, 1, window, reinterpret_cast<HMENU>(kAboutHelpLink),
          GetModuleHandleW(nullptr), nullptr);
      if (!state->helpLink) return -1;
      SendMessageW(state->helpLink, WM_SETFONT,
          reinterpret_cast<WPARAM>(state->font), TRUE);
      MeasureAboutContent(*state);
      return 0;
    case WM_COMMAND:
      if (LOWORD(wParam) == kAboutHelpLink && HIWORD(wParam) == BN_CLICKED) {
        ShellExecuteW(window, L"open", L"https://gongde.zqscreen.cn/help-windows.html",
            nullptr, nullptr, SW_SHOWNORMAL);
        return 0;
      }
      break;
    case WM_SETCURSOR:
      if (reinterpret_cast<HWND>(wParam) == state->helpLink && LOWORD(lParam) == HTCLIENT) {
        SetCursor(LoadCursorW(nullptr, IDC_HAND));
        return TRUE;
      }
      break;
    case WM_DRAWITEM: {
      const auto* draw = reinterpret_cast<const DRAWITEMSTRUCT*>(lParam);
      if (!draw || draw->CtlID != kAboutHelpLink) break;
      FillRect(draw->hDC, &draw->rcItem, GetSysColorBrush(COLOR_3DFACE));
      HGDIOBJ oldFont = SelectObject(draw->hDC, state->font);
      const COLORREF color = GetSysColor(COLOR_HOTLIGHT);
      SetBkMode(draw->hDC, TRANSPARENT);
      SetTextColor(draw->hDC, color);
      const wchar_t* label = UiText(L"Windows 权限与计数帮助",
                                    L"Windows permissions and counting help");
      RECT text = draw->rcItem;
      DrawTextW(draw->hDC, label, -1, &text, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
      SIZE size = {};
      GetTextExtentPoint32W(draw->hDC, label, static_cast<int>(std::wcslen(label)), &size);
      HPEN pen = CreatePen(PS_SOLID, 1, color);
      if (pen) {
        HGDIOBJ oldPen = SelectObject(draw->hDC, pen);
        const int y = draw->rcItem.top + (draw->rcItem.bottom - draw->rcItem.top - size.cy) / 2 + size.cy - 1;
        MoveToEx(draw->hDC, draw->rcItem.left, y, nullptr);
        LineTo(draw->hDC, std::min(draw->rcItem.right, draw->rcItem.left + size.cx), y);
        SelectObject(draw->hDC, oldPen);
        DeleteObject(pen);
      }
      if (draw->itemState & ODS_FOCUS) DrawFocusRect(draw->hDC, &draw->rcItem);
      SelectObject(draw->hDC, oldFont);
      return TRUE;
    }
    case WM_SIZE:
      MeasureAboutContent(*state);
      return 0;
    case WM_SETFONT:
      state->font = wParam ? reinterpret_cast<HFONT>(wParam)
          : reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
      MeasureAboutContent(*state);
      return 0;
    case WM_GETFONT:
      return reinterpret_cast<LRESULT>(state->font);
    case WM_GETDLGCODE:
      // Tab, Enter and Escape remain owned by the modal dialog manager.
      return IsAboutScrollKey(wParam) ? DLGC_WANTMESSAGE : 0;
    case WM_LBUTTONDOWN:
      SetFocus(window);
      return 0;
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    case WM_KEYDOWN: {
      int x = state->scrollX, y = state->scrollY;
      const int page = std::max(state->lineHeight,
                               state->viewportHeight - state->lineHeight);
      switch (wParam) {
        case VK_UP: y -= state->lineHeight; break;
        case VK_DOWN: y += state->lineHeight; break;
        case VK_LEFT: x -= state->lineHeight; break;
        case VK_RIGHT: x += state->lineHeight; break;
        case VK_PRIOR: y -= page; break;
        case VK_NEXT: y += page; break;
        case VK_HOME: x = 0; y = 0; break;
        case VK_END: y = state->contentHeight; break;
        default: return DefWindowProcW(window, message, wParam, lParam);
      }
      ScrollAboutContent(*state, x, y);
      return 0;
    }
    case WM_VSCROLL:
    case WM_HSCROLL: {
      const bool vertical = message == WM_VSCROLL;
      int position = vertical ? state->scrollY : state->scrollX;
      const int page = vertical ? state->viewportHeight : state->viewportWidth;
      SCROLLINFO info = {};
      info.cbSize = sizeof(info);
      info.fMask = SIF_TRACKPOS;
      GetScrollInfo(window, vertical ? SB_VERT : SB_HORZ, &info);
      switch (LOWORD(wParam)) {
        case SB_LINEUP: position -= state->lineHeight; break;
        case SB_LINEDOWN: position += state->lineHeight; break;
        case SB_PAGEUP: position -= page; break;
        case SB_PAGEDOWN: position += page; break;
        case SB_TOP: position = 0; break;
        case SB_BOTTOM:
          position = vertical ? state->contentHeight : state->contentWidth;
          break;
        case SB_THUMBTRACK:
        case SB_THUMBPOSITION: position = info.nTrackPos; break;
        default: return 0;
      }
      ScrollAboutContent(*state, vertical ? state->scrollX : position,
                         vertical ? position : state->scrollY);
      return 0;
    }
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL: {
      const bool horizontal = message == WM_MOUSEHWHEEL ||
                              (LOWORD(wParam) & MK_SHIFT) != 0;
      int& remainder = horizontal ? state->horizontalWheelDelta : state->wheelDelta;
      remainder += static_cast<short>(HIWORD(wParam));
      const int steps = remainder / WHEEL_DELTA;
      remainder %= WHEEL_DELTA;
      UINT lines = 3;
      SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
      const int distance = lines == WHEEL_PAGESCROLL
          ? (horizontal ? state->viewportWidth : state->viewportHeight)
          : static_cast<int>(lines) * state->lineHeight;
      const int movement = steps * distance * (message == WM_MOUSEHWHEEL ? 1 : -1);
      ScrollAboutContent(*state, state->scrollX + (horizontal ? movement : 0),
                         state->scrollY + (horizontal ? 0 : movement));
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint = {};
      HDC dc = BeginPaint(window, &paint);
      RECT client = {};
      GetClientRect(window, &client);
      FillRect(dc, &client, GetSysColorBrush(COLOR_3DFACE));
      HGDIOBJ oldFont = SelectObject(dc, state->font);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
      RECT text = {state->padding - state->scrollX,
                   state->padding - state->scrollY,
                   state->contentWidth - state->padding - state->scrollX,
                   state->padding + state->textHeight - state->scrollY};
      DrawTextW(dc, state->text.c_str(), -1, &text,
                DT_WORDBREAK | DT_NOPREFIX);
      SelectObject(dc, oldFont);
      if (state->douyin.image && state->douyin.image->GetWidth() != 0 &&
          state->douyin.image->GetHeight() != 0) {
        Gdiplus::Graphics graphics(dc);
        graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
        graphics.DrawImage(state->douyin.image.get(), Gdiplus::RectF(
            static_cast<float>((state->contentWidth - state->imageWidth) / 2 -
                               state->scrollX),
            static_cast<float>(state->padding * 3 + state->textHeight + state->helpHeight -
                               state->scrollY),
            static_cast<float>(state->imageWidth),
            static_cast<float>(state->imageHeight)));
      }
      if (GetFocus() == window) DrawFocusRect(dc, &client);
      EndPaint(window, &paint);
      return 0;
    }
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

LRESULT CALLBACK AboutButtonProcedure(HWND window, UINT message,
                                      WPARAM wParam, LPARAM lParam) {
  auto* state = reinterpret_cast<AboutDialogState*>(
      GetWindowLongPtrW(GetParent(window), DWLP_USER));
  if (!state || !state->buttonProcedure)
    return DefWindowProcW(window, message, wParam, lParam);
  // The initial OK focus still allows keyboard/wheel scrolling, without
  // intercepting its default-button behavior or the dialog's Escape handling.
  if (message == WM_GETDLGCODE && IsAboutScrollKey(wParam)) {
    return CallWindowProcW(state->buttonProcedure, window, message, wParam, lParam)
           | DLGC_WANTMESSAGE;
  }
  if ((message == WM_KEYDOWN && IsAboutScrollKey(wParam)) ||
      message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
    return SendMessageW(state->viewport, message, wParam, lParam);
  }
  return CallWindowProcW(state->buttonProcedure, window, message, wParam, lParam);
}

void LayoutAboutDialog(HWND window, AboutDialogState& state) {
  RECT client = {};
  GetClientRect(window, &client);
  const int width = static_cast<int>(client.right);
  const int height = static_cast<int>(client.bottom);
  const int buttonHeight = std::min(MulDiv(28, gState.dpi, 96), height);
  const int padding = std::min(state.padding,
      std::min(std::max(0, (height - buttonHeight) / 3), width / 4));
  const int viewportHeight = std::max(0, height - buttonHeight - padding * 3);
  MoveWindow(state.viewport, padding, padding, std::max(1, width - padding * 2),
             viewportHeight, TRUE);
  ShowWindow(state.viewport, viewportHeight > 0 ? SW_SHOW : SW_HIDE);
  const int buttonWidth = std::min(MulDiv(92, gState.dpi, 96),
                                  std::max(1, width - padding * 2));
  MoveWindow(GetDlgItem(window, IDOK), width - padding - buttonWidth,
             height - padding - buttonHeight, buttonWidth, buttonHeight, TRUE);
}

INT_PTR CALLBACK AboutDialogProcedure(HWND window, UINT message,
                                      WPARAM wParam, LPARAM lParam) {
  auto* state = reinterpret_cast<AboutDialogState*>(
      GetWindowLongPtrW(window, DWLP_USER));
  switch (message) {
    case WM_INITDIALOG: {
      state = reinterpret_cast<AboutDialogState*>(lParam);
      SetWindowLongPtrW(window, DWLP_USER, lParam);
      SetWindowTextW(window, UiText(L"关于牛马电子功德", L"About NiuMa Merit"));
      SetDlgItemTextW(window, 3001, state->text.c_str());
      SetDlgItemTextW(window, IDOK, UiText(L"知道了", L"OK"));

      MONITORINFO monitor = {};
      monitor.cbSize = sizeof(monitor);
      RECT work = {};
      if (GetMonitorInfoW(MonitorFromWindow(GetWindow(window, GW_OWNER),
                                            MONITOR_DEFAULTTONEAREST), &monitor)) {
        work = monitor.rcWork;
      } else {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
      }
      if (work.right <= work.left || work.bottom <= work.top) {
        EndDialog(window, -1);
        return TRUE;
      }
      RECT outer = {}, client = {};
      GetWindowRect(window, &outer);
      GetClientRect(window, &client);
      const int borderHeight = outer.bottom - outer.top - client.bottom;
      const int borderWidth = outer.right - outer.left - client.right;
      state->padding = std::max(1, MulDiv(16, gState.dpi, 96));
      state->imageHeight = std::max(1, MulDiv(260, gState.dpi, 96));
      state->imageWidth = state->imageHeight;
      if (state->douyin.image && state->douyin.image->GetHeight() != 0 &&
          state->douyin.image->GetWidth() != 0) {
        state->imageWidth = std::max(1, static_cast<int>(std::lround(
            static_cast<double>(state->imageHeight) * state->douyin.image->GetWidth()
            / state->douyin.image->GetHeight())));
      }
      const HWND textControl = GetDlgItem(window, 3001);
      state->font = reinterpret_cast<HFONT>(
          SendMessageW(textControl, WM_GETFONT, 0, 0));
      if (!state->font)
        state->font = reinterpret_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
      const HINSTANCE instance = GetModuleHandleW(nullptr);
      WNDCLASSW contentClass = {};
      contentClass.lpfnWndProc = AboutContentProcedure;
      contentClass.hInstance = instance;
      contentClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
      contentClass.lpszClassName = L"NiuMaMeritAboutContent";
      if (!RegisterClassW(&contentClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        EndDialog(window, -1);
        return TRUE;
      }
      if (!CreateWindowExW(WS_EX_CONTROLPARENT, contentClass.lpszClassName, state->text.c_str(),
                           WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | WS_HSCROLL | WS_CLIPCHILDREN,
                           0, 0, 1, 1, window, nullptr, instance, state)) {
        EndDialog(window, -1);
        return TRUE;
      }
      ShowWindow(textControl, SW_HIDE);
      ShowWindow(GetDlgItem(window, 3002), SW_HIDE);
      state->buttonProcedure = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(
          GetDlgItem(window, IDOK), GWLP_WNDPROC,
          reinterpret_cast<LONG_PTR>(AboutButtonProcedure)));
      const int margin = std::min(state->padding,
          std::min(static_cast<int>(work.right - work.left) / 8,
                   static_cast<int>(work.bottom - work.top) / 8));
      const int width = std::min(static_cast<int>(outer.right - outer.left),
                                static_cast<int>(work.right - work.left) - margin * 2);
      const int maxHeight = static_cast<int>(work.bottom - work.top) - margin * 2;
      // Set a work-area-bounded provisional size before measuring the viewport.
      SetWindowPos(window, nullptr, work.left + margin, work.top + margin,
                   width, std::min(static_cast<int>(outer.bottom - outer.top), maxHeight),
                   SWP_NOZORDER | SWP_NOACTIVATE);
      LayoutAboutDialog(window, *state);
      const int height = std::min(maxHeight,
          borderHeight + state->contentHeight + MulDiv(28, gState.dpi, 96)
          + state->padding * 3 + GetSystemMetrics(SM_CYHSCROLL));
      SetWindowPos(window, nullptr,
                   work.left + (work.right - work.left - width) / 2,
                   work.top + (work.bottom - work.top - height) / 2,
                   width, height, SWP_NOZORDER);
      SetFocus(GetDlgItem(window, IDOK));
      return FALSE;
    }
    case WM_SIZE:
      if (state && state->viewport) {
        LayoutAboutDialog(window, *state);
        return TRUE;
      }
      break;
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL:
      if (state && state->viewport) {
        SendMessageW(state->viewport, message, wParam, lParam);
        return TRUE;
      }
      break;
    case WM_COMMAND:
      if (LOWORD(wParam) == IDOK || LOWORD(wParam) == IDCANCEL) {
        EndDialog(window, LOWORD(wParam));
        return TRUE;
      }
      break;
    case WM_CLOSE:
      EndDialog(window, IDCANCEL);
      return TRUE;
  }
  return FALSE;
}

void ShowAboutDialog(HWND owner) {
  const std::wstring version = NIUMA_APP_VERSION_W;
  std::wstring text = IsChineseUi()
      ? L"牛马电子功德 v" + version + L"\n\n"
        L"只统计按键、鼠标按键和滚轮手势发生的次数，不读取具体内容、"
        L"鼠标位置或窗口信息。\n所有数据仅保存在本机，本软件不包含网络请求、"
        L"遥测或自动更新。\n\n客户端源代码依 GPLv3 许可证开放。\n\n官方网站：\n"
      : L"NiuMa Merit v" + version + L"\n\n"
        L"Counts keyboard presses, mouse button presses, and scroll gestures without "
        L"reading specific content, mouse positions, or window information.\n"
        L"All data stays on this computer. The app contains no network requests, "
        L"telemetry, or automatic updates.\n\nClient source code is available under GPLv3."
        L"\n\nOfficial website:\n";
  text += L"https://gongde.zqscreen.cn/";
  text += UiText(L"\n\n欢迎关注开发者抖音\n@山丘 / 抖音号：1872941388"
                L"\n\nWindows 通常无需额外授权。若在其他应用中没有计数，请查看下方权限与计数帮助。",
                L"\n\nFollow the developer on Douyin\n@Shanqiu / Douyin ID: 1872941388"
                L"\n\nWindows normally needs no extra permission. If input in other apps is not counted, see the help link below.");
  AboutDialogState state;
  state.text = text;
  const HMODULE module = GetModuleHandleW(nullptr);
  const HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(110), RT_RCDATA);
  const DWORD size = resource ? SizeofResource(module, resource) : 0;
  const HGLOBAL loaded = resource ? LoadResource(module, resource) : nullptr;
  const void* bytes = loaded ? LockResource(loaded) : nullptr;
  if (bytes && size != 0) {
    const HGLOBAL buffer = GlobalAlloc(GMEM_MOVEABLE, size);
    void* destination = buffer ? GlobalLock(buffer) : nullptr;
    if (destination) {
      CopyMemory(destination, bytes, size);
      GlobalUnlock(buffer);
      if (SUCCEEDED(CreateStreamOnHGlobal(buffer, TRUE, &state.douyin.stream))) {
        state.douyin.image.reset(Gdiplus::Image::FromStream(state.douyin.stream));
        if (state.douyin.image && state.douyin.image->GetLastStatus() != Gdiplus::Ok) {
          state.douyin.image.reset();
        }
      } else {
        GlobalFree(buffer);
      }
    } else if (buffer) {
      GlobalFree(buffer);
    }
  }
  if (DialogBoxParamW(module, MAKEINTRESOURCEW(3000), owner,
                      AboutDialogProcedure, reinterpret_cast<LPARAM>(&state)) == -1) {
    const std::wstring fallback = text + L"\n\nhttps://gongde.zqscreen.cn/help-windows.html";
    MessageBoxW(owner, fallback.c_str(), UiText(L"关于牛马电子功德", L"About NiuMa Merit"),
                MB_OK | MB_ICONINFORMATION);
  }
}

const wchar_t* SceneTitle(MeritScene scene) {
  switch (scene) {
    case MeritScene::LuckyCat: return UiText(L"招财猫", L"Lucky Cat");
    case MeritScene::SeaLionBellyPat: return UiText(L"海狮拍肚皮", L"Sea Lion Belly Pat");
    case MeritScene::HamsterWheel: return UiText(L"仓鼠跑轮", L"Hamster Wheel");
    default: return UiText(L"默认木鱼", L"Woodfish");
  }
}

void DrawCalendarText(Gdiplus::Graphics& graphics, const std::wstring& text,
                      const Gdiplus::RectF& rect, float size,
                      const Gdiplus::Color& color, bool bold = false,
                      const wchar_t* family = L"Microsoft YaHei UI") {
  Gdiplus::Font font(family, size,
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
  const float left = 14, top = 112, cellWidth = 76, cellHeight = 72;
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
    const std::wstring meritText = std::to_wstring(value);
    const std::wstring dateText = (day < 10 ? L"0" : L"") + std::to_wstring(day);
    const float meritSize = meritText.size() > 10 ? 10.0f :
        (meritText.size() > 7 ? 12.0f : 15.0f);
    DrawCalendarText(graphics, meritText,
        Gdiplus::RectF(cell.X + 2, cell.Y + 5, cell.Width - 4, 22),
        meritSize, ink, true);
    DrawCalendarText(graphics, dateText,
        Gdiplus::RectF(cell.X + 2, cell.Y + 27, cell.Width - 4, 16),
        10, muted, false);
    const auto& overtime = OffworkDay(key);
    if (overtime.present) {
      DrawCalendarText(graphics, UiText(L"自动加班", L"Auto overtime"),
          Gdiplus::RectF(cell.X + 2, cell.Y + 42, cell.Width - 4, 11), 8, accent);
      DrawCalendarText(graphics, OffworkTimeText(overtime.seconds),
          Gdiplus::RectF(cell.X + 2, cell.Y + 53, cell.Width - 4, 14),
          12, accent, true, L"Consolas");
    }
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
    RECT desired = {0, 0, ScaleDip(560, gState.dpi), ScaleDip(552, gState.dpi)};
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
constexpr int kPickerWebsiteButton = 1002;

int PickerItemCount() {
  return 1 + static_cast<int>(gAppearanceCatalog.packs().size());
}

int CurrentPickerIndex() {
  if (!gState.selectedPackId.empty()) {
    const auto& packs = gAppearanceCatalog.packs();
    for (size_t index = 0; index < packs.size(); ++index) {
      if (packs[index]->id == gState.selectedPackId)
        return 1 + static_cast<int>(index);
    }
  }
  return 0;
}

std::wstring PickerItemTitle(int index) {
  if (index == 0) return SceneTitle(MeritScene::Woodfish);
  const auto& pack = gAppearanceCatalog.packs()[static_cast<size_t>(index - 1)];
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
    if (index == 0) {
      DrawSceneArtwork(thumbnailGraphics, MeritScene::Woodfish, 0.0f);
    } else {
      niuma::DrawAppearancePack(
          thumbnailGraphics,
          *gAppearanceCatalog.packs()[static_cast<size_t>(index - 1)], 0.0f);
    }
    graphics.DrawImage(&thumbnail, Gdiplus::RectF(
        static_cast<float>(card.left + ScaleDip(20, dpi)),
        static_cast<float>(card.top + ScaleDip(22, dpi)),
        static_cast<float>(ScaleDip(116, dpi)),
        static_cast<float>(ScaleDip(76, dpi))));
    std::wstring badge;
    if (index == CurrentPickerIndex()) badge = UiText(L"当前", L"Current");
    if (index > 0) {
      const auto& id = gAppearanceCatalog.packs()[static_cast<size_t>(index - 1)]->id;
      if (std::find(gNewlyImportedIds.begin(), gNewlyImportedIds.end(), id) != gNewlyImportedIds.end()) {
        if (!badge.empty()) badge += L" / ";
        badge += UiText(L"本次新增", L"New");
      } else if (std::find(gLastImportedIds.begin(), gLastImportedIds.end(), id) != gLastImportedIds.end()) {
        if (!badge.empty()) badge += L" / ";
        badge += UiText(L"本次导入", L"Imported");
      }
    }
    if (!badge.empty()) {
      Gdiplus::Font badgeFont(L"Microsoft YaHei UI", static_cast<float>(ScaleDip(11, dpi)),
          Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
      Gdiplus::SolidBrush badgeInk(Gdiplus::Color(255, 51, 92, 68));
      Gdiplus::StringFormat badgeFormat;
      badgeFormat.SetAlignment(Gdiplus::StringAlignmentCenter);
      graphics.DrawString(badge.c_str(), -1, &badgeFont,
          Gdiplus::RectF(static_cast<float>(card.left + ScaleDip(4, dpi)),
              static_cast<float>(card.top + ScaleDip(4, dpi)),
              static_cast<float>(card.right - card.left - ScaleDip(8, dpi)),
              static_cast<float>(ScaleDip(18, dpi))), &badgeFormat, &badgeInk);
    }

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
      CreateWindowW(L"BUTTON", UiText(L"去官网查看更多形象", L"See More Appearances Online"),
          WS_CHILD | WS_VISIBLE,
          ScaleDip(16, dpi), ScaleDip(456, dpi), ScaleDip(328, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPickerWebsiteButton)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"删除所选", L"Delete Selected"),
          WS_CHILD | WS_VISIBLE,
          ScaleDip(16, dpi), ScaleDip(492, dpi), ScaleDip(112, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kPickerDeleteButton)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"确认", L"Confirm"), WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
          ScaleDip(188, dpi), ScaleDip(492, dpi), ScaleDip(72, dpi), ScaleDip(30, dpi),
          window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDOK)),
          GetModuleHandleW(nullptr), nullptr);
      CreateWindowW(L"BUTTON", UiText(L"取消", L"Cancel"), WS_CHILD | WS_VISIBLE,
          ScaleDip(272, dpi), ScaleDip(492, dpi), ScaleDip(72, dpi), ScaleDip(30, dpi),
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
      if (LOWORD(wParam) == kPickerWebsiteButton) {
        ShellExecuteW(window, L"open", L"https://gongde.zqscreen.cn/#characters",
            nullptr, nullptr, SW_SHOWNORMAL);
        return 0;
      }
      if (LOWORD(wParam) == kPickerDeleteButton) {
        if (gPicker.pendingIndex == 0) {
          MessageBoxW(window,
              UiText(L"内置形象不能删除。", L"Built-in appearances cannot be deleted."),
              WindowTitle(), MB_OK | MB_ICONINFORMATION);
          return 0;
        }
        const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 1);
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
  if (gPicker.window && IsWindow(gPicker.window)) {
    InvalidateRect(gPicker.window, nullptr, FALSE);
    SetForegroundWindow(gPicker.window);
    return;
  }
  gPicker.scrollRow = std::max(0, gPicker.pendingIndex / 2 - 2);
  for (size_t i = 0; i < gAppearanceCatalog.packs().size(); ++i) {
    if (std::find(gLastImportedIds.begin(), gLastImportedIds.end(),
            gAppearanceCatalog.packs()[i]->id) != gLastImportedIds.end()) {
      gPicker.scrollRow = static_cast<int>((i + 1) / 2);
      break;
    }
  }
  gPicker.scrollRow = std::min(gPicker.scrollRow, std::max(0, (PickerItemCount() + 1) / 2 - 3));
  gPicker.confirmed = false;
  const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
  RECT desired = {0, 0, ScaleDip(360, dpi), ScaleDip(538, dpi)};
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
    if (gPicker.pendingIndex == 0) {
      gState.selectedScene = MeritScene::Woodfish;
      gState.selectedPackId.clear();
    } else {
      const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 1);
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
    if (niuma::IsAppearancePackPath(argument) ||
        niuma::IsAppearanceBatchPath(argument)) {
      result = argument;
      break;
    }
  }
  LocalFree(arguments);
  return result;
}

void ImportAppearancePack(HWND owner, const std::wstring& sourcePath,
                          bool showSuccess) {
  const bool batch = niuma::IsAppearanceBatchPath(sourcePath);
  if (GetFileAttributesW(sourcePath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    MessageBoxW(owner,
        UiText(L"文件不存在或无法读取，请重新选择原文件。原有形象和功德未改变。",
               L"File missing or unreadable. Select the original file again. Existing packs and counts are unchanged."),
        WindowTitle(), MB_OK | MB_ICONWARNING);
    return;
  }
  std::vector<std::string> previousIds;
  for (const auto& pack : gAppearanceCatalog.packs()) previousIds.push_back(pack->id);
  std::wstring error;
  std::vector<std::string> installedIds, duplicates;
  bool installed = false;
  if (batch) {
    installed = gAppearanceCatalog.InstallBatch(
        sourcePath, AppearanceDirectory(), &installedIds, &error, &duplicates);
  } else {
    std::string id;
    bool duplicate = false;
    installed = gAppearanceCatalog.Install(
        sourcePath, AppearanceDirectory(), &id, &error, &duplicate);
    if (installed) installedIds.push_back(id);
    if (installed && duplicate) duplicates.push_back(id);
  }
  gNewlyImportedIds.clear();
  gLastImportedIds.clear();
  std::wstring details;
  for (const auto& id : installedIds) {
    const auto* pack = gAppearanceCatalog.Find(id);
    if (!pack) {
      error += UiText(L"\n已保存的形象未能加载，未启用；原文件保留。",
                      L"\nA saved pack could not be loaded; it was not enabled; files were kept.");
      continue;
    }
    if (std::find(gLastImportedIds.begin(), gLastImportedIds.end(), id) != gLastImportedIds.end()) continue;
    gLastImportedIds.push_back(id);
    details += L"\n" + (IsChineseUi() ? pack->nameZh : pack->nameEn) + L" : ";
    if (std::find(duplicates.begin(), duplicates.end(), id) != duplicates.end()) {
      details += UiText(L"重复包，已保留原形象", L"Duplicate; existing pack kept");
    } else if (std::find(previousIds.begin(), previousIds.end(), id) != previousIds.end()) {
      details += UiText(L"已更新", L"Updated");
    } else {
      gNewlyImportedIds.push_back(id);
      details += UiText(L"本次新增", L"New in this import");
    }
  }
  const bool singleEnabled = !batch && installed && gLastImportedIds.size() == 1;
  if (singleEnabled) {
    gState.selectedPackId = gLastImportedIds.front();
    gState.dirty = true;
    SaveState();
  }
  // Refresh the current pack without implicitly selecting the last batch member.
  RenderLayeredWindow(GetTickCount64());
  if (gPicker.window && IsWindow(gPicker.window)) {
    gPicker.pendingIndex = CurrentPickerIndex();
    InvalidateRect(gPicker.window, nullptr, FALSE);
  }
  std::wstring message = singleEnabled
      ? UiText(L"导入完成，已启用此形象。", L"Imported and enabled.")
      : UiText(L"当前形象未改变。只有确认选择后才会切换。", L"Current appearance unchanged. Confirm a selection to switch.");
  message += UiText(L"\n本次可用形象：", L"\nPacks available from this import: ") +
      std::to_wstring(gLastImportedIds.size()) + details;
  if (!installed || !error.empty()) {
    message += UiText(L"\n\n未完成 / 损坏或校验失败：\n", L"\n\nNot completed / damaged or failed verification:\n");
    message += error.empty() ? UiText(L"形象包无法加载。", L"Pack unavailable.") : error;
    message += UiText(L"\n其他正常形象、功德和日历不受影响。可重新选择原文件或重新下载。",
                     L"\nOther valid packs, counts and calendar are unchanged. Select the original file or download it again.");
  }
  const bool canChoose = !gLastImportedIds.empty();
  if (canChoose && !singleEnabled)
    message += UiText(L"\n\n现在打开形象列表选择吗？", L"\n\nOpen the appearance list to choose now?");
  if (showSuccess || !installed || !error.empty()) {
    const int response = MessageBoxW(owner, message.c_str(),
        !installed ? (canChoose ? UiText(L"部分形象已导入", L"Some Packs Imported")
                               : UiText(L"未能导入形象", L"No Packs Imported"))
                   : WindowTitle(),
        (canChoose && !singleEnabled ? MB_YESNO : MB_OK) |
        (!installed || !error.empty() ? MB_ICONWARNING : MB_ICONINFORMATION));
    if (response == IDYES && IsMainWindowAlive(owner)) ShowAppearancePicker(owner);
  }
}

bool ShowPrivacyNoticeIfNeeded(HWND owner) {
  if (!IsMainWindowAlive(owner)) return false;
  const std::wstring path = DataPath();
  if (!path.empty() &&
      GetPrivateProfileIntW(L"state", L"basic_guide_shown", 0, path.c_str()) == 1) {
    return true;
  }

  if (!ShowPrivacyNotice(owner) || !IsMainWindowAlive(owner)) return false;
  if (!path.empty()) {
    WritePrivateProfileStringW(
        L"state", L"privacy_shown", L"1", path.c_str());
    WritePrivateProfileStringW(L"state", L"basic_guide_shown", L"1", path.c_str());
  }
  return true;
}

bool PrepareClientStartup(HWND owner, const std::wstring& pendingAppearancePack) {
  if (!IsMainWindowAlive(owner)) return false;
  if (!StartedAutomatically() && !ShowPrivacyNoticeIfNeeded(owner)) return false;
  if (!IsMainWindowAlive(owner)) return false;
  if (!pendingAppearancePack.empty()) {
    ImportAppearancePack(owner, pendingAppearancePack, true);
  }
  return IsMainWindowAlive(owner);
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
  gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
  RECT rect = {};
  GetWindowRect(window, &rect);
  SetWindowPos(window, nullptr, rect.left, rect.top, gState.windowWidth,
               gState.windowHeight, SWP_NOZORDER | SWP_NOACTIVATE);
}

void ResizeOffworkWindow() {
  gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
  // Preserve the pet's top-left unless the extra band would leave the work area.
  SetWindowPos(gState.window, nullptr, 0, 0, gState.windowWidth, gState.windowHeight,
      SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  ClampWindowToWorkArea();
  RenderLayeredWindow(GetTickCount64());
}

constexpr int kOffworkEnable = 5101;
constexpr int kOffworkHour = 5102;
constexpr int kOffworkMinute = 5103;

INT_PTR CALLBACK OffworkDialogProcedure(HWND window, UINT message, WPARAM wParam, LPARAM) {
  switch (message) {
    case WM_INITDIALOG: {
      gOffwork.dialog = window;
      SetWindowTextW(window, UiText(L"下班倒计时", L"Off-work Countdown"));
      const UINT dpi = gState.dpi ? gState.dpi : 96;
      const auto control = [window, dpi](const wchar_t* cls, const wchar_t* text,
          DWORD style, int x, int y, int width, int height, int id) {
        HWND child = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style,
            ScaleDip(x, dpi), ScaleDip(y, dpi), ScaleDip(width, dpi), ScaleDip(height, dpi),
            window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), GetModuleHandleW(nullptr), nullptr);
        SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(
            GetWindowLongPtrW(window, GWLP_USERDATA)), TRUE);
        return child;
      };
      const HFONT font = CreateFontW(-ScaleDip(14, dpi), 0, 0, 0, FW_NORMAL, FALSE, FALSE,
          FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
          DEFAULT_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(font ? font :
          GetStockObject(DEFAULT_GUI_FONT)));
      SetWindowLongPtrW(window, DWLP_USER, reinterpret_cast<LONG_PTR>(font));
      control(L"BUTTON", UiText(L"启用下班倒计时", L"Enable off-work countdown"),
          BS_AUTOCHECKBOX | WS_TABSTOP, 20, 18, 370, 28, kOffworkEnable);
      control(L"STATIC", UiText(L"每日下班时间（24 小时制）", L"Daily off-work time (24-hour)"),
          0, 20, 58, 370, 24, -1);
      control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP,
          20, 88, 82, 230, kOffworkHour);
      control(L"STATIC", L":", SS_CENTER, 106, 90, 20, 24, -1);
      control(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP,
          130, 88, 82, 230, kOffworkMinute);
      for (int value = 0; value < 60; ++value) {
        wchar_t text[4] = {};
        swprintf_s(text, L"%02d", value);
        if (value < 24) SendDlgItemMessageW(window, kOffworkHour, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(text));
        SendDlgItemMessageW(window, kOffworkMinute, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(text));
      }
      SendDlgItemMessageW(window, kOffworkHour, CB_SETCURSEL, gOffwork.hour, 0);
      SendDlgItemMessageW(window, kOffworkMinute, CB_SETCURSEL, gOffwork.minute, 0);
      CheckDlgButton(window, kOffworkEnable, gOffwork.enabled ? BST_CHECKED : BST_UNCHECKED);
      EnableWindow(GetDlgItem(window, kOffworkHour), gOffwork.enabled);
      EnableWindow(GetDlgItem(window, kOffworkMinute), gOffwork.enabled);
      control(L"STATIC", UiText(
          L"每天按本地日期计算，超过设定时间即为加班。\r\n运行时自动记录到功德日历，不代表实际劳动。\r\n关闭后停止更新，保留时间设定及已有记录。\r\n完全本地，不依赖账号、网络或输入权限。",
          L"Uses each local date, including weekends.\r\nAfter the target, overtime is saved automatically while\r\nrunning; this does not measure actual work. Turning it\r\noff keeps settings and records. No account, network\r\nor input permission is required."),
          0, 20, 132, 380, 116, -1);
      control(L"BUTTON", UiText(L"取消", L"Cancel"), WS_TABSTOP | BS_PUSHBUTTON,
          214, 266, 86, 32, IDCANCEL);
      control(L"BUTTON", UiText(L"保存", L"Save"), WS_TABSTOP | BS_DEFPUSHBUTTON,
          310, 266, 86, 32, IDOK);
      RECT rect = {0, 0, ScaleDip(416, dpi), ScaleDip(318, dpi)};
      AdjustWindowRectEx(&rect, WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME,
          FALSE, WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT);
      MONITORINFO monitor = {sizeof(monitor)};
      GetMonitorInfoW(MonitorFromWindow(GetWindow(window, GW_OWNER), MONITOR_DEFAULTTONEAREST), &monitor);
      const int width = rect.right - rect.left, height = rect.bottom - rect.top;
      SetWindowPos(window, nullptr,
          monitor.rcWork.left + std::max(0, static_cast<int>(monitor.rcWork.right - monitor.rcWork.left - width) / 2),
          monitor.rcWork.top + std::max(0, static_cast<int>(monitor.rcWork.bottom - monitor.rcWork.top - height) / 2),
          width, height, SWP_NOZORDER);
      return TRUE;
    }
    case WM_COMMAND:
      if (LOWORD(wParam) == kOffworkEnable && HIWORD(wParam) == BN_CLICKED) {
        const bool enabled = IsDlgButtonChecked(window, kOffworkEnable) == BST_CHECKED;
        EnableWindow(GetDlgItem(window, kOffworkHour), enabled);
        EnableWindow(GetDlgItem(window, kOffworkMinute), enabled);
        return TRUE;
      }
      if (LOWORD(wParam) == IDOK) {
        const int hour = static_cast<int>(SendDlgItemMessageW(window, kOffworkHour, CB_GETCURSEL, 0, 0));
        const int minute = static_cast<int>(SendDlgItemMessageW(window, kOffworkMinute, CB_GETCURSEL, 0, 0));
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return TRUE;
        // Pending controls never touch live settings until Save is pressed.
        RefreshOffwork(true, true);
        gOffwork.hour = hour;
        gOffwork.minute = minute;
        gOffwork.enabled = IsDlgButtonChecked(window, kOffworkEnable) == BST_CHECKED;
        gOffwork.settingsDirty = true;
        gOffwork.baselineValid = false;
        gOffwork.snapshot = {};
        RefreshOffwork(false);
        const bool saved = FlushOffwork();
        const bool ticking = SyncOffworkTimer();
        ResizeOffworkWindow();
        if (!saved || !ticking) MessageBoxW(window,
            !saved ? UiText(L"本次设置已在内存生效，但未能写入本地文件；程序会稍后重试。",
                            L"Settings are active in memory, but local saving failed. The app will retry.") :
                     UiText(L"无法启动逐秒刷新，请关闭并重新开启下班倒计时。",
                            L"The refresh timer could not start. Turn the countdown off and on again."),
            WindowTitle(), MB_OK | MB_ICONWARNING);
        EndDialog(window, IDOK);
        return TRUE;
      }
      if (LOWORD(wParam) == IDCANCEL) {
        EndDialog(window, IDCANCEL);
        return TRUE;
      }
      break;
    case WM_CLOSE:
      EndDialog(window, IDCANCEL);
      return TRUE;
    case WM_DESTROY: {
      const auto font = reinterpret_cast<HFONT>(GetWindowLongPtrW(window, DWLP_USER));
      if (font) DeleteObject(font);
      gOffwork.dialog = nullptr;
      return TRUE;
    }
  }
  return FALSE;
}

void ShowOffworkSettings(HWND owner) {
  // Native resource-free modal dialog; no second permanent floating window.
  alignas(DWORD) WORD storage[64] = {};
  auto* dialog = reinterpret_cast<DLGTEMPLATE*>(storage);
  dialog->style = WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME;
  dialog->dwExtendedStyle = WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT;
  dialog->cx = 240;
  dialog->cy = 180;
  if (DialogBoxIndirectParamW(GetModuleHandleW(nullptr), dialog, owner,
                              OffworkDialogProcedure, 0) == -1) {
    MessageBoxW(owner, UiText(L"无法打开下班倒计时设置。", L"Unable to open countdown settings."),
        WindowTitle(), MB_OK | MB_ICONERROR);
  }
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
  AppendMenuW(menu, MF_STRING, kMenuOffwork,
              UiText(L"下班倒计时…", L"Off-work Countdown..."));
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
  } else if (command == static_cast<int>(kMenuOffwork)) {
    ShowOffworkSettings(window);
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
      CountGlobalDelivery(false, lParam, wParam);
      return 0;

    case kScrollMessage:
      CountGlobalDelivery(true, lParam, wParam);
      return 0;

    case WM_COPYDATA: {
      const auto* copy = reinterpret_cast<const COPYDATASTRUCT*>(lParam);
      if (copy == nullptr || copy->dwData != kAppearancePackCopyData ||
          copy->lpData == nullptr || copy->cbData < sizeof(wchar_t) ||
          copy->cbData % sizeof(wchar_t) != 0) return FALSE;
      const auto* path = static_cast<const wchar_t*>(copy->lpData);
      const size_t codeUnits = copy->cbData / sizeof(wchar_t);
      if (path[codeUnits - 1] != L'\0') return FALSE;
      const std::wstring sourcePath(path);
      if (!niuma::IsAppearancePackPath(sourcePath) &&
          !niuma::IsAppearanceBatchPath(sourcePath)) return FALSE;
      ImportAppearancePack(window, sourcePath, true);
      return TRUE;
    }

    case WM_TIMER: {
      if (wParam == kOffworkTimer) {
        if (gOffwork.enabled && !gOffwork.suspended) {
          RefreshOffwork();
          RenderLayeredWindow(GetTickCount64());
        }
        return 0;
      }
      if (wParam == kDayTimer) {
        // Retry failed local saves even when the countdown itself is disabled.
        if (GetTickCount64() - gOffwork.lastFlush >= 60000) FlushOffwork();
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
      gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
      SetWindowPos(
          window, nullptr, suggested->left, suggested->top,
          gState.windowWidth, gState.windowHeight,
          SWP_NOZORDER | SWP_NOACTIVATE);
      ClampWindowToWorkArea();
      RenderLayeredWindow(GetTickCount64());
      return 0;
    }

    case WM_DISPLAYCHANGE:
      gOffwork.baselineValid = false;
      RefreshOffwork(false, true);
      ClampWindowToWorkArea();
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case WM_TIMECHANGE:
    case WM_SETTINGCHANGE:
    case kOffworkSessionChange:
      gOffwork.baselineValid = false;
      RefreshOffwork(false, true);
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case WM_POWERBROADCAST:
      if (wParam == PBT_APMSUSPEND) {
        RefreshOffwork(false, true);
        gOffwork.baselineValid = false;
        gOffwork.suspended = true;
        SyncOffworkTimer();
      } else if (wParam == PBT_APMRESUMEAUTOMATIC || wParam == PBT_APMRESUMESUSPEND) {
        gOffwork.suspended = false;
        gOffwork.baselineValid = false;
        RefreshOffwork(false, true);
        SyncOffworkTimer();
        RenderLayeredWindow(GetTickCount64());
      }
      return TRUE;

    case WM_NCLBUTTONDOWN:
    case WM_NCRBUTTONDOWN:
    case WM_NCMBUTTONDOWN:
    case WM_NCXBUTTONDOWN:
      if (!gState.mouseHook) CountOneOperation();
      break;

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

    case WM_QUERYENDSESSION:
      RefreshOffwork(true, true);
      return TRUE;

    case WM_ENDSESSION:
      if (wParam != 0) {
        RefreshOffwork(true, true);
        SaveState();
      }
      return 0;

    case WM_DESTROY:
      RefreshOffwork(true, true);
      KillTimer(window, kOffworkTimer);
      gOffwork.timerRunning = false;
      UnregisterOffworkSessionNotifications(window);
      if (gOffwork.dialog) EndDialog(gOffwork.dialog, IDCANCEL);
      if (gCountingCheck.window) DestroyWindow(gCountingCheck.window);
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
  const bool catalogLoaded = gAppearanceCatalog.Reload(AppearanceDirectory(), &catalogError);
  if (!catalogLoaded || !catalogError.empty()) {
    MessageBoxW(nullptr, catalogError.c_str(), WindowTitle(), MB_OK | MB_ICONWARNING);
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
  LoadOffworkSettings();
  gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
  gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
  gState.total = ReadIniTotal();
  EnsureCurrentDay();
  const long selectedScene = ReadIniLong(L"selected_scene", 0);
  gState.selectedScene = selectedScene >= 0 && selectedScene <= 3
      ? static_cast<MeritScene>(selectedScene)
      : MeritScene::Woodfish;
  gState.selectedPackId = ReadSelectedPackId();
  if (!gState.selectedPackId.empty() && gAppearanceCatalog.Find(gState.selectedPackId) == nullptr) {
    MessageBoxW(nullptr,
        UiText(L"上次使用的形象文件缺失或未通过校验，暂时显示木鱼。原文件、功德和日历不删除；可重新导入原包。",
               L"The previous appearance is missing or failed verification. Woodfish is shown for now. Original files, counts and calendar are kept; re-import the pack."),
        WindowTitle(), MB_OK | MB_ICONWARNING);
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
  RefreshOffwork(false, true);
  RenderLayeredWindow(GetTickCount64());
  ShowWindow(window, SW_SHOWNOACTIVATE);
  SetWindowPos(
      window, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  SetTimer(window, kDayTimer, 30000, nullptr);
  RegisterOffworkSessionNotifications(window);
  if (!SyncOffworkTimer()) {
    MessageBoxW(window, UiText(L"无法启动下班倒计时逐秒刷新，请在设置中关闭后重新开启。",
        L"The countdown refresh timer could not start. Turn it off and on in settings."),
        WindowTitle(), MB_OK | MB_ICONWARNING);
  }

  wchar_t executable[MAX_PATH] = {};
  if (GetModuleFileNameW(nullptr, executable,
                         static_cast<DWORD>(std::size(executable))) != 0) {
    std::wstring associationError;
    niuma::RegisterAppearancePackAssociation(executable, &associationError);
  }

  ConfigureLaunchAtLogin();
  RestartGlobalListeners();
  if (!PrepareClientStartup(window, pendingAppearancePack) && IsMainWindowAlive(window)) {
    DestroyWindow(window);
  }
  // A listener failure leaves click-only/partial counting and a reachable retry
  // entry, instead of terminating the client and losing its recovery path.

  MSG message = {};
  if (IsMainWindowAlive(window)) {
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      if (gCountingCheck.window && IsDialogMessageW(gCountingCheck.window, &message)) continue;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
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
