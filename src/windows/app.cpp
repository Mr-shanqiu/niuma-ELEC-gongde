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
#include <commdlg.h>
#include <gdiplus.h>
#include <objidl.h>
#include <bcrypt.h>
#include <dwmapi.h>
#pragma comment(lib, "dwmapi.lib")

#include "appearance_pack.h"
#include "render_cache.h"
#include "runtime/input_service.h"
#include "runtime/storage_service.h"
#include "runtime/appearance_service.h"
#include "runtime/client_display.h"
#include "runtime/platform_compat.h"
#include "runtime/embedded_scene.h"
#include "app_version.h"
#include "runtime/legacy_diagnostics.h"
#if defined(NIUMA_SELF_INSTALL)
#include "self_install.h"
#endif
#include "../offwork_clock.h"
#include "../client/core/visibility_state.h"
#include "../calendar_month_range.h"
#include "../reminder_activity.h"
#include "../reminder_geometry.h"
#include "../reminder_policy.h"
#include "../reminder_status.h"
#include "../reminder_store.h"
#include "../reminder_catalog_store.h"
#include "../reminder_catalog_trust.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <ctime>
#include <cstdio>
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
#include <filesystem>
#include "../../scripts/runtime-entry-frame-protocol.h"
#endif
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <iterator>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>
#include "ui_theme.h"

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "comdlg32.lib")

namespace {

constexpr wchar_t kWindowClass[] = L"NiuMaMeritWindow";
constexpr wchar_t kPickerClass[] = L"NiuMaMeritAppearancePicker";
constexpr wchar_t kCalendarClass[] = L"NiuMaMeritCalendar";
constexpr wchar_t kReminderClass[] = L"NiuMaMeritReminder";
constexpr wchar_t kMutexName[] = L"Local\\NiuMaMeritCounter";
constexpr wchar_t kAcceptanceMutexName[] = L"Local\\NiuMaMeritCounter.Acceptance";
#if defined(NIUMA_RUNTIME_CANDIDATE)
constexpr wchar_t kRuntimeWindowClass[] = L"NiuMaMeritWindow.RuntimeCandidate";
constexpr wchar_t kRuntimeMutexName[] = L"Local\\NiuMaMeritCounter.RuntimeCandidate";
constexpr wchar_t kRuntimeProfileMarker[] = L"runtime-candidate.owner";
bool gRuntimeCandidate = false;
#endif

bool IsRuntimeCandidate() {
#if defined(NIUMA_RUNTIME_CANDIDATE)
  return gRuntimeCandidate;
#else
  return false;
#endif
}
// Display selection is independent of private developer profile/entry behavior.
bool UsesCompositionRuntime() {
#if defined(NIUMA_COMPOSITION_RUNTIME)
  return true;
#else
  return IsRuntimeCandidate();
#endif
}
#if defined(NIUMA_SELF_INSTALL)
std::optional<bool> gInstallStartupChoice;
#endif
constexpr wchar_t kRunKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunValue[] = L"NiuMaMerit";
constexpr UINT kCountMessage = WM_APP + 1;
constexpr UINT kScrollMessage = WM_APP + 2;
constexpr UINT kInputSnapshotMessage = WM_APP + 70;
constexpr UINT kAppearanceReadyMessage = WM_APP + 71;
constexpr UINT kDisplayFailureMessage = WM_APP + 72;
constexpr UINT kImportQueuedMessage = WM_APP + 32;
constexpr UINT kTrayMessage = WM_APP + 73;
const UINT kTaskbarCreatedMessage = RegisterWindowMessageW(L"TaskbarCreated");
constexpr ULONG_PTR kPackFileCopyData = 0x4E4D4750;
constexpr UINT_PTR kAnimationTimer = 1;
constexpr UINT_PTR kDayTimer = 2;
constexpr UINT_PTR kOffworkTimer = 3;
constexpr UINT_PTR kReminderTimer = 4;
constexpr UINT_PTR kReminderDismissTimer = 5;
constexpr UINT_PTR kAcceptanceExitTimer = 6;
constexpr UINT_PTR kStorageTimer = 7;
constexpr UINT_PTR kAppearanceTimer = 8;
constexpr UINT_PTR kDisplayRetryTimer = 9;
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
constexpr UINT_PTR kMenuVisibility = 9;
constexpr UINT_PTR kMenuAutoHide = 10;
constexpr wchar_t kCountStatusClass[] = L"NiuMaMeritCountStatus";
constexpr int kStatusText = 4001;
constexpr int kStatusStart = 4002;
constexpr int kStatusRetry = 4003;
constexpr int kStatusClose = 4004;
constexpr int kReminderClose = 4101;

bool IsChineseUi() {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
}

const wchar_t* UiText(const wchar_t* chinese, const wchar_t* english) {
  return IsChineseUi() ? chinese : english;
}

const wchar_t* WindowTitle() {
  if (IsRuntimeCandidate())
    return UiText(L"牛马电子功德 · 测试数据", L"NiuMa Merit · Test Data");
  return UiText(L"牛马电子功德", L"NiuMa Merit");
}

const wchar_t* MainWindowClass() {
#if defined(NIUMA_RUNTIME_CANDIDATE)
  if (gRuntimeCandidate) return kRuntimeWindowClass;
#endif
  return kWindowClass;
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
  std::map<std::wstring, std::uint64_t> pendingDailyTotals;
  ULONGLONG lastInputTime = 0;
  ULONGLONG lastSaveAttempt = 0;
  ULONGLONG lastScrollEventTime = 0;
  double intervalEma = static_cast<double>(kDefaultStrikeMs);
  bool striking = false;
  ULONGLONG strikeStarted = 0;
  int strikeDurationMs = kDefaultStrikeMs;
  bool dirty = false;
  bool timerRunning = false;
  niuma::reminder::ActivitySampler reminderActivity;
  niuma::reminder::WallClockGuard reminderClockGuard;
  bool reminderStorageFault = false;
  enum class ReminderPauseKind { None, Sleep, SessionLock } reminderPauseKind = ReminderPauseKind::None;
  ULONGLONG reminderPauseTick = 0;
  ULONGLONG reminderPauseAwake = 0;
  bool reminderPauseAwakeValid = false;
  std::unique_ptr<niuma::reminder::ReminderStore> reminderStore;
  std::unique_ptr<niuma::reminder::CatalogUpdateStore> catalogStore;
  std::shared_ptr<niuma::reminder::ValidatedCatalog> reminderCatalog;
  bool reminderCatalogCommitUncertain = false;
  MeritScene selectedScene = MeritScene::Woodfish;
  std::string selectedPackId;
};

AppState gState;
niuma::client::core::VisibilityState gVisibility;
bool gVisibilityHidden = false;
NOTIFYICONDATAW gTray{};
HWND gLastFullscreenWindow = nullptr;
void ShowContextMenu(HWND window, POINT screenPoint);
void RenderLayeredWindow(ULONGLONG now);
void ApplyWindowVisibility();
void RefreshFullscreenVisibility();

namespace input_runtime = niuma::windows::runtime;
namespace input_core = niuma::client::core;

// The input thread owns accounting. UI views are coalesced; persistence always
// uses a separate complete ledger, never a total paired with partial dates.
struct InputAdapter {
  std::unique_ptr<input_runtime::InputService> service;
  input_runtime::InputServiceSnapshot latest;
  input_core::InputSnapshot ledger;
  std::vector<input_core::DailyTotal> daily;
  std::map<std::wstring, std::uint64_t> savedDaily;
  std::uint64_t savedTotal = 0;
  std::uint64_t nextCommand = 0, nextLedger = 0;
  std::uint64_t instanceGeneration = 0;
  std::uint64_t ledgerRequest = 0;
  std::uint64_t handledReminder = 0;
  HWND pendingReminderWindow = nullptr;
  std::uint64_t reminderCommand = 0, reminderEpoch = 0, reminderOpportunity = 0;
  ULONGLONG previewUntil = 0;
  bool authoritative = false, loadFailed = false, finalCollected = false;
  bool reminderConsumed = false, controlFault = false;
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
  input_runtime::InputDiagnosticOptions diagnostic;
#endif
};
InputAdapter gInput;

struct DataStorageAdapter {
  std::unique_ptr<input_runtime::StorageService> service;
  std::unique_ptr<input_core::StorageState> model;
  std::shared_ptr<const input_core::StorageWrite> inFlight;
  DWORD error = ERROR_SUCCESS;
  bool mergeFailed = false, timerArmed = false, pumping = false;
  bool closing = false, stopping = false, readyToDestroy = false;
  bool sessionQueryPending = false, sessionResumeInput = false;
  bool closeNoticeShown = false, closeFailurePrompt = false;
  bool failureNotified = false;
  bool wasOffworkSuspended = false;
  UINT_PTR orphanTimer = 0;
  ULONGLONG timerDue = 0, closeStarted = 0;
  std::uint64_t sourceEpoch = 0, sourceInstance = 0, nativeEpoch = 0;
  std::uint64_t mergedVersion = 0, fallbackVersion = 0;
  bool authoritativeSource = false;
};
DataStorageAdapter gDataStorage;

void ConsumeInputSnapshot();
void StopInputService();
void RequestInputLedger();
void CancelPendingReminder();
bool SendInputCommand(input_runtime::InputCommand command);
void RefreshCountingStatus();
void EnsureAnimationTimer();
void ArmDataStorageTimer();
void PumpDataStorage(bool force = false);
bool DataStorageIdle();
void BeginClientClose(HWND window);
void ContinueClientClose(HWND window);
void ShowCountingStatus(HWND owner);
void PumpAppearanceResources();
void QueueVisibleThumbnails();
void CancelAppearanceRequests();
bool StopAppearanceResources();
bool RequestCurrentAppearance(const std::string& id, bool preview = true, bool force = false);

bool KeyboardListenerAvailable() {
  return gInput.authoritative ? gInput.latest.running &&
      gInput.latest.input.keyboardAvailable : gState.keyboardHook != nullptr;
}
bool MouseListenerAvailable() {
  return gInput.authoritative ? gInput.latest.running &&
      gInput.latest.input.mouseAvailable : gState.mouseHook != nullptr;
}
bool ReminderSegmentConsumed() {
  return gInput.authoritative ? gInput.latest.input.reminderSegmentConsumed
      : gState.reminderActivity.segment_consumed();
}
bool ReminderSuspended() {
  return gInput.authoritative ? gInput.latest.input.reminderSuspended
      : gState.reminderActivity.suspended();
}

niuma::render::LayeredSurface gLayeredSurface;
niuma::render::LayeredSurface gArtworkSurface;
struct ArtworkFrameKey {
  const niuma::AppearancePack* pack = nullptr;
  std::uint64_t sourceGeneration = 0;
  MeritScene scene = MeritScene::Woodfish;
  int width = 0, height = 0;
  float progress = 0;
  bool operator==(const ArtworkFrameKey& other) const {
    return pack == other.pack && sourceGeneration == other.sourceGeneration &&
        scene == other.scene && width == other.width && height == other.height &&
        progress == other.progress;
  }
};
ArtworkFrameKey gArtworkKey;
bool gArtworkValid = false;
std::uint64_t gArtworkBuilds = 0, gArtworkHits = 0;
constexpr std::size_t kArtworkByteLimit = 8ULL * 1024 * 1024;
niuma::render::WidgetGlyphCache gWidgetGlyphCache;
std::vector<std::wstring> gPendingImports;
bool gImportReady = false;
bool gImportActive = false;
HWND gReminderWindow = nullptr;
std::wstring gReminderText;
ULONGLONG gReminderDismissAt = 0;
bool gIsolatedAcceptance = false;
bool gReminderPreviewAcceptance = false;
std::wstring gAcceptanceRoot;

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

struct AppearanceAdapter {
  std::unique_ptr<input_runtime::AppearanceService> service;
  std::unique_ptr<niuma::AppearancePack> current;
  niuma::AppearanceThumbnailCache thumbnails{};
  std::unique_ptr<Gdiplus::Bitmap> builtinThumbnail;
  std::optional<input_runtime::AppearanceLoadRequest> currentRequest, thumbnailRequest;
  std::vector<niuma::AppearanceResourceRequest> failedThumbnails;
  std::uint64_t nextRequest = 0, generation = 1;
  float currentDensity = 0;
  bool currentPreview = false, timerArmed = false, stopping = false;
  std::wstring error;
};
AppearanceAdapter gAppearance;

struct DisplayAdapter {
  std::unique_ptr<input_runtime::ClientDisplay> display;
  std::string startupSelection;
  std::uint64_t startupRequest = 0;
  unsigned recoveryAttempts = 0;
  bool failed = false, noticeShown = false;
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
  bool allowSoftwareForTest = false;
  bool layeredForTest = false;
  std::array<double, 1024> frameWorkMs{}, regionWorkMs{};
  std::array<double, 1024> frameWithoutPresentMs{}, drawSubmitMs{}, presentCallMs{};
  std::array<niuma::runtime::PreparedAlphaRegionStats, 1024> regionDetails{};
  std::array<double, 1024> regionInstallMs{};
  std::size_t measuredFrames = 0;
#endif
};
DisplayAdapter gDisplay;

bool SoftwareDisplayForTest() {
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
  // CI explicitly opts into software for functional entry checks. Hardware
  // trials leave this unset; normal/developer binaries do not have this gate.
  wchar_t allowed[2]{};
  if (GetEnvironmentVariableW(L"NIUMA_ENTRY_ALLOW_SOFTWARE",allowed,2)==1 && allowed[0]==L'1')
    return true;
#endif
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
  return gDisplay.allowSoftwareForTest;
#else
  return false;
#endif
}


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
  int selectedDay = 1;
  HFONT font = nullptr;
  niuma::CalendarMonthRange range;
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

std::wstring TrimDirectorySeparators(std::wstring value) {
  while (value.size() > 3 &&
      (value.back() == L'\\' || value.back() == L'/')) value.pop_back();
  return value;
}

bool IsPrivateEmptyAcceptanceDirectory(const std::wstring& requestedPath,
                                       std::wstring* canonicalPath) {
  if (requestedPath.empty() || canonicalPath == nullptr) return false;
  wchar_t tempBuffer[MAX_PATH]{};
  const DWORD tempLength = GetTempPathW(
      static_cast<DWORD>(std::size(tempBuffer)), tempBuffer);
  if (tempLength == 0 || tempLength >= std::size(tempBuffer)) return false;
  wchar_t fullTempBuffer[MAX_PATH]{};
  const DWORD fullTempLength = GetFullPathNameW(tempBuffer,
      static_cast<DWORD>(std::size(fullTempBuffer)), fullTempBuffer, nullptr);
  wchar_t fullRootBuffer[MAX_PATH]{};
  const DWORD fullRootLength = GetFullPathNameW(requestedPath.c_str(),
      static_cast<DWORD>(std::size(fullRootBuffer)), fullRootBuffer, nullptr);
  if (fullTempLength == 0 || fullTempLength >= std::size(fullTempBuffer) ||
      fullRootLength == 0 || fullRootLength >= std::size(fullRootBuffer)) return false;
  const std::wstring tempRoot = TrimDirectorySeparators(fullTempBuffer);
  const std::wstring root = TrimDirectorySeparators(fullRootBuffer);
  if (root.size() <= tempRoot.size() ||
      CompareStringOrdinal(root.c_str(), static_cast<int>(tempRoot.size()),
          tempRoot.c_str(), static_cast<int>(tempRoot.size()), TRUE) != CSTR_EQUAL ||
      (root[tempRoot.size()] != L'\\' && root[tempRoot.size()] != L'/')) return false;
  const DWORD attributes = GetFileAttributesW(root.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  WIN32_FIND_DATAW entry{};
  const std::wstring pattern = root + L"\\*";
  HANDLE find = FindFirstFileW(pattern.c_str(), &entry);
  if (find == INVALID_HANDLE_VALUE) return false;
  bool empty = true;
  do {
    if (wcscmp(entry.cFileName, L".") != 0 && wcscmp(entry.cFileName, L"..") != 0) {
      empty = false;
      break;
    }
  } while (FindNextFileW(find, &entry));
  FindClose(find);
  if (!empty) return false;
  *canonicalPath = root;
  return true;
}

#if defined(NIUMA_RUNTIME_CANDIDATE)
bool RuntimeCanonicalDirectory(const std::wstring& requested, std::wstring* output) {
  if (!output || requested.empty()) return false;
  wchar_t full[MAX_PATH]{};
  const DWORD length = GetFullPathNameW(requested.c_str(), MAX_PATH, full, nullptr);
  if (!length || length >= MAX_PATH) return false;
  const std::wstring path = TrimDirectorySeparators(full);
  // Only local drive paths; inspect every ancestor before resolving aliases.
  if (path.size() < 3 || path[1] != L':' || path[2] != L'\\' ||
      path.find(L':', 2) != std::wstring::npos) return false;
  for (std::size_t end = 3;;) {
    const DWORD attributes = GetFileAttributesW(path.substr(0, end).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    if (end == path.size()) break;
    const auto next = path.find(L'\\', end + 1);
    end = next == std::wstring::npos ? path.size() : next;
  }
  HANDLE directory = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (directory == INVALID_HANDLE_VALUE) return false;
  wchar_t canonical[MAX_PATH + 4]{};
  const DWORD count = GetFinalPathNameByHandleW(directory, canonical,
      static_cast<DWORD>(std::size(canonical)), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(directory);
  if (!count || count >= std::size(canonical) ||
      wcsncmp(canonical, L"\\\\?\\", 4) != 0) return false;
  *output = TrimDirectorySeparators(canonical + 4);
  return output->size() < MAX_PATH;
}

bool RuntimePathWithin(const std::wstring& parent, const std::wstring& path) {
  return path.size() >= parent.size() &&
      CompareStringOrdinal(path.c_str(), static_cast<int>(parent.size()), parent.c_str(),
          static_cast<int>(parent.size()), TRUE) == CSTR_EQUAL &&
      (path.size() == parent.size() || path[parent.size()] == L'\\');
}

bool RuntimeTreeIsPlain(const std::wstring& root, bool* empty) {
  std::vector<std::wstring> directories{root};
  std::size_t entries = 0;
  *empty = true;
  while (!directories.empty()) {
    const auto directory = std::move(directories.back());
    directories.pop_back();
    WIN32_FIND_DATAW item{};
    HANDLE find = FindFirstFileW((directory + L"\\*").c_str(), &item);
    if (find == INVALID_HANDLE_VALUE) return false;
    bool valid = true;
    do {
      if (wcscmp(item.cFileName, L".") == 0 || wcscmp(item.cFileName, L"..") == 0) continue;
      *empty = false;
      if (++entries > 100000 || (item.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        valid = false; break;
      }
      if (item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        directories.push_back(directory + L"\\" + item.cFileName);
    } while (FindNextFileW(find, &item));
    if (valid && GetLastError() != ERROR_NO_MORE_FILES) valid = false;
    FindClose(find);
    if (!valid) return false;
  }
  return true;
}

bool InitializeRuntimeCandidateDirectory(const std::wstring& requested,
                                         std::wstring* output) {
  if (!output) return false;
  std::wstring root, temp, local;
  wchar_t temporary[MAX_PATH]{}, localAppData[MAX_PATH]{};
  const DWORD length = GetTempPathW(MAX_PATH, temporary);
  if (!length || length >= MAX_PATH || !RuntimeCanonicalDirectory(temporary, &temp) ||
      !RuntimeCanonicalDirectory(requested, &root) || root.size() == temp.size() ||
      !RuntimePathWithin(temp, root) ||
      FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr,
          SHGFP_TYPE_CURRENT, localAppData)) ||
      !RuntimeCanonicalDirectory(localAppData, &local) ||
      RuntimePathWithin(local + L"\\NiuMaMerit", root)) return false;
  bool empty = false;
  if (!RuntimeTreeIsPlain(root, &empty)) return false;
  const std::wstring marker = root + L"\\" + kRuntimeProfileMarker;
  const std::wstring prefix = L"\xfeffNIUMA_RUNTIME_CANDIDATE_PROFILE_V1\nroot=" + root + L"\nid=";
  if (empty) {
    BYTE random[16]{};
    if (BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
      return false;
    random[6] = (random[6] & 0x0f) | 0x40;
    random[8] = (random[8] & 0x3f) | 0x80;
    std::wstring identity;
    constexpr wchar_t hex[] = L"0123456789abcdef";
    for (unsigned index = 0; index < sizeof(random); ++index) {
      if (index == 4 || index == 6 || index == 8 || index == 10) identity += L'-';
      identity += hex[random[index] >> 4]; identity += hex[random[index] & 15];
    }
    const std::wstring contents = prefix + identity + L"\n";
    HANDLE file = CreateFileW(marker.c_str(), GENERIC_WRITE, 0, nullptr,
        CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    const DWORD bytes = static_cast<DWORD>(contents.size() * sizeof(wchar_t));
    DWORD written = 0;
    const bool okay = WriteFile(file, contents.data(), bytes, &written, nullptr) &&
        written == bytes && FlushFileBuffers(file);
    CloseHandle(file);
    if (!okay) { DeleteFileW(marker.c_str()); return false; }
  } else {
    HANDLE file = CreateFileW(marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    const auto expected = (prefix.size() + 37) * sizeof(wchar_t);
    if (!GetFileSizeEx(file, &size) || size.QuadPart != static_cast<LONGLONG>(expected)) {
      CloseHandle(file); return false;
    }
    std::wstring contents(prefix.size() + 37, L'\0');
    DWORD read = 0;
    const bool okay = ReadFile(file, contents.data(), static_cast<DWORD>(expected), &read, nullptr) &&
        read == expected;
    CloseHandle(file);
    if (!okay || contents.compare(0, prefix.size(), prefix) != 0 || contents.back() != L'\n')
      return false;
    const auto id = contents.substr(prefix.size(), 36);
    for (unsigned index = 0; index < id.size(); ++index) {
      if (index == 8 || index == 13 || index == 18 || index == 23) {
        if (id[index] != L'-') return false;
      } else if (!((id[index] >= L'0' && id[index] <= L'9') ||
          (id[index] >= L'a' && id[index] <= L'f'))) return false;
    }
    if (id[14] != L'4' || (id[19] != L'8' && id[19] != L'9' && id[19] != L'a' && id[19] != L'b'))
      return false;
  }
  *output = root;
  return true;
}
#endif

bool InitializeAcceptanceMode(bool isolated, bool preview, bool runtimeCandidate,
                              bool automatic, const std::wstring& root) {
  if (runtimeCandidate) {
#if defined(NIUMA_RUNTIME_CANDIDATE)
    if (isolated || preview || automatic ||
        !InitializeRuntimeCandidateDirectory(root, &gAcceptanceRoot)) return false;
    gRuntimeCandidate = true;
    gIsolatedAcceptance = true;
    gReminderPreviewAcceptance = false;
    return true;
#else
    return false;
#endif
  }
#if defined(NIUMA_RUNTIME_CANDIDATE)
  // The separate development binary must never fall through to a real profile.
  return false;
#else
  if (!isolated && !preview && root.empty()) return true;
  if (!isolated || !preview || root.empty() ||
      !IsPrivateEmptyAcceptanceDirectory(root, &gAcceptanceRoot)) return false;
  gIsolatedAcceptance = true;
  gReminderPreviewAcceptance = true;
  return true;
#endif
}

bool InitializeAcceptanceContext() {
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments == nullptr) return false;
  bool isolated = false;
  bool preview = false;
  bool runtimeCandidate = false;
  bool automatic = false;
  for (int index = 1; index < argumentCount; ++index) {
    if (wcscmp(arguments[index], L"--isolated-acceptance") == 0) isolated = true;
    if (wcscmp(arguments[index], L"--reminder-ui-preview") == 0) preview = true;
    if (wcscmp(arguments[index], L"--runtime-candidate") == 0) runtimeCandidate = true;
    if (lstrcmpiW(arguments[index], L"--autostart") == 0) automatic = true;
  }
  LocalFree(arguments);
  wchar_t rootBuffer[MAX_PATH]{};
  const DWORD rootLength = GetEnvironmentVariableW(
      L"NIUMA_ACCEPTANCE_ROOT", rootBuffer,
      static_cast<DWORD>(std::size(rootBuffer)));
  if (rootLength >= std::size(rootBuffer)) return false;
  return InitializeAcceptanceMode(isolated, preview, runtimeCandidate, automatic, rootBuffer);
}

std::wstring DataPath() {
  if (gIsolatedAcceptance) return gAcceptanceRoot + L"\\data.ini";
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

#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
#include "../../scripts/runtime-entry-observation.h"
#endif

std::string ReadSelectedPackId() {
  return gDataStorage.model ? gDataStorage.model->current().appearance.selectedPackId : std::string{};
}

niuma::AppearancePack* CurrentAppearancePack() {
  if (gState.selectedPackId.empty() && gState.selectedScene != MeritScene::Woodfish) {
    gState.selectedScene = MeritScene::Woodfish;
    gState.dirty = true;
  }
  return gAppearance.current.get();
}

std::wstring DateKey(const SYSTEMTIME& date) {
  wchar_t key[16] = {};
  swprintf_s(key, L"%04u-%02u-%02u", date.wYear, date.wMonth, date.wDay);
  return key;
}

std::wstring InputDateKey(input_core::LocalDate date) {
  SYSTEMTIME value{};
  value.wYear = static_cast<WORD>(date / 10000);
  value.wMonth = static_cast<WORD>((date / 100) % 100);
  value.wDay = static_cast<WORD>(date % 100);
  return DateKey(value);
}

input_core::LocalDate ParseInputDate(const std::wstring& key) {
  if (key.size() != 10 || key[4] != L'-' || key[7] != L'-') return 0;
  input_core::LocalDate date = 0;
  for (std::size_t i = 0; i < key.size(); ++i) {
    if (i == 4 || i == 7) continue;
    if (key[i] < L'0' || key[i] > L'9') return 0;
    date = date * 10 + static_cast<unsigned>(key[i] - L'0');
  }
  return input_core::InputCore::ValidDate(date) ? date : 0;
}

bool InitializeDataStorage() {
  if (gDataStorage.service) return gDataStorage.model != nullptr;
  try {
    gDataStorage.service = std::make_unique<input_runtime::StorageService>();
    const auto loaded = gDataStorage.service->Start({DataPath()});
    if (!loaded.started) {
      gDataStorage.error = loaded.error;
      gDataStorage.service->Stop(0);
      return false;
    }
    gDataStorage.model = std::make_unique<input_core::StorageState>(loaded.initial);
    return true;
  } catch (...) {
    gDataStorage.error = ERROR_NOT_ENOUGH_MEMORY;
    if (gDataStorage.service) gDataStorage.service->Stop(0);
    return false;
  }
}

bool MergeDataUpdate(input_core::StorageUpdate update) {
  if (update == input_core::StorageUpdate::Changed || update == input_core::StorageUpdate::Unchanged)
    return true;
  gDataStorage.mergeFailed = true;
  gDataStorage.error = update == input_core::StorageUpdate::CapacityExceeded
      ? ERROR_BUFFER_OVERFLOW : ERROR_INVALID_DATA;
  return false;
}

bool LoadInputLedger(input_runtime::InputServiceOptions& options) {
  if (!gDataStorage.model) return false;
  auto days = gDataStorage.model->current().counts.daily;
  gInput.savedDaily.clear();
  for (const auto& day : days) gInput.savedDaily[InputDateKey(day.first)] = day.second;
  for (const auto& day : gState.pendingDailyTotals) {
    const auto date = ParseInputDate(day.first);
    if (date) days[date] = day.second;
  }
  const auto current = ParseInputDate(gState.currentDay);
  if (current) days[current] = gState.todayTotal;
  if (days.size() >= input_core::InputCore::kMaximumDayCapacity) return false;
  options.total = gState.total;
  gInput.savedTotal = gState.total;
  options.date = input_runtime::InputService::CaptureLocalDate();
  options.daily.clear();
  for (const auto& day : days) options.daily.push_back({day.first, day.second});
  return true;
}

std::uint64_t ReadDailyTotal(const std::wstring& key) {
  if (key == gState.currentDay) return gState.todayTotal;
  const auto pending = gState.pendingDailyTotals.find(key);
  if (pending != gState.pendingDailyTotals.end()) return pending->second;
  const auto date = ParseInputDate(key);
  if (gInput.authoritative) {
    for (const auto& day : gInput.daily) if (day.date == date) return day.total;
    return 0;
  }
  if (!gDataStorage.model) return 0;
  const auto& daily = gDataStorage.model->current().counts.daily;
  const auto found = daily.find(date);
  return found == daily.end() ? 0 : found->second;
}

bool EnsureDay(const std::wstring& today) {
  if (today == gState.currentDay) return false;
  if (!gState.currentDay.empty())
    gState.pendingDailyTotals[gState.currentDay] = gState.todayTotal;
  const auto todayTotal = ReadDailyTotal(today);
  gState.currentDay = today;
  gState.todayTotal = todayTotal;
  return true;
}

bool EnsureCurrentDay() {
  if (gInput.authoritative || gInput.loadFailed) return false;
  SYSTEMTIME now = {};
  GetLocalTime(&now);
  return EnsureDay(DateKey(now));
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
  if (gIsolatedAcceptance) return false;
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
  if (gIsolatedAcceptance) return false;
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
  if (gIsolatedAcceptance || !gDataStorage.model) return;
  MergeDataUpdate(gDataStorage.model->UpdateAutostart({true, enabled}, GetTickCount64()));
  PumpDataStorage();
}

void ConfigureLaunchAtLogin() {
  if (gIsolatedAcceptance || !gDataStorage.model) return;
  const auto preference = gDataStorage.model->current().autostart;
  if (!preference.configured) {
    if (SetLaunchAtLoginEnabled(true)) SaveLaunchAtLoginPreference(true);
  } else if (preference.enabled) {
    SetLaunchAtLoginEnabled(true);
  }
}

long ReadIniLong(const wchar_t* key, long fallback) {
  if (!gDataStorage.model) return fallback;
  const auto& state = gDataStorage.model->current();
  if (wcscmp(key, L"selected_scene") == 0) return state.appearance.selectedScene;
  if (wcscmp(key, L"x") == 0 && state.window.present) return state.window.x;
  if (wcscmp(key, L"y") == 0 && state.window.present) return state.window.y;
  return fallback;
}

std::uint64_t ReadIniTotal() {
  return gDataStorage.model ? gDataStorage.model->current().counts.total : 0;
}

void LoadOffworkSettings() {
  if (gDataStorage.model) {
    const auto& state = gDataStorage.model->current();
    gOffwork.enabled = state.offwork.enabled;
    gOffwork.hour = state.offwork.hour;
    gOffwork.minute = state.offwork.minute;
    gOffwork.days.clear();
    for (const auto& entry : state.offworkDays) {
      const auto& day = entry.second;
      gOffwork.days.emplace(InputDateKey(entry.first), OffworkDayRecord{
          day.present, false, day.seconds, day.targetMinutes, static_cast<std::time_t>(day.updatedAt)});
    }
  }
  gOffwork.lastFlush = GetTickCount64();
}

OffworkDayRecord& OffworkDay(const std::wstring& key) {
  return gOffwork.days.try_emplace(key).first->second;
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
  if (gDataStorage.model) {
    try {
      record.dirty = !MergeDataUpdate(gDataStorage.model->UpdateOffworkDay(
          ParseInputDate(OffworkWide(snapshot.dayKey)),
          {present, seconds, snapshot.targetMinutes, static_cast<std::int64_t>(updatedAt)}, GetTickCount64()));
    } catch (...) {
      gDataStorage.mergeFailed = true;
      gDataStorage.error = ERROR_NOT_ENOUGH_MEMORY;
    }
    ArmDataStorageTimer();
  }
}

bool FlushOffwork() {
  if (!gDataStorage.model) return false;
  bool accepted = true;
  const auto now = GetTickCount64();
  try {
    if (gOffwork.settingsDirty) {
      const bool merged = MergeDataUpdate(gDataStorage.model->UpdateOffworkSettings(
          {gOffwork.enabled, gOffwork.hour, gOffwork.minute}, now));
      gOffwork.settingsDirty = !merged;
      accepted = merged;
    }
    for (auto& entry : gOffwork.days) {
      auto& record = entry.second;
      if (!record.dirty) continue;
      const bool merged = MergeDataUpdate(gDataStorage.model->UpdateOffworkDay(ParseInputDate(entry.first),
          {record.present, record.seconds, record.targetMinutes, static_cast<std::int64_t>(record.updatedAt)}, now));
      record.dirty = !merged;
      accepted = merged && accepted;
    }
  } catch (...) {
    gDataStorage.mergeFailed = true;
    gDataStorage.error = ERROR_NOT_ENOUGH_MEMORY;
    accepted = false;
  }
  gOffwork.lastFlush = now;
  // Accepted means merged into the retained latest model, not already durable.
  // Only the worker's completion can acknowledge its versions.
  PumpDataStorage();
  return accepted;
}

bool OffworkAwakeTime(ULONGLONG& value) {
  using QueryFn = BOOL(WINAPI*)(PULONGLONG);
  static const auto query = reinterpret_cast<QueryFn>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "QueryUnbiasedInterruptTime"));
  return query && query(&value);
}

void CancelPendingReminder() {
  const HWND popup = gInput.pendingReminderWindow;
  gInput.pendingReminderWindow = nullptr;
  gInput.reminderCommand = gInput.reminderEpoch = gInput.reminderOpportunity = 0;
  if (popup) DestroyWindow(popup);
  if (!gReminderWindow) gReminderText.clear();
}

bool SendInputCommand(input_runtime::InputCommand command) {
  if (!command.id) command.id = ++gInput.nextCommand;
  if (gInput.service && gInput.service->PostCommand(command)) return true;
  // A rejected lifecycle command is not silently treated as applied. Counting
  // can continue, but reminders stay suppressed until an explicit restart.
  gInput.controlFault = true;
  gCountingCheck.deliveryFault = true;
  CancelPendingReminder();
  return false;
}

void ResetInputReminderObservation() {
  CancelPendingReminder();
  if (gInput.authoritative) {
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::ResetReminderObservation;
    SendInputCommand(command);
  } else {
    gState.reminderActivity.ResetForListenerRestart();
  }
}

void SyncInputClockGuard() {
  if (!gInput.authoritative) return;
  CancelPendingReminder();
  input_runtime::InputCommand command;
  command.kind = input_runtime::InputCommandKind::SetClockGuard;
  command.enabled = gState.reminderClockGuard.guarded();
  SendInputCommand(command);
}

void PersistReminderUnlockIfNeeded(bool wasConsumed) {
  if (!wasConsumed || ReminderSegmentConsumed()) return;
  const auto result = gState.reminderStore
      ? gState.reminderStore->SetSegmentConsumed(false,
          static_cast<std::int64_t>(std::time(nullptr)))
      : niuma::reminder::StoreResult::IoError;
  if (result != niuma::reminder::StoreResult::Success) {
    gState.reminderStorageFault = true;
    if (gInput.authoritative) {
      if (gInput.service && gInput.service->running()) {
        input_runtime::InputCommand command;
        command.kind = input_runtime::InputCommandKind::RestoreReminderSegmentConsumed;
        command.expectedEpoch = gInput.latest.input.epoch;
        command.enabled = true;
        SendInputCommand(command);
      } else {
        // Retain the durable conservative value if restart follows teardown.
        gInput.reminderConsumed = true;
        gInput.latest.input.reminderSegmentConsumed = true;
      }
    } else gState.reminderActivity.RestoreSegmentConsumed(true);
  } else {
    gState.reminderStorageFault = false;
  }
}

void BeginReminderPause(AppState::ReminderPauseKind kind) {
  if (gState.reminderPauseKind != AppState::ReminderPauseKind::None) return;
  CancelPendingReminder();
  gState.reminderPauseKind = kind;
  gState.reminderPauseTick = GetTickCount64();
  gState.reminderPauseAwakeValid = OffworkAwakeTime(gState.reminderPauseAwake);
  if (gInput.authoritative) {
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::BeginSuspend;
    SendInputCommand(command);
  } else gState.reminderActivity.BeginSuspend(gState.reminderPauseTick);
}

void ResumeReminderPause(bool fromSystemSleep) {
  const ULONGLONG now = GetTickCount64();
  const bool paired = gState.reminderPauseKind != AppState::ReminderPauseKind::None;
  bool durationTrusted = false;
  ULONGLONG inactiveDuration = 0;
  if (paired && now >= gState.reminderPauseTick) {
    const ULONGLONG elapsed = now - gState.reminderPauseTick;
    if (gState.reminderPauseKind == AppState::ReminderPauseKind::SessionLock) {
      durationTrusted = true;
      inactiveDuration = elapsed;
    } else if (fromSystemSleep && gState.reminderPauseKind == AppState::ReminderPauseKind::Sleep) {
      ULONGLONG awakeNow = 0;
      if (gState.reminderPauseAwakeValid && OffworkAwakeTime(awakeNow) &&
          awakeNow >= gState.reminderPauseAwake) {
        durationTrusted = niuma::reminder::EstimateSleepDurationMs(elapsed,
            awakeNow - gState.reminderPauseAwake, true, &inactiveDuration);
      }
    }
  }
  CancelPendingReminder();
  if (gInput.authoritative) {
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::ResumeFromSuspend;
    command.pairedSignal = paired;
    command.durationTrusted = durationTrusted;
    command.inactiveDurationMs = inactiveDuration;
    SendInputCommand(command);
  } else {
    const bool wasConsumed = gState.reminderActivity.segment_consumed();
    gState.reminderActivity.ResumeFromSuspend(now, paired, durationTrusted, inactiveDuration);
    PersistReminderUnlockIfNeeded(wasConsumed);
  }
  gState.reminderPauseKind = AppState::ReminderPauseKind::None;
  gState.reminderPauseTick = 0;
  gState.reminderPauseAwake = 0;
  gState.reminderPauseAwakeValid = false;
}

void InterruptReminderObservation() {
  if (gState.reminderPauseKind != AppState::ReminderPauseKind::None) return;
  CancelPendingReminder();
  if (gInput.authoritative) {
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::ResumeFromSuspend;
    SendInputCommand(command);
  } else {
    const bool wasConsumed = gState.reminderActivity.segment_consumed();
    gState.reminderActivity.ResumeFromSuspend(GetTickCount64(), false, false, 0);
    PersistReminderUnlockIfNeeded(wasConsumed);
  }
  gState.reminderPauseKind = AppState::ReminderPauseKind::None;
  gState.reminderPauseTick = 0;
  gState.reminderPauseAwake = 0;
  gState.reminderPauseAwakeValid = false;
}

std::string CurrentReminderLocalDate() {
  SYSTEMTIME local{};
  GetLocalTime(&local);
  char date[16]{};
  std::snprintf(date, sizeof(date), "%04u-%02u-%02u",
      local.wYear, local.wMonth, local.wDay);
  return date;
}

void NotifyReminderClockChange() {
  const auto nowUtc = static_cast<std::int64_t>(std::time(nullptr));
  const ULONGLONG nowMs = GetTickCount64();
  const auto transition = gState.reminderClockGuard.NotifyClockChange(nowUtc, nowMs);
  if (transition == niuma::reminder::WallClockGuard::Transition::Guarded &&
      gState.reminderStore) {
    if (gState.reminderStore->SetClockGuard(true, nowUtc,
            CurrentReminderLocalDate().c_str()) !=
        niuma::reminder::StoreResult::Success) gState.reminderStorageFault = true;
  }
  ResetInputReminderObservation();
  SyncInputClockGuard();
}

void ApplyReminderClockTransition(niuma::reminder::WallClockGuard::Transition transition,
                                  std::int64_t nowUtc) {
  if (transition == niuma::reminder::WallClockGuard::Transition::Guarded) {
    if (gState.reminderStore && gState.reminderStore->SetClockGuard(true, nowUtc,
            CurrentReminderLocalDate().c_str()) !=
        niuma::reminder::StoreResult::Success) {
      gState.reminderStorageFault = true;
    }
    ResetInputReminderObservation();
    SyncInputClockGuard();
  } else if (transition == niuma::reminder::WallClockGuard::Transition::Recovered) {
    const auto result = gState.reminderStore
        ? gState.reminderStore->SetClockGuard(false, nowUtc,
            CurrentReminderLocalDate().c_str())
        : niuma::reminder::StoreResult::Success;
    if (result != niuma::reminder::StoreResult::Success) {
      gState.reminderStorageFault = true;
      gState.reminderClockGuard.RestoreGuard();
    } else {
      gState.reminderStorageFault = false;
    }
    SyncInputClockGuard();
  }
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

bool SaveCountState(const std::wstring&) {
  if (!gDataStorage.model || gInput.loadFailed) return false;
  const auto now = GetTickCount64();
  input_core::LedgerSnapshotResult ledger;
  ledger.header.status = input_core::LedgerResultStatus::Complete;
  if (gInput.authoritative) {
    if (!gInput.ledger.ready) { RequestInputLedger(); return false; }
    const bool newSource = !gDataStorage.authoritativeSource ||
        gDataStorage.sourceInstance != gInput.instanceGeneration ||
        gDataStorage.nativeEpoch != gInput.ledger.epoch;
    if (newSource) {
      if (gDataStorage.sourceEpoch == std::numeric_limits<std::uint64_t>::max()) return false;
      ++gDataStorage.sourceEpoch;
      gDataStorage.sourceInstance = gInput.instanceGeneration;
      gDataStorage.nativeEpoch = gInput.ledger.epoch;
      gDataStorage.authoritativeSource = true;
      gDataStorage.mergedVersion = 0;
    }
    if (gDataStorage.mergedVersion != gInput.ledger.version) {
      ledger.header.input = gInput.ledger;
      // A restarted InputService begins at epoch 1. Preserve monotonic source
      // identity for StorageState across complete service replacements too.
      ledger.header.input.epoch = gDataStorage.sourceEpoch;
      ledger.daily = gInput.daily;
      ledger.header.dailyCount = ledger.daily.size();
      if (!MergeDataUpdate(gDataStorage.model->UpdateCounts(ledger, now))) {
        RequestInputLedger();
        return false;
      }
      gDataStorage.mergedVersion = gInput.ledger.version;
    }
    const bool caughtUp = gInput.finalCollected ||
        (gInput.ledger.countedOperations == gInput.latest.input.countedOperations &&
         gInput.ledger.total == gInput.latest.input.total &&
         gInput.ledger.today == gInput.latest.input.today &&
         gInput.ledger.date == gInput.latest.input.date);
    if (!caughtUp) RequestInputLedger();
    return caughtUp;
  }
  const auto date = ParseInputDate(gState.currentDay);
  if (!date) return true;  // Startup has not selected a local day yet.
  auto days = gDataStorage.model->current().counts.daily;
  for (const auto& entry : gState.pendingDailyTotals) {
    const auto day = ParseInputDate(entry.first);
    if (day) days[day] = entry.second;
  }
  days[date] = gState.todayTotal;
  if (!gDataStorage.sourceEpoch) ++gDataStorage.sourceEpoch;
  ledger.header.input.ready = true;
  ledger.header.input.epoch = gDataStorage.sourceEpoch;
  ledger.header.input.version = ++gDataStorage.fallbackVersion;
  ledger.header.input.total = gState.total;
  ledger.header.input.today = gState.todayTotal;
  ledger.header.input.date = date;
  ledger.header.input.lastInputMs = gState.lastInputTime;
  for (const auto& day : days) ledger.daily.push_back({day.first, day.second});
  ledger.header.dailyCount = ledger.daily.size();
  if (!MergeDataUpdate(gDataStorage.model->UpdateCounts(ledger, now))) return false;
  gState.pendingDailyTotals.clear();
  return true;
}

void CaptureDataState() {
  if (!gDataStorage.model || gDataStorage.stopping) return;
  gDataStorage.mergeFailed = false;
  const auto now = GetTickCount64();
  bool accepted = SaveCountState({});
  RECT rect{};
  if (gState.window && GetWindowRect(gState.window, &rect))
    accepted = MergeDataUpdate(gDataStorage.model->UpdateWindow({true, rect.left, rect.top}, now)) && accepted;
  accepted = MergeDataUpdate(gDataStorage.model->UpdateAppearance(
      {static_cast<int>(gState.selectedScene), gState.selectedPackId}, now)) && accepted;
  gState.dirty = !accepted;
}

void ApplyDataStorageResult(const input_runtime::StorageFileResult& result) {
  if (!gDataStorage.model || !gDataStorage.inFlight || gDataStorage.inFlight->id != result.id) return;
  if (!gDataStorage.model->CompleteWrite(result.id, result.success, GetTickCount64())) return;
  gDataStorage.inFlight.reset();
  gDataStorage.error = result.success ? ERROR_SUCCESS : result.error;
  if (result.success) gDataStorage.failureNotified = false;
  else if (!gDataStorage.closing && !gDataStorage.failureNotified && gState.window) {
    gDataStorage.failureNotified = true;
    ShowCountingStatus(gState.window);
  }
  RefreshCountingStatus();
}

void ArmDataStorageTimer() {
  if (!gState.window || !gDataStorage.model || gDataStorage.readyToDestroy) return;
  const auto now = GetTickCount64();
  auto due = gDataStorage.model->NextWriteDue();
  if (gDataStorage.closing || gDataStorage.stopping || gDataStorage.model->in_flight())
    due = std::min(due, now + 100);
  if (gState.dirty || gOffwork.settingsDirty || gDataStorage.mergeFailed)
    due = std::min(due, now + 500);
  if (due == std::numeric_limits<std::uint64_t>::max()) {
    if (gDataStorage.timerArmed) KillTimer(gState.window, kStorageTimer);
    gDataStorage.timerArmed = false;
    return;
  }
  due = std::max(due, now + 1);
  if (gDataStorage.timerArmed && gDataStorage.timerDue <= due) return;
  const auto delay = static_cast<UINT>(std::min<ULONGLONG>(due - now, 30000));
  gDataStorage.timerArmed = SetTimer(gState.window, kStorageTimer, std::max<UINT>(1, delay), nullptr) != 0;
  gDataStorage.timerDue = due;
  if (!gDataStorage.timerArmed) gDataStorage.error = ERROR_NOT_ENOUGH_MEMORY;
}

void PumpDataStorage(bool force) {
  if (!gDataStorage.model || !gDataStorage.service || gDataStorage.pumping || gDataStorage.stopping) return;
  gDataStorage.pumping = true;
  try {
    input_runtime::StorageFileResult result;
    if (gDataStorage.service->TryConsumeResult(result)) ApplyDataStorageResult(result);
    if (gOffwork.settingsDirty || std::any_of(gOffwork.days.begin(), gOffwork.days.end(),
        [](const auto& day) { return day.second.dirty; })) FlushOffwork();
    if (gState.dirty || force) CaptureDataState();
    auto write = gDataStorage.model->BeginWrite(GetTickCount64(), force);
    if (write) {
      const auto submitted = gDataStorage.service->TrySubmit(write);
      if (submitted == input_runtime::StorageSubmit::Accepted) gDataStorage.inFlight = std::move(write);
      else {
        // The request was never accepted. This is distinct from timing out an
        // accepted writer, which must stay in flight until its real completion.
        gDataStorage.model->CompleteWrite(write->id, false, GetTickCount64());
        gDataStorage.error = ERROR_INVALID_STATE;
      }
    }
  } catch (...) {
    gDataStorage.mergeFailed = true;
    gDataStorage.error = ERROR_NOT_ENOUGH_MEMORY;
  }
  gDataStorage.pumping = false;
  ArmDataStorageTimer();
}

bool DataStorageIdle() {
  if (!gDataStorage.model) return false;
  return !gState.dirty && !gDataStorage.model->dirty() && !gDataStorage.model->in_flight() &&
      !gDataStorage.mergeFailed && !gOffwork.settingsDirty &&
      std::none_of(gOffwork.days.begin(), gOffwork.days.end(), [](const auto& day) { return day.second.dirty; });
}

void SaveState() {
  gState.dirty = true;
  PumpDataStorage();
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
  if (gDisplay.display) gDisplay.display->Shutdown();
  gDisplay.display.reset();

  // Normal exit has already joined the worker. No GDI+ object may outlive
  // GdiplusShutdown, including the detached current pack and picker cache.
  gAppearance.current.reset();
  gAppearance.thumbnails.Clear();
  gAppearance.builtinThumbnail.reset();
  gAppearance.service.reset();
  niuma::ClearAppearanceRenderCache();
  gWidgetGlyphCache.Clear();
  gLayeredSurface.Reset();
  gArtworkSurface.Reset();
  gArtworkValid = false;
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

void DrawWidgetText(Gdiplus::Graphics& graphics,
                    const std::wstring& text,
                    const Gdiplus::RectF& rect,
                    float fontSize,
                    const Gdiplus::Color& color,
                    Gdiplus::FontStyle style = Gdiplus::FontStyleRegular) {
  const auto* glyphs = gWidgetGlyphCache.Get(text, rect, fontSize, style);
  if (!glyphs) return;
  // Outline glyphs only; the surrounding layered surface stays transparent.
  Gdiplus::Pen outline(Gdiplus::Color(190, 24, 24, 24), 1.5f);
  outline.SetLineJoin(Gdiplus::LineJoinRound);
  graphics.DrawPath(&outline, glyphs);
  Gdiplus::SolidBrush fill(color);
  graphics.FillPath(&fill, glyphs);
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

  // Mirror the accepted Mac woodfish geometry into the top-left coordinate
  // system: y = 250 - macY. Keep artwork below the independent +1 band.
  const GraphicsState woodfishState = graphics.Save();
  graphics.SetClip(RectF(0.0f, 80.0f, 240.0f, 170.0f), Gdiplus::CombineModeIntersect);
  graphics.TranslateTransform(120.0f, 250.0f);
  graphics.ScaleTransform(0.88f, 0.88f);
  graphics.TranslateTransform(-120.0f, -250.0f);
  Gdiplus::SolidBrush shadow(Gdiplus::Color(64, 0, 0, 0));
  graphics.FillEllipse(&shadow, 40.0f, 231.0f, 160.0f, 16.0f);
  graphics.DrawImage(gFish.image.get(), RectF(26.0f, 121.0f, 214.0f, 129.0f));

  const GraphicsState malletState = graphics.Save();
  graphics.TranslateTransform(417.0f, 70.0f);
  graphics.RotateTransform(-(3.0f + 2.2f * strikeAmount));
  const float sourceWidth = static_cast<float>(gMallet.image->GetWidth());
  const float sourceHeight = static_cast<float>(gMallet.image->GetHeight());
  // Extend the shaft separately so the round head keeps the Mac proportions.
  graphics.DrawImage(gMallet.image.get(), RectF(-260.0f, -28.0f, 266.0f, 54.0f),
      108.0f, 0.0f, std::max(1.0f, sourceWidth - 108.0f), sourceHeight, Gdiplus::UnitPixel);
  graphics.DrawImage(gMallet.image.get(), RectF(-309.0f, -27.0f, 60.0f, 54.0f),
      0.0f, 0.0f, std::min(145.0f, sourceWidth), sourceHeight, Gdiplus::UnitPixel);
  graphics.Restore(malletState);
  graphics.Restore(woodfishState);
}

void DrawScene(Gdiplus::Graphics& graphics, ULONGLONG now,
    bool artworkOnly = false, bool omitArtwork = false) {
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
  if (!omitArtwork) {
  if (appearancePack != nullptr) {
    niuma::DrawAppearancePack(graphics, *appearancePack, progress);
  } else {
    DrawSceneArtwork(graphics, gState.selectedScene, strikeAmount);
  }

  }
  if (artworkOnly) return;

  // Draw the middle band last so the mallet can never cover it.
  if (gState.striking && progress >= kPlusStartPhase &&
      progress <= kPlusEndPhase) {
    DrawCenteredText(
        graphics, L"+1",
        Gdiplus::RectF(
            0.0f,
            appearancePack != nullptr
                ? 250.0f - static_cast<float>(appearancePack->plusY) - 30.0f
                : (gState.selectedScene == MeritScene::Woodfish ? 46.0f : 43.0f),
            240.0f, 30.0f),
        22.0f, 255);
  }

  const std::wstring totalText = std::to_wstring(gState.todayTotal);
  float totalFont = totalText.size() > 24 ? 18.0f :
                    totalText.size() > 18 ? 22.0f : 26.0f;
  DrawWidgetText(graphics, totalText,
                 Gdiplus::RectF(0.0f, 0.0f, 240.0f, 40.0f), totalFont,
                 Gdiplus::Color(255, 240, 139, 35));
}

void FailCompositionDisplay() {
  if (gDisplay.failed || !gState.window || gDataStorage.closing) return;
  gDisplay.failed = true;
  // A failed GPU submission must not leave a stale/inconsistent hit region
  // intercepting the desktop. Accounting continues on its independent owner.
  ShowWindow(gState.window, SW_HIDE);
  if (gDisplay.recoveryAttempts < 3) {
    const UINT delay = 500u << gDisplay.recoveryAttempts;
    if (SetTimer(gState.window, kDisplayRetryTimer, delay, nullptr)) return;
  }
  if (!gDisplay.noticeShown) PostMessageW(gState.window, kDisplayFailureMessage, 0, 0);
}

bool LayeredDisplayForTest() {
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
  return gDisplay.layeredForTest;
#else
  return false;
#endif
}

bool EnsureCompositionDisplay() {
  if (gDisplay.failed) return false;
  if (gDisplay.display && gDisplay.display->ready()) return true;
  if (!gDisplay.display) gDisplay.display = std::make_unique<input_runtime::ClientDisplay>();
  if (gDisplay.display->Initialize(gState.window, gState.windowWidth, gState.windowHeight,
      SoftwareDisplayForTest(), LayeredDisplayForTest())) return true;
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
  const auto& adapter=gDisplay.display->Adapter();
  niuma::legacy_diag::Context adapterContext;
  adapterContext.vendorId=adapter.vendorId;adapterContext.deviceId=adapter.deviceId;adapterContext.featureLevel=adapter.featureLevel;
  niuma::legacy_diag::Failure("adapter","HardwareCreateResult",adapter.hardwareCreateResult,adapterContext,
      "adapter state at initialization failure; hr is hardwareCreateResult");
  niuma::legacy_diag::Failure("display","Initialize",
      gDisplay.display->DiagnosticLastError(),{},gDisplay.display->LastErrorMessage().c_str());
#endif
  FailCompositionDisplay();
  return false;
}

void RenderCompositionWindow(ULONGLONG now) {
  if (gVisibility.hidden()) return;
  try {
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
    const auto entryFrameStarted = std::chrono::steady_clock::now();
#endif
    if (!EnsureCompositionDisplay()) return;
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
    const auto started = std::chrono::steady_clock::now();
#endif
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS) || defined(NIUMA_RUNTIME_ENTRY_PROBE)
    const auto before = gDisplay.display->Stats().framesPresented;
#endif
    input_runtime::ClientDisplayState view;
    view.action = {gState.striking, gInput.authoritative ? gInput.latest.input.actionSerial : 0,
        gState.strikeStarted, static_cast<std::uint32_t>(std::max(1, gState.strikeDurationMs))};
    view.text.merit = std::to_wstring(gState.todayTotal);
    view.text.pixelScale = static_cast<float>(gState.windowWidth) / kDesignWidth;
    view.text.countdownVisible = gOffwork.enabled;
    if (gOffwork.enabled) {
      const auto& clock = gOffwork.snapshot;
      view.text.countdownLabel = !clock.valid ? UiText(L"时间不可用", L"Time unavailable") :
          clock.overtime ? UiText(L"已加班", L"Overtime") : UiText(L"距下班", L"Until off work");
      view.text.countdownDuration = clock.valid ? OffworkTimeText(clock.overtime
          ? clock.overtimeSeconds : clock.remainingSeconds) : L"--:--:--";
    }
    if (!gDisplay.display->DrawLatest(view, now, gState.windowWidth, gState.windowHeight)) {
      FailCompositionDisplay(); return;
    }
    gDisplay.recoveryAttempts = 0;
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
    CaptureRuntimeEntryFrame(entryFrameStarted, before);
    WriteRuntimeEntryObservation();
#endif
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
    if (gDisplay.display->Stats().framesPresented != before &&
        gDisplay.measuredFrames < gDisplay.frameWorkMs.size()) {
      const auto index = gDisplay.measuredFrames++;
      gDisplay.frameWorkMs[index] = std::chrono::duration<double,std::milli>(
          std::chrono::steady_clock::now()-started).count();
      gDisplay.regionWorkMs[index] = gDisplay.display->Stats().lastRegionMs;
      const auto& times = gDisplay.display->Stats();
      gDisplay.regionDetails[index] = times.lastRegionDetails;
      gDisplay.regionInstallMs[index] = times.lastRegionInstallWallMs;
      gDisplay.presentCallMs[index] = times.lastPresentWallMs;
      gDisplay.drawSubmitMs[index] = times.lastDrawSubmitWallMs;
      gDisplay.frameWithoutPresentMs[index] = std::max(0.0,
          gDisplay.frameWorkMs[index] - times.lastPresentWallMs - times.lastReadbackWallMs);
    }
#endif
  } catch (...) { FailCompositionDisplay(); }
}

void RetryCompositionDisplay() {
  if (!UsesCompositionRuntime() || !gState.window || gDataStorage.closing) return;
  KillTimer(gState.window, kDisplayRetryTimer);
  if (gDisplay.recoveryAttempts >= 3) return;
  ++gDisplay.recoveryAttempts;
  gDisplay.failed = false;
  try {
    if (gDisplay.display && !gDisplay.display->RecreateDevice()) {
      FailCompositionDisplay(); return;
    }
    RenderCompositionWindow(GetTickCount64());
    if (!gDisplay.failed && !gVisibility.hidden()) ShowWindow(gState.window, SW_SHOWNOACTIVATE);
  } catch (...) { FailCompositionDisplay(); }
}

void RenderLayeredWindow(ULONGLONG now) {
  if (gVisibility.hidden()) return;
  if (UsesCompositionRuntime()) {
    if (gState.window) RenderCompositionWindow(now);
    return;
  }

  if (gState.window == nullptr || !gFish.image || !gMallet.image) {
    return;
  }

  HDC screen = GetDC(nullptr);
  if (screen == nullptr) {
    return;
  }
  if (!gLayeredSurface.Ensure(screen, gState.windowWidth, gState.windowHeight)) {
    ReleaseDC(nullptr, screen);
    return;
  }
  HDC memoryDc = gLayeredSurface.dc();
  // Keep only the latest exact artwork pose. Text/clock changes reuse it;
  // animated poses are never quantized and no animation frame queue is retained.
  ArtworkFrameKey key;
  key.pack = CurrentAppearancePack();
  key.sourceGeneration = niuma::AppearanceRenderGeneration();
  key.scene = gState.selectedScene;
  key.width = gState.windowWidth;
  key.height = gState.windowHeight;
  if (gState.striking) key.progress = std::clamp(
      static_cast<float>(now - gState.strikeStarted) / gState.strikeDurationMs, 0.0f, 1.0f);
  bool reusedArtwork = false;
  if (gLayeredSurface.bytes() <= kArtworkByteLimit &&
      gArtworkSurface.Ensure(screen, key.width, key.height)) {
    if (!gArtworkValid || !(key == gArtworkKey)) {
      gArtworkSurface.Clear();
      {
        Gdiplus::Graphics artwork(gArtworkSurface.dc());
        artwork.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
        const float scale = static_cast<float>(key.width) / kDesignWidth;
        artwork.ScaleTransform(scale, scale);
        DrawScene(artwork, now, true);
      }
      gArtworkKey = key;
      gArtworkValid = true;
      ++gArtworkBuilds;
    } else ++gArtworkHits;
    std::memcpy(gLayeredSurface.pixels(), gArtworkSurface.pixels(), gLayeredSurface.bytes());
    reusedArtwork = true;
  } else {
    gArtworkSurface.Reset();
    gArtworkValid = false;
    gLayeredSurface.Clear();
  }

  {
    Gdiplus::Graphics graphics(memoryDc);
    graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
    const float scale =
        static_cast<float>(gState.windowWidth) /
        static_cast<float>(kDesignWidth);
    graphics.ScaleTransform(scale, scale);
    DrawScene(graphics, now, false, reusedArtwork);
    if (gOffwork.enabled) {
      // Match the merit text without painting a panel over the desktop.
      const auto& snapshot = gOffwork.snapshot;
      const wchar_t* label = !snapshot.valid ? UiText(L"时间不可用", L"Time unavailable") :
          snapshot.overtime ? UiText(L"已加班", L"Overtime") : UiText(L"距下班", L"Until off work");
      const std::wstring duration = snapshot.valid ? OffworkTimeText(snapshot.overtime
          ? snapshot.overtimeSeconds : snapshot.remainingSeconds) : L"--:--:--";
      DrawWidgetText(graphics, label, Gdiplus::RectF(12, 258, 216, 28),
                     20.0f, Gdiplus::Color(255, 248, 244, 235),
                     Gdiplus::FontStyleRegular);
      // Fixed character cells keep every digit in place without a second font.
      const float cellWidth = 17.0f;
      const float durationLeft =
          (240.0f - cellWidth * static_cast<float>(duration.size())) / 2.0f;
      for (size_t index = 0; index < duration.size(); ++index) {
        DrawWidgetText(graphics, std::wstring(1, duration[index]),
            Gdiplus::RectF(durationLeft + cellWidth * static_cast<float>(index),
                          286, cellWidth, 42),
            24.0f, Gdiplus::Color(255, 240, 139, 35));
      }
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

  ReleaseDC(nullptr, screen);
}

bool SameAppearanceSource(const niuma::AppearanceResourceRequest& left,
                          const niuma::AppearanceResourceRequest& right) {
  return left.id == right.id && left.sourcePath == right.sourcePath &&
      left.contentFingerprint == right.contentFingerprint;
}

bool CatalogStillMatches(const niuma::AppearanceResourceRequest& source) {
  const auto* metadata = gAppearanceCatalog.Find(source.id);
  return metadata && metadata->sourcePath == source.sourcePath &&
      metadata->contentFingerprint == source.contentFingerprint;
}

void ArmAppearanceTimer() {
  if (!gState.window || !gAppearance.service) return;
  const auto state = gAppearance.service->Snapshot();
  const bool work = state.activeId || state.pendingId || state.readyId ||
      (gAppearance.stopping && !state.stopped);
  if (!work) {
    if (gAppearance.timerArmed) KillTimer(gState.window, kAppearanceTimer);
    gAppearance.timerArmed = false;
  } else if (!gAppearance.timerArmed) {
    gAppearance.timerArmed = SetTimer(gState.window, kAppearanceTimer, 100, nullptr) != 0;
  }
}

void ReportAppearanceFailure(const std::wstring& detail) {
  gAppearance.error = detail.empty()
      ? UiText(L"形象未能准备完成，原有形象保持不变。请重新选择或导入原包。",
               L"The appearance could not be prepared. The previous appearance is unchanged; select it again or import the original pack.")
      : detail;
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
  const auto diagnostic=niuma::legacy_diag::TakeNotice();
  static unsigned lastNotice=0;
  if(diagnostic && diagnostic==lastNotice) return;
  if(diagnostic) {
    lastNotice=diagnostic;
    gAppearance.error+=L" [D"+std::to_wstring(diagnostic)+L"]";
  }
#endif
  if (gState.window && (!gIsolatedAcceptance || IsRuntimeCandidate()) && !SoftwareDisplayForTest())
    niuma::ui::Message(gState.window, gAppearance.error.c_str(),
        UiText(L"形象未切换", L"Appearance Unchanged"), MB_OK | MB_ICONWARNING);
}

bool InitializeAppearanceResources() {
  if (gAppearance.service) return !gAppearance.stopping;
  gAppearance.service = std::make_unique<input_runtime::AppearanceService>();
  const auto started = gAppearance.service->Start({gState.window, kAppearanceReadyMessage});
  if (started.started) return true;
  gAppearance.service.reset();
  ReportAppearanceFailure(UiText(L"后台形象准备未能启动，内置木鱼仍可使用。请关闭后重新打开程序。",
      L"Background appearance preparation could not start. The built-in woodfish remains available; restart the app to retry."));
  return false;
}

void CancelAppearanceRequests() {
  ++gAppearance.generation;
  gAppearance.currentRequest.reset();
  gAppearance.thumbnailRequest.reset();
  gAppearance.failedThumbnails.clear();
  gAppearance.currentPreview = false;
}

void StartAppearancePreview(bool preview) {
  if (preview) {
    gState.striking = true;
    gState.strikeStarted = GetTickCount64();
    gState.strikeDurationMs = 800;
    gInput.previewUntil = gState.strikeStarted + 800;
    EnsureAnimationTimer();
  }
  gArtworkValid = false;
  RenderLayeredWindow(GetTickCount64());
}

bool RequestCurrentAppearance(const std::string& id, bool preview, bool force) {
  if (gDataStorage.closing || gAppearance.stopping) return false;
  if (gDisplay.startupRequest) {
    gDisplay.startupRequest = 0; gDisplay.startupSelection.clear();
  }
  if (id.empty() && !UsesCompositionRuntime()) {
    CancelAppearanceRequests();
    gAppearance.current.reset();
    gAppearance.currentDensity = 0;
    gState.selectedPackId.clear();
    gState.selectedScene = MeritScene::Woodfish;
    gAppearance.error.clear();
    SaveState();
    StartAppearancePreview(preview);
    QueueVisibleThumbnails();
    return true;
  }
  const auto* metadata = gAppearanceCatalog.Find(id);
  if (!metadata && !id.empty()) {
    ReportAppearanceFailure(UiText(L"所选形象已不在本地目录中，当前形象保持不变。请重新导入原包。",
        L"The selected appearance is no longer in the local catalog. The current appearance is unchanged; import the original pack again."));
    return false;
  }
  const float density = static_cast<float>(gState.windowWidth) / kDesignWidth;
  if (!UsesCompositionRuntime() && !force && gAppearance.current && gAppearance.current->id == id &&
      gAppearance.current->contentFingerprint == metadata->contentFingerprint &&
      gAppearance.currentDensity == density) {
    CancelAppearanceRequests();
    StartAppearancePreview(preview);
    QueueVisibleThumbnails();
    return true;
  }
  if (!InitializeAppearanceResources()) return false;
  input_runtime::AppearanceLoadRequest request;
  request.id = ++gAppearance.nextRequest;
  request.generation = gAppearance.generation + 1;
  request.kind = UsesCompositionRuntime() ? (id.empty() ? input_runtime::AppearanceLoadKind::Woodfish
      : input_runtime::AppearanceLoadKind::GpuCurrent) : input_runtime::AppearanceLoadKind::Current;
  if (id.empty()) {
    if (!input_runtime::EmbeddedWoodfishRequest(request.source)) {
      ReportAppearanceFailure(UiText(L"内置木鱼资源无法读取，当前形象保持不变。",
          L"The embedded woodfish could not be read. The current appearance is unchanged."));
      return false;
    }
  } else request.source = niuma::RequestAppearanceResources(*metadata);
  request.animationOptions.pixelDensity = density;
  const auto submitted = gAppearance.service->TrySubmit(request);
  if (!submitted.accepted()) {
    ReportAppearanceFailure(UiText(L"形象准备请求未被接纳，当前形象保持不变。请稍后再试。",
        L"The appearance request was not accepted. The current appearance is unchanged; retry shortly."));
    return false;
  }
  CancelAppearanceRequests();
  gAppearance.currentRequest = std::move(request);
  gAppearance.currentPreview = preview;
  gAppearance.error.clear();
  ArmAppearanceTimer();
  if (gPicker.window) InvalidateRect(gPicker.window, nullptr, FALSE);
  return true;
}

bool ThumbnailFailed(const niuma::AppearanceResourceRequest& source) {
  return std::any_of(gAppearance.failedThumbnails.begin(), gAppearance.failedThumbnails.end(),
      [&](const auto& failed) { return SameAppearanceSource(failed, source); });
}

void RememberThumbnailFailure(const niuma::AppearanceResourceRequest& source) {
  if (gAppearance.failedThumbnails.size() < 64 && !ThumbnailFailed(source))
    gAppearance.failedThumbnails.push_back(source);
}

void QueueVisibleThumbnails() {
  if (!gPicker.window || !IsWindow(gPicker.window) || gDataStorage.closing ||
      gAppearance.stopping || gAppearance.currentRequest || gAppearance.thumbnailRequest ||
      gAppearance.failedThumbnails.size() >= 64 || !gAppearance.service) return;
  const int first = std::max(1, gPicker.scrollRow * 2);
  const int last = std::min(static_cast<int>(gAppearanceCatalog.packs().size()) + 1,
      gPicker.scrollRow * 2 + 8);  // At most eight visible cards; cache holds twelve.
  for (int index = first; index < last; ++index) {
    const auto source = niuma::RequestAppearanceResources(*gAppearanceCatalog.packs()[index - 1]);
    if (gAppearance.thumbnails.Find(source) || ThumbnailFailed(source)) continue;
    input_runtime::AppearanceLoadRequest request;
    request.id = ++gAppearance.nextRequest;
    request.generation = gAppearance.generation;
    request.kind = input_runtime::AppearanceLoadKind::Thumbnail;
    request.source = source;
    const auto submitted = gAppearance.service->TrySubmit(request);
    if (submitted.accepted()) {
      gAppearance.thumbnailRequest = std::move(request);
      ArmAppearanceTimer();
    }
    return;
  }
}

void ApplyAppearanceLoadResult(input_runtime::AppearanceLoadResult result) {
  if (gDataStorage.closing || gAppearance.stopping || !result.request) return;
  if (gAppearance.currentRequest && result.Matches(*gAppearance.currentRequest) &&
      result.request->generation == gAppearance.generation) {
    const bool preview = gAppearance.currentPreview;
    gAppearance.currentRequest.reset();
    gAppearance.currentPreview = false;
    const bool builtin = result.request->kind == input_runtime::AppearanceLoadKind::Woodfish;
    if (!result.ready() || (!builtin && !CatalogStillMatches(result.request->source))) {
      if (gPicker.window) InvalidateRect(gPicker.window, nullptr, FALSE);
      ReportAppearanceFailure(result.detail);
      return;
    }
    if (UsesCompositionRuntime()) {
      try {
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
        if (!EnsureCompositionDisplay()) {
          ReportAppearanceFailure(UiText(L"显示设备初始化失败，原有形象保持不变。",
              L"Display initialization failed. The previous appearance is unchanged."));
          return;
        }
        if (!gDisplay.display->SetScene(result.scene)) {
          niuma::legacy_diag::Failure("display","SetScene",gDisplay.display->DiagnosticLastError(),
              {},gDisplay.display->LastErrorMessage().c_str(),SUCCEEDED(gDisplay.display->DiagnosticLastError()));
          ReportAppearanceFailure(UiText(L"形象纹理提交失败，原有形象保持不变。",
              L"Appearance texture submission failed. The previous appearance is unchanged."));
          return;
        }
#else
        if (!EnsureCompositionDisplay() || !gDisplay.display->SetScene(result.scene)) {
          ReportAppearanceFailure(UiText(L"形象未能提交到显示设备，原有形象保持不变。请稍后再试。",
              L"The appearance could not be installed on the display device. The previous appearance is unchanged."));
          return;
        }
#endif
      } catch (...) {
        ReportAppearanceFailure(UiText(L"准备形象时内存不足，原有形象保持不变。",
            L"Appearance preparation ran out of memory. The previous appearance is unchanged."));
        return;
      }
      gAppearance.current.reset();
      // Display a prepared woodfish while the saved selection loads. Do not
      // overwrite the saved selection merely because startup uses this pose.
      if (builtin && result.request->id == gDisplay.startupRequest && !gDisplay.startupSelection.empty()) {
        gDisplay.startupRequest = 0;
        const auto desired = std::exchange(gDisplay.startupSelection, std::string{});
        StartAppearancePreview(false);
        RequestCurrentAppearance(desired, false);
        return;
      }
      gState.selectedPackId = builtin ? std::string{} : result.request->source.id;
    } else {
      gAppearance.current = std::move(result.animation);
      gState.selectedPackId = gAppearance.current->id;
    }
    gAppearance.currentDensity = result.request->animationOptions.pixelDensity;
    gState.selectedScene = MeritScene::Woodfish;
    gAppearance.error.clear();
    SaveState();  // A requested id is never persisted before preparation succeeds.
    StartAppearancePreview(preview);
  } else if (gAppearance.thumbnailRequest && result.Matches(*gAppearance.thumbnailRequest) &&
      result.request->generation == gAppearance.generation) {
    gAppearance.thumbnailRequest.reset();
    if (!result.ready() || !CatalogStillMatches(result.request->source) ||
        !gAppearance.thumbnails.Put(std::move(result.thumbnail)))
      RememberThumbnailFailure(result.request->source);
  }
  if (gPicker.window) InvalidateRect(gPicker.window, nullptr, FALSE);
}

void PumpAppearanceResources() {
  if (!gAppearance.service) return;
  input_runtime::AppearanceLoadResult result;
  while (gAppearance.service->TryConsumeResult(result))
    ApplyAppearanceLoadResult(std::move(result));
  QueueVisibleThumbnails();
  ArmAppearanceTimer();
}

bool StopAppearanceResources() {
  if (!gAppearance.service) return true;
  if (!gAppearance.stopping) {
    gAppearance.stopping = true;
    CancelAppearanceRequests();
  }
  const auto stopped = gAppearance.service->Stop(0);
  input_runtime::AppearanceLoadResult discarded;
  while (gAppearance.service->TryConsumeResult(discarded)) discarded = {};
  ArmAppearanceTimer();
  return stopped.stopped;
}

void AppearanceCatalogChanged() {
  const std::string desired = gAppearance.currentRequest
      ? gAppearance.currentRequest->source.id : gState.selectedPackId;
  const bool preview = gAppearance.currentRequest && gAppearance.currentPreview;
  CancelAppearanceRequests();
  gAppearance.thumbnails.Clear();
  if (!desired.empty()) {
    const auto* metadata = gAppearanceCatalog.Find(desired);
    if (metadata && (!gAppearance.current || gAppearance.current->id != desired ||
        gAppearance.current->contentFingerprint != metadata->contentFingerprint))
      RequestCurrentAppearance(desired, preview);
  }
  QueueVisibleThumbnails();
}

void PrepareBuiltinThumbnail() {
  if (gAppearance.builtinThumbnail || !gFish.image || !gMallet.image) return;
  auto thumbnail = std::make_unique<Gdiplus::Bitmap>(240, 250, PixelFormat32bppARGB);
  if (thumbnail->GetLastStatus() != Gdiplus::Ok) return;
  Gdiplus::Graphics graphics(thumbnail.get());
  graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  DrawSceneArtwork(graphics, MeritScene::Woodfish, 0.0f);
  gAppearance.builtinThumbnail = std::move(thumbnail);
}

void EnsureAnimationTimer() {
  if (!gVisibility.hidden() && !gState.timerRunning && gState.window != nullptr) {
    // Legacy display shares authoritative input and latest-frame scheduling,
    // but caps animation submissions at 30 Hz instead of busy CPU rendering.
    const UINT frameInterval = gDisplay.display && gDisplay.display->layered() ? 33u : 16u;
    SetTimer(gState.window, kAnimationTimer, frameInterval, nullptr);
    gState.timerRunning = true;
  }
}

void CountOneOperation() {
  if (gInput.authoritative || gInput.loadFailed || gDataStorage.closing) return;
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
  ArmDataStorageTimer();
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

void SampleReminderInput(niuma::reminder::ActivitySampler::Event event) {
  gState.reminderActivity.Observe(event, GetTickCount64());
}

std::wstring ReminderWide(const char* text) {
  if (text == nullptr || *text == '\0') return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1,
      nullptr, 0);
  if (length <= 1) return {};
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1,
          result.data(), length) != length) return {};
  result.resize(static_cast<std::size_t>(length - 1));
  return result;
}

int ReminderBubbleHeight(const std::wstring& text) {
  const int dpi = static_cast<int>(gState.dpi);
  const int width = ScaleDip(260 - 60, gState.dpi);
  HFONT font = CreateFontW(-MulDiv(15, dpi, 96), 0, 0, 0, FW_MEDIUM,
      FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
      CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
  HDC dc = GetDC(nullptr);
  RECT measured{0, 0, width, 0};
  int textHeight = ScaleDip(80, gState.dpi);
  if (dc != nullptr) {
    HGDIOBJ previous = font ? SelectObject(dc, font) : nullptr;
    if (DrawTextW(dc, text.c_str(), static_cast<int>(text.size()), &measured,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX) != 0) {
      textHeight = measured.bottom - measured.top;
    }
    if (font) SelectObject(dc, previous);
    ReleaseDC(nullptr, dc);
  }
  if (font) DeleteObject(font);
  return std::max(ScaleDip(64, gState.dpi), textHeight + ScaleDip(40, gState.dpi));
}

bool PositionReminderWindow(HWND popup) {
  if (popup == nullptr || gState.window == nullptr) return false;
  RECT work{};
  MONITORINFO monitor{};
  monitor.cbSize = sizeof(monitor);
  const HMONITOR screen = MonitorFromWindow(gState.window, MONITOR_DEFAULTTONEAREST);
  if (GetMonitorInfoW(screen, &monitor)) work = monitor.rcWork;
  else if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0)) return false;
  const int width = ScaleDip(260, gState.dpi);
  const int height = ReminderBubbleHeight(gReminderText);
  const int margin = ScaleDip(10, gState.dpi);
  RECT widget{};
  if (!GetWindowRect(gState.window, &widget)) return false;
  const auto placement = niuma::reminder::PlaceBubble(
      {static_cast<double>(widget.left), static_cast<double>(widget.top),
          static_cast<double>(widget.right - widget.left),
          static_cast<double>(widget.bottom - widget.top)},
      {static_cast<double>(work.left), static_cast<double>(work.top),
          static_cast<double>(work.right - work.left),
          static_cast<double>(work.bottom - work.top)},
      width, height, margin, niuma::reminder::VerticalAxis::Down);
  const int inset = ScaleDip(6, gState.dpi);
  HRGN region = CreateRoundRectRgn(inset, inset, width - inset + 1, height - inset + 1,
      ScaleDip(36, gState.dpi), ScaleDip(36, gState.dpi));
  POINT tail[3]{};
  const int targetX = (widget.left + widget.right) / 2 - static_cast<int>(placement.x);
  const int targetY = (widget.top + widget.bottom) / 2 - static_cast<int>(placement.y);
  const int span = ScaleDip(7, gState.dpi);
  if (targetY < 0 || targetY > height) {
    const int x = std::clamp(targetX, ScaleDip(28, gState.dpi), width - ScaleDip(28, gState.dpi));
    const int y = targetY < 0 ? inset : height - inset;
    tail[0] = {x - span, y}; tail[1] = {x + span, y}; tail[2] = {x + span / 2, targetY < 0 ? 0 : height};
  } else {
    const int y = std::clamp(targetY, ScaleDip(28, gState.dpi), height - ScaleDip(28, gState.dpi));
    const int x = targetX < 0 ? inset : width - inset;
    tail[0] = {x, y - span}; tail[1] = {x, y + span}; tail[2] = {targetX < 0 ? 0 : width, y + span / 2};
  }
  HRGN triangle = CreatePolygonRgn(tail, 3, WINDING);
  if (region && triangle) CombineRgn(region, region, triangle, RGN_OR);
  if (triangle) DeleteObject(triangle);
  if (region && !SetWindowRgn(popup, region, TRUE)) DeleteObject(region);
  niuma::ui::WindowChrome(popup);
  return SetWindowPos(popup, HWND_TOPMOST, static_cast<int>(placement.x),
      static_cast<int>(placement.y), width, height,
      SWP_NOACTIVATE) != FALSE;
}

LRESULT CALLBACK ReminderWindowProcedure(HWND window, UINT message,
                                         WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_CREATE: {
      HWND label = CreateWindowExW(WS_EX_TRANSPARENT, L"STATIC", gReminderText.c_str(),
          WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX | SS_EDITCONTROL,
          ScaleDip(20, gState.dpi), ScaleDip(18, gState.dpi), ScaleDip(200, gState.dpi),
          ScaleDip(80, gState.dpi), window, reinterpret_cast<HMENU>(kReminderClose + 1),
          GetModuleHandleW(nullptr), nullptr);
      HWND close = CreateWindowExW(WS_EX_NOACTIVATE, L"BUTTON",
          L"\x00d7", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
          0, 0, ScaleDip(24, gState.dpi), ScaleDip(24, gState.dpi), window,
          reinterpret_cast<HMENU>(kReminderClose), GetModuleHandleW(nullptr), nullptr);
      if (label == nullptr || close == nullptr) return -1;
      HFONT font = CreateFontW(-MulDiv(15, static_cast<int>(gState.dpi), 96), 0, 0, 0,
          FW_MEDIUM, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
      if (font != nullptr) {
        SendMessageW(label, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(close, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SetPropW(window, L"NiuMaReminderFont", font);
      }
      SetWindowSubclass(close, niuma::ui::ButtonProcedure, 61, 0);
      return 0;
    }
    case WM_SIZE: {
      RECT bounds{};
      GetClientRect(window, &bounds);
      const int margin = ScaleDip(20, gState.dpi);
      const int closeWidth = ScaleDip(24, gState.dpi);
      const int closeHeight = ScaleDip(24, gState.dpi);
      const int textTop = ScaleDip(18, gState.dpi);
      HWND label = GetDlgItem(window, kReminderClose + 1);
      HWND close = GetDlgItem(window, kReminderClose);
      if (label != nullptr) MoveWindow(label, margin, textTop,
          bounds.right - ScaleDip(60, gState.dpi), bounds.bottom - textTop - margin, TRUE);
      if (close != nullptr) MoveWindow(close, bounds.right - closeWidth - ScaleDip(12, gState.dpi),
          ScaleDip(12, gState.dpi), closeWidth, closeHeight, TRUE);
      return 0;
    }
    case WM_DPICHANGED: {
      const UINT dpi = HIWORD(wParam);
      if (dpi != 0) gState.dpi = dpi;
      const HFONT font = CreateFontW(-MulDiv(15, static_cast<int>(gState.dpi), 96),
          0, 0, 0, FW_MEDIUM, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
          DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
      HWND label = GetDlgItem(window, kReminderClose + 1);
      HWND close = GetDlgItem(window, kReminderClose);
      if (font != nullptr) {
        if (label != nullptr) SendMessageW(label, WM_SETFONT,
            reinterpret_cast<WPARAM>(font), TRUE);
        if (close != nullptr) SendMessageW(close, WM_SETFONT,
            reinterpret_cast<WPARAM>(font), TRUE);
        if (HFONT oldFont = reinterpret_cast<HFONT>(
                RemovePropW(window, L"NiuMaReminderFont")))
          DeleteObject(oldFont);
        SetPropW(window, L"NiuMaReminderFont", font);
      }
      return 0;
    }
    case WM_NCHITTEST:
      return HTCLIENT;
    case WM_ERASEBKGND:
      return 1;
    case WM_CTLCOLORSTATIC: {
      HDC dc = reinterpret_cast<HDC>(wParam);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, niuma::ui::kInk);
      return reinterpret_cast<LRESULT>(GetStockObject(NULL_BRUSH));
    }
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      HDC dc = BeginPaint(window, &paint);
      RECT bounds{};
      GetClientRect(window, &bounds);
      HBRUSH background = CreateSolidBrush(RGB(255, 255, 255));
      FillRect(dc, &bounds, background);
      DeleteObject(background);
      HPEN border = CreatePen(PS_SOLID, 1, RGB(255, 255, 255));
      HGDIOBJ oldPen = SelectObject(dc, border);
      HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
      RoundRect(dc, 0, 0, bounds.right, bounds.bottom, 14, 14);
      SelectObject(dc, oldBrush);
      SelectObject(dc, oldPen);
      DeleteObject(border);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, RGB(58, 48, 35));
      HFONT font = CreateFontW(-MulDiv(14, static_cast<int>(gState.dpi), 96), 0, 0, 0,
          FW_MEDIUM, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
          CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
      HGDIOBJ oldFont = SelectObject(dc, font);
      SelectObject(dc, oldFont);
      DeleteObject(font);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_COMMAND:
      if (LOWORD(wParam) == kReminderClose) DestroyWindow(window);
      return 0;
    case WM_TIMER:
      if (wParam == kReminderDismissTimer) {
        KillTimer(window, kReminderDismissTimer);
        DestroyWindow(window);
        return 0;
      }
      break;
    case WM_DESTROY:
      if (gInput.pendingReminderWindow == window) {
        gInput.pendingReminderWindow = nullptr;
        gInput.reminderCommand = gInput.reminderEpoch = gInput.reminderOpportunity = 0;
        if (!gReminderWindow) gReminderText.clear();
      }
      if (gReminderWindow == window) {
        gReminderWindow = nullptr;
        gReminderText.clear();
        gReminderDismissAt = 0;
      }
      if (HFONT font = reinterpret_cast<HFONT>(RemovePropW(window, L"NiuMaReminderFont")))
        DeleteObject(font);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

std::size_t ReminderRandomBelow(std::size_t upper) {
  if (upper <= 1) return 0;
  std::uint32_t value = 0;
  const std::uint32_t bound = static_cast<std::uint32_t>(upper);
  const std::uint32_t threshold = static_cast<std::uint32_t>(-bound) % bound;
  do {
    if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&value), sizeof(value),
            BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return 0;
  } while (value < threshold);
  return value % bound;
}

void PresentReminderForTrigger(niuma::reminder::ActivitySampler::Trigger trigger,
                               const char** acceptanceStage = nullptr) {
  const auto stage = [acceptanceStage](const char* value) {
    if (acceptanceStage != nullptr) *acceptanceStage = value;
  };
  stage("store-or-existing-window");
  if (gVisibility.hidden() || !gState.reminderStore || gReminderWindow != nullptr ||
      gInput.pendingReminderWindow != nullptr) return;
  const std::int64_t nowUtc = static_cast<std::int64_t>(std::time(nullptr));
  stage("segment-save");
  if (gState.reminderStore->SetSegmentConsumed(true, nowUtc) !=
      niuma::reminder::StoreResult::Success) {
    gState.reminderStorageFault = true;
    return;
  }
  SYSTEMTIME local{};
  GetLocalTime(&local);
  char date[16]{};
  std::snprintf(date, sizeof(date), "%04u-%02u-%02u", local.wYear, local.wMonth, local.wDay);
  constexpr int geoNameBufferLength = 4;  // Two-letter ISO code plus NUL; three-digit M.49 plus NUL.
  wchar_t geo[geoNameBufferLength]{};
  char region[3] = "*";
  if (GetGeoInfoW(GetUserGeoID(GEOCLASS_NATION), GEO_ISO2, geo, geoNameBufferLength, 0) == 3 &&
      geo[0] >= L'A' && geo[0] <= L'Z' && geo[1] >= L'A' && geo[1] <= L'Z') {
    region[0] = static_cast<char>(geo[0]);
    region[1] = static_cast<char>(geo[1]);
  }
  niuma::reminder::SelectionContext context;
  context.locale = IsChineseUi() ? niuma::reminder::Locale::Chinese : niuma::reminder::Locale::English;
  context.region = region;
  context.trigger = trigger == niuma::reminder::ActivitySampler::Trigger::HighIntensity ? 2U : 1U;
  context.overtime = gOffwork.enabled && !gOffwork.suspended && gOffwork.snapshot.valid
      ? (gOffwork.snapshot.overtime ? niuma::reminder::Overtime::Yes : niuma::reminder::Overtime::No)
      : niuma::reminder::Overtime::Unknown;
  context.year = local.wYear;
  context.month = local.wMonth;
  context.day = local.wDay;
  context.minute_of_day = local.wHour * 60 + local.wMinute;
  std::unordered_set<std::string> recentIds;
  bool warmUsedToday = false;
  stage("selection-history");
  if (!gState.reminderStore->ReadSelectionHistory(date, nowUtc, &recentIds, &warmUsedToday)) {
    if (!gState.reminderClockGuard.guarded() &&
        !gState.reminderStore->ClockGuard(nowUtc, date))
      gState.reminderStorageFault = true;
    return;
  }
  const niuma::reminder::CatalogView catalogView = gState.reminderCatalog
      ? gState.reminderCatalog->view() : niuma::reminder::kBuiltinCatalogView;
  const auto candidates = niuma::reminder::EligibleItems(context,
      [&recentIds](const char* id) { return recentIds.find(id) != recentIds.end(); },
      catalogView);
  const auto* item = niuma::reminder::SelectItem(candidates, warmUsedToday,
      ReminderRandomBelow);
  stage("no-eligible-copy");
  if (item == nullptr) return;
  const std::wstring text = ReminderWide(item->text);
  stage("utf8-conversion");
  if (text.empty()) return;

  gReminderText = text;
  const int width = ScaleDip(340, gState.dpi);
  const int height = ReminderBubbleHeight(gReminderText);
  stage("window-create");
  HWND popup = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      kReminderClass, L"", WS_POPUP, 0, 0, width, height, gState.window, nullptr,
      GetModuleHandleW(nullptr), nullptr);
  if (popup == nullptr) {
    gReminderText.clear();
    return;
  }
  stage("window-position");
  if (!PositionReminderWindow(popup)) {
    DestroyWindow(popup);
    gReminderText.clear();
    return;
  }
  stage("reservation");
  const auto reserved = gState.reminderStore->TryReserve(item->id, date,
      std::strcmp(item->tone, "warm") == 0, nowUtc);
  if (reserved != niuma::reminder::StoreResult::Success) {
    if (reserved == niuma::reminder::StoreResult::IoError ||
        reserved == niuma::reminder::StoreResult::InvalidState)
      gState.reminderStorageFault = true;
    DestroyWindow(popup);
    gReminderText.clear();
    return;
  }
  gState.reminderStorageFault = false;
  if (gInput.authoritative && acceptanceStage == nullptr) {
    gInput.pendingReminderWindow = popup;
    gInput.reminderCommand = ++gInput.nextCommand;
    gInput.reminderEpoch = gInput.latest.input.epoch;
    gInput.reminderOpportunity = gInput.latest.pendingReminderId;
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::ConfirmReminder;
    command.id = gInput.reminderCommand;
    command.expectedEpoch = gInput.reminderEpoch;
    command.opportunityId = gInput.reminderOpportunity;
    SendInputCommand(command);
    stage("awaiting-owner-confirmation");
    return;
  }
  gReminderWindow = popup;
  gReminderDismissAt = GetTickCount64() + niuma::reminder::kReminderDisplayMilliseconds;
  SetTimer(popup, kReminderDismissTimer, niuma::reminder::kReminderDisplayMilliseconds, nullptr);
  ShowWindow(popup, SW_SHOWNOACTIVATE);
  InvalidateRect(popup, nullptr, TRUE);
  stage("shown");
}

LRESULT CALLBACK KeyboardHook(
    int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION && gState.window != nullptr) {
    const auto* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    const bool reminderInputAllowed = event != nullptr &&
        (event->flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) == 0;
    if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) {
      if (reminderInputAllowed)
        SampleReminderInput(niuma::reminder::ActivitySampler::Event::KeyDown);
      QueueGlobalInput(kCountMessage, 1);
    } else if (message == WM_KEYUP || message == WM_SYSKEYUP) {
      if (reminderInputAllowed)
        SampleReminderInput(niuma::reminder::ActivitySampler::Event::KeyUp);
    }
  }
  return CallNextHookEx(gState.keyboardHook, code, message, data);
}

LRESULT CALLBACK MouseHook(
    int code, WPARAM message, LPARAM data) {
  bool reminderInputAllowed = false;
  if (code == HC_ACTION && data != 0) {
    const auto* event = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
    reminderInputAllowed =
        (event->flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) == 0;
  }
  if (code == HC_ACTION && gState.window != nullptr) {
    switch (message) {
      case WM_LBUTTONDOWN:
      case WM_RBUTTONDOWN:
      case WM_MBUTTONDOWN:
      case WM_XBUTTONDOWN:
        if (reminderInputAllowed)
          SampleReminderInput(niuma::reminder::ActivitySampler::Event::Click);
        QueueGlobalInput(kCountMessage, 2);
        break;
      case WM_MOUSEWHEEL:
      case WM_MOUSEHWHEEL:
        if (reminderInputAllowed)
          SampleReminderInput(niuma::reminder::ActivitySampler::Event::ScrollPulse);
        QueueGlobalInput(kScrollMessage, 3);
        break;
      default:
        break;
    }
  }
  return CallNextHookEx(gState.mouseHook, code, message, data);
}

void CountGlobalDelivery(bool scroll, LPARAM generation, WPARAM listenerGeneration) {
  if (gInput.authoritative || gInput.loadFailed) return;
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

void ApplyInputView(const input_runtime::InputServiceSnapshot& snapshot) {
  if (!snapshot.input.ready) return;
  const auto previousDate = gState.currentDay;
  const bool countsChanged = gState.total != snapshot.input.total ||
      gState.todayTotal != snapshot.input.today;
  const bool previousStrike = gState.striking;
  const ULONGLONG previousStart = gState.strikeStarted;
  gInput.latest = snapshot;
  gState.total = snapshot.input.total;
  gState.todayTotal = snapshot.input.today;
  gState.currentDay = InputDateKey(snapshot.input.date);
  gState.lastInputTime = snapshot.input.lastInputMs;
  gState.lastScrollEventTime = snapshot.input.lastScrollMs;
  gState.intervalEma = snapshot.input.intervalEmaMs;
  const auto now = GetTickCount64();
  if (!gInput.previewUntil || now >= gInput.previewUntil) {
    gInput.previewUntil = 0;
    gState.striking = snapshot.input.striking && now >= snapshot.input.strikeStartedMs &&
        now - snapshot.input.strikeStartedMs < static_cast<ULONGLONG>(snapshot.input.strikeDurationMs);
    gState.strikeStarted = snapshot.input.strikeStartedMs;
    gState.strikeDurationMs = snapshot.input.strikeDurationMs;
  }
  gCountingCheck.keyboardError = snapshot.keyboardError;
  gCountingCheck.mouseError = snapshot.mouseError;
  gCountingCheck.observedCount = snapshot.observedGlobalCount;
  gCountingCheck.deliveryFault = gInput.controlFault || snapshot.notificationError ||
      snapshot.input.fault != input_core::InputFault::None ||
      snapshot.input.unaccountedOperations != 0 || !snapshot.running;
  const auto& check = snapshot.selfCheck;
  if (gCountingCheck.active && check.generation == gCountingCheck.generation) {
    gCountingCheck.starts = check.startsMs;
    gCountingCheck.ends = check.endsMs;
    gCountingCheck.keys = check.keys;
    gCountingCheck.clicks = check.clicks;
    gCountingCheck.scrolls = check.scrolls;
    gCountingCheck.handled = check.handled;
    gCountingCheck.expected = check.expected;
    gCountingCheck.counted = check.counted;
    gCountingCheck.lastRelative = check.lastRelativeMs;
    if (check.cancelled || check.error != ERROR_SUCCESS) {
      gCountingCheck.active = false;
      gCountingCheck.result = UiText(L"自检未完成，监听状态已改变或请求来迟。请重新开始自检。",
          L"The check did not complete because listener state changed or the request arrived late. Start a new check.");
    }
  }
  if (countsChanged || previousDate != gState.currentDay) gState.dirty = true;
  if (gState.window && (countsChanged || previousDate != gState.currentDay ||
      previousStrike != gState.striking || previousStart != gState.strikeStarted)) {
    const bool wasRunning = gState.timerRunning;
    if (gState.striking) EnsureAnimationTimer();
    ArmDataStorageTimer();
    if (!wasRunning || !gState.striking) RenderLayeredWindow(now);
    if (gCalendar.window) InvalidateRect(gCalendar.window, nullptr, FALSE);
  }
  if (previousDate != gState.currentDay) RequestInputLedger();
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
  WriteRuntimeEntryObservation();
#endif
}

void RequestInputLedger() {
  if (!gInput.service || !gInput.service->running() || gInput.ledgerRequest ||
      !gInput.latest.input.epoch) return;
  const auto id = ++gInput.nextLedger;
  const auto result = gInput.service->RequestLedger({id, gInput.latest.input.epoch});
  if (result == input_core::LedgerRequestResult::Accepted) gInput.ledgerRequest = id;
}

void StopInputService() {
  CancelPendingReminder();
  if (!gInput.service || gInput.finalCollected) return;
  const bool wasConsumed = gInput.reminderConsumed;
  const auto& final = gInput.service->Stop();
  if (final.stopped && final.snapshot.input.ready) {
    gInput.ledger = final.snapshot.input;
    gInput.daily = final.daily;
    ApplyInputView(final.snapshot);
    gInput.reminderConsumed = final.snapshot.input.reminderSegmentConsumed;
    if (wasConsumed && !gInput.reminderConsumed) PersistReminderUnlockIfNeeded(true);
  }
  gInput.ledgerRequest = 0;
  gInput.finalCollected = true;
  gState.dirty = true;
  ArmDataStorageTimer();
}

void ConsumeInputSnapshot() {
  if (!gInput.service || gInput.finalCollected) return;
  input_runtime::InputServiceSnapshot snapshot;
  if (gInput.service->ReadLatest(snapshot)) {
    const bool wasConsumed = gInput.reminderConsumed;
    ApplyInputView(snapshot);
    gInput.reminderConsumed = snapshot.input.reminderSegmentConsumed;
    if (wasConsumed && !gInput.reminderConsumed) PersistReminderUnlockIfNeeded(true);
    if (!snapshot.running) {
      StopInputService();
      gState.dirty = true;
      ArmDataStorageTimer();
      RefreshCountingStatus();
      return;
    }
  }
  input_core::LedgerSnapshotResult ledger;
  try {
    if (gInput.service->TryConsumeLedger(ledger)) {
      gInput.ledgerRequest = 0;
      if (ledger.header.status == input_core::LedgerResultStatus::Complete &&
          ledger.header.input.epoch == gInput.latest.input.epoch) {
        gInput.ledger = ledger.header.input;
        gInput.daily.assign(ledger.daily.begin(), ledger.daily.end());
        gState.dirty = true;
        PumpDataStorage();
        if (gCalendar.window) InvalidateRect(gCalendar.window, nullptr, FALSE);
      } else if (ledger.header.status == input_core::LedgerResultStatus::EpochMismatch ||
                 ledger.header.status == input_core::LedgerResultStatus::Complete) {
        RequestInputLedger();
      } else {
        gCountingCheck.deliveryFault = true;
      }
    }
  } catch (...) {
    // The service retains its Ready ledger on allocation failure. Retry from
    // the ordinary UI timer; no partial ledger is installed or saved.
    gCountingCheck.deliveryFault = true;
  }
  if (gInput.pendingReminderWindow) {
    const auto& confirmation = gInput.latest.reminderConfirmation;
    const bool stillValid = !gVisibility.hidden() && !gInput.controlFault &&
        gInput.latest.input.epoch == gInput.reminderEpoch &&
        gInput.latest.input.keyboardAvailable && gInput.latest.input.mouseAvailable &&
        gInput.latest.input.reminderSegmentConsumed && !ReminderSuspended() &&
        gState.reminderPauseKind == AppState::ReminderPauseKind::None &&
        !gState.reminderClockGuard.guarded();
    if (!stillValid || (confirmation.commandId >= gInput.reminderCommand &&
        (!confirmation.confirmed || confirmation.commandId != gInput.reminderCommand ||
         confirmation.epoch != gInput.reminderEpoch ||
         confirmation.opportunityId != gInput.reminderOpportunity))) {
      CancelPendingReminder();
    } else if (confirmation.commandId == gInput.reminderCommand && confirmation.confirmed) {
      const HWND popup = gInput.pendingReminderWindow;
      gInput.pendingReminderWindow = nullptr;
      gInput.reminderCommand = gInput.reminderEpoch = gInput.reminderOpportunity = 0;
      gReminderWindow = popup;
      gReminderDismissAt = GetTickCount64() + niuma::reminder::kReminderDisplayMilliseconds;
      SetTimer(popup, kReminderDismissTimer, niuma::reminder::kReminderDisplayMilliseconds, nullptr);
      ShowWindow(popup, SW_SHOWNOACTIVATE);
      InvalidateRect(popup, nullptr, TRUE);
    }
  }
  if (!gInput.controlFault && !gState.reminderStorageFault &&
      !gState.reminderClockGuard.guarded() &&
      gState.reminderPauseKind == AppState::ReminderPauseKind::None &&
      gInput.latest.pendingReminderId &&
      gInput.latest.pendingReminderId != gInput.handledReminder &&
      gInput.latest.pendingReminderEpoch == gInput.latest.input.epoch &&
      !gReminderWindow && !gInput.pendingReminderWindow) {
    gInput.handledReminder = gInput.latest.pendingReminderId;
    PresentReminderForTrigger(gInput.latest.pendingReminder);
  }
  RefreshCountingStatus();
}

void RestartGlobalListeners() {
  if (gDataStorage.closing) return;
  CancelPendingReminder();
  ++gCountingCheck.listenerGeneration;
  gCountingCheck.observedCount = false;
  gCountingCheck.deliveryFault = false;
  if (gInput.service && gInput.service->running()) {
    input_runtime::InputCommand command;
    command.kind = input_runtime::InputCommandKind::RestartListeners;
    if (SendInputCommand(command)) gInput.controlFault = false;
    return;
  }
  StopInputService();
  input_runtime::InputServiceOptions options;
  try {
    if (gInput.authoritative) {
      options.total = gInput.ledger.total;
      options.date = input_runtime::InputService::CaptureLocalDate();
      options.daily = gInput.daily;
      options.reminderSegmentConsumed = gInput.reminderConsumed;
    } else {
      if (!LoadInputLedger(options)) {
        gInput.loadFailed = true;
        gCountingCheck.deliveryFault = true;
        gCountingCheck.keyboardError = gCountingCheck.mouseError = ERROR_INVALID_DATA;
        return;
      }
      gInput.loadFailed = false;
      options.reminderSegmentConsumed = gState.reminderActivity.segment_consumed();
      gInput.ledger.total = options.total;
      gInput.ledger.date = options.date;
      gInput.daily = options.daily;
    }
    options.notificationWindow = gState.window;
    options.notificationMessage = kInputSnapshotMessage;
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
    options.diagnostic = gInput.diagnostic;
    options.diagnostic.seedReminderOpportunity = false;
#endif
    const auto capacity = std::min(input_core::InputCore::kMaximumDayCapacity,
        std::max(input_core::InputCore::kDefaultDayCapacity, options.daily.size() + 366));
    gInput.daily.reserve(capacity);
    ++gInput.instanceGeneration;
    gInput.service = std::make_unique<input_runtime::InputService>(capacity);
    gInput.finalCollected = false;
    const auto started = gInput.service->Start(options);
    if (!started.started) {
      // A ready timeout can still have started the owner. Preserve its final
      // ledger before discarding the failed instance; do not roll counts back.
      const auto& final = gInput.service->Stop();
      if (final.stopped && final.snapshot.input.ready) {
        gInput.authoritative = true;
        StopInputService();
      }
      gCountingCheck.keyboardError = gCountingCheck.mouseError = started.error;
      gCountingCheck.deliveryFault = true;
      gInput.service.reset();
      return;
    }
    gInput.authoritative = true;
    gInput.loadFailed = false;
    gInput.finalCollected = false;
    gInput.controlFault = false;
    gInput.ledgerRequest = 0;
    gInput.handledReminder = 0;
    gInput.reminderConsumed = options.reminderSegmentConsumed;
    gState.pendingDailyTotals.clear();
    SyncInputClockGuard();
    ConsumeInputSnapshot();
    RequestInputLedger();
    if (gState.reminderPauseKind != AppState::ReminderPauseKind::None) {
      input_runtime::InputCommand command;
      command.kind = input_runtime::InputCommandKind::BeginSuspend;
      SendInputCommand(command);
    }
  } catch (...) {
    gCountingCheck.deliveryFault = true;
    gCountingCheck.keyboardError = gCountingCheck.mouseError = ERROR_NOT_ENOUGH_MEMORY;
  }
}

std::wstring CountingStatusTitle() {
  if (gDataStorage.closing)
    return UiText(L"正在保存最后的记录；保存确认后自动退出。请保持程序打开。",
                  L"Saving the final records. The app will exit after confirmation; keep it open.");
  if (gDataStorage.error || gDataStorage.mergeFailed ||
      (gDataStorage.model && gDataStorage.model->save_failed()))
    return UiText(L"本地保存尚未确认；记录仍保留在内存中，程序会重试。",
                  L"Local saving is not confirmed. Records remain in memory while the app retries.");
  if (gInput.loadFailed)
    return UiText(L"计数暂停：完整日历记录未读取，请检查本地存储后重试。",
                  L"Counting paused: the complete daily ledger could not be read. Check local storage and retry.");
  if (gInput.authoritative && !gInput.latest.running)
    return UiText(L"计数服务已停止，请重试监听。", L"Counting service stopped. Retry the listener.");
  if (!KeyboardListenerAvailable() && !MouseListenerAvailable())
    return UiText(L"仅点击小伙伴计数", L"Pet-click Counting Only");
  if (!KeyboardListenerAvailable() || !MouseListenerAvailable())
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
  const bool ownerFinished = !gInput.authoritative ||
      (gInput.latest.selfCheck.generation == gCountingCheck.generation &&
       !gInput.latest.selfCheck.active);
  if (gCountingCheck.active && now >= gCountingCheck.ends && ownerFinished) {
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
    } else if (now < gCountingCheck.ends) {
      progress = UiText(L"记录中，剩余秒数：", L"Recording; seconds left: ") +
          std::to_wstring((gCountingCheck.ends - now + 999) / 1000);
    } else {
      progress = UiText(L"记录结束，正在核对计数。", L"Recording ended; checking the counts.");
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
  text += KeyboardListenerAvailable() ? UiText(L"已建立", L"created") : UiText(L"未建立", L"unavailable");
  text += UiText(L"；鼠标监听句柄：", L"; mouse listener handle: ");
  text += MouseListenerAvailable() ? UiText(L"已建立", L"created") : UiText(L"未建立", L"unavailable");
  if (!KeyboardListenerAvailable())
    text += UiText(L"；键盘错误码 ", L"; keyboard error ") + std::to_wstring(gCountingCheck.keyboardError);
  if (!MouseListenerAvailable())
    text += UiText(L"；鼠标错误码 ", L"; mouse error ") + std::to_wstring(gCountingCheck.mouseError);
  text += UiText(
      L"。句柄存在不保证仍在收到输入，请以实际自检为准。\r\n\r\nWindows 安全桌面、会话切换或监听超时可能影响监听。可点“重试监听”，不需要开启 macOS 权限，也不要求管理员提权或关闭安全保护。\r\n\r\n自检仅在内存中保留事件次数与相对时间；不读取或保存具体键值、内容、坐标、应用或窗口信息。不联网。",
      L". A handle alone does not prove input is still arriving; use the check.\r\n\r\nWindows secure desktops, session changes or listener timeouts can affect input. Retry the listener; no macOS permissions, elevation or disabling security is required.\r\n\r\nOnly event counts and relative times are kept in memory, never key values, contents, coordinates, apps or window information. No networking.");
  SetDlgItemTextW(gCountingCheck.window, kStatusText, text.c_str());
  EnableWindow(GetDlgItem(gCountingCheck.window, kStatusRetry), !gDataStorage.closing);
  EnableWindow(GetDlgItem(gCountingCheck.window, kStatusStart), !gCountingCheck.active && !gDataStorage.closing);
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
      niuma::ui::Apply(window);
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
      ConsumeInputSnapshot();
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
        const auto captured = GetTickCount64();
        gCountingCheck.starts = captured + 2000;
        gCountingCheck.ends = gCountingCheck.starts + 10000;
        gCountingCheck.active = true;
        if (gInput.authoritative) {
          input_runtime::InputCommand command;
          command.kind = input_runtime::InputCommandKind::BeginSelfCheck;
          command.expectedEpoch = gInput.latest.input.epoch;
          command.capturedMs = captured;
          command.selfCheckGeneration = gCountingCheck.generation;
          if (!SendInputCommand(command)) {
            gCountingCheck.active = false;
            gCountingCheck.result = UiText(L"自检请求未提交，请重试监听后再试。",
                L"The check request was not accepted. Retry the listener and try again.");
          }
        }
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
    cls.hbrBackground = niuma::ui::CanvasBrush();
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
  return niuma::ui::Message(
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

const wchar_t* AboutDouyinCaption() {
  return UiText(L"用抖音扫一扫，加入牛马电子功德共创群＆AI学习。\n群号：117093216342\n免费领取权益包，交流形象创意。\n开发者抖音号：1872941388",
                L"Scan with Douyin to join the NiuMa Merit & AI learning group.\nGroup: 117093216342\nClaim free benefit packs and share appearance ideas.\nDeveloper Douyin ID: 1872941388");
}

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
  int promoHeight = 0;
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
  RECT promo = {0, 0, state.contentWidth - state.padding * 2, 0};
  DrawTextW(dc, AboutDouyinCaption(), -1, &promo,
            DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX | DT_CENTER);
  state.promoHeight = static_cast<int>(promo.bottom) + 4;
  SelectObject(dc, oldFont);
  ReleaseDC(state.viewport, dc);
  state.textHeight = static_cast<int>(measured.bottom) + 4;
  state.helpHeight = state.lineHeight + state.padding;
  state.contentHeight = state.padding * 5 + state.textHeight +
                        state.helpHeight + state.promoHeight + state.imageHeight;

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

void DrawAboutContent(HWND window, HDC dc, const RECT& client,
                      const AboutDialogState& state) {
  FillRect(dc, &client, niuma::ui::WhiteBrush());
  HGDIOBJ oldFont = SelectObject(dc, state.font);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
  RECT text = {state.padding - state.scrollX,
               state.padding - state.scrollY,
               state.contentWidth - state.padding - state.scrollX,
               state.padding + state.textHeight - state.scrollY};
  DrawTextW(dc, state.text.c_str(), -1, &text, DT_WORDBREAK | DT_NOPREFIX);
  RECT promo = {state.padding - state.scrollX,
      state.padding * 3 + state.textHeight + state.helpHeight - state.scrollY,
      state.contentWidth - state.padding - state.scrollX,
      state.padding * 3 + state.textHeight + state.helpHeight + state.promoHeight - state.scrollY};
  DrawTextW(dc, AboutDouyinCaption(), -1, &promo,
            DT_WORDBREAK | DT_NOPREFIX | DT_CENTER);
  SelectObject(dc, oldFont);
  if (state.douyin.image && state.douyin.image->GetWidth() != 0 &&
      state.douyin.image->GetHeight() != 0) {
    Gdiplus::Graphics graphics(dc);
    graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    graphics.DrawImage(state.douyin.image.get(), Gdiplus::RectF(
        static_cast<float>((state.contentWidth - state.imageWidth) / 2 -
                           state.scrollX),
        static_cast<float>(state.padding * 4 + state.textHeight + state.helpHeight + state.promoHeight -
                           state.scrollY),
        static_cast<float>(state.imageWidth),
        static_cast<float>(state.imageHeight)));
    graphics.Flush(Gdiplus::FlushIntentionSync);
  }
  if (GetFocus() == window) DrawFocusRect(dc, &client);
}

void PaintAboutContent(HWND window, const AboutDialogState& state) {
  PAINTSTRUCT paint = {};
  HDC dc = BeginPaint(window, &paint);
  RECT client = {};
  GetClientRect(window, &client);
  const int width = client.right - client.left;
  const int height = client.bottom - client.top;
  if (dc == nullptr || width <= 0 || height <= 0) {
    EndPaint(window, &paint);
    return;
  }

  HDC bufferDc = CreateCompatibleDC(dc);
  HBITMAP bitmap = bufferDc ? CreateCompatibleBitmap(dc, width, height) : nullptr;
  HGDIOBJ previousBitmap = bitmap ? SelectObject(bufferDc, bitmap) : nullptr;
  const bool buffered = previousBitmap != nullptr && previousBitmap != HGDI_ERROR;
  if (buffered) {
    // Present text, background and QR image together, never a cleared frame.
    DrawAboutContent(window, bufferDc, client, state);
    BitBlt(dc, 0, 0, width, height, bufferDc, 0, 0, SRCCOPY);
    SelectObject(bufferDc, previousBitmap);
  } else {
    DrawAboutContent(window, dc, client, state);
  }
  if (bitmap) DeleteObject(bitmap);
  if (bufferDc) DeleteDC(bufferDc);
  EndPaint(window, &paint);
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
      FillRect(draw->hDC, &draw->rcItem, niuma::ui::WhiteBrush());
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
      PaintAboutContent(window, *state);
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
  const int buttonHeight = std::min(MulDiv(36, gState.dpi, 96), height);
  const int header = niuma::ui::CardHeader(gState.dpi);
  const int padding = std::min(state.padding,
      std::min(std::max(0, (height - buttonHeight) / 3), width / 4));
  const int viewportHeight = std::max(0, height - header - buttonHeight - padding * 3);
  MoveWindow(state.viewport, padding, header + padding, std::max(1, width - padding * 2),
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
      state->padding = std::max(1, MulDiv(22, gState.dpi, 96));
      state->imageHeight = std::max(1, MulDiv(260, gState.dpi, 96));
      state->imageWidth = state->imageHeight;
      if (state->douyin.image && state->douyin.image->GetHeight() != 0 &&
          state->douyin.image->GetWidth() != 0) {
        state->imageWidth = std::max(1, static_cast<int>(std::lround(
            static_cast<double>(state->imageHeight) * state->douyin.image->GetWidth()
            / state->douyin.image->GetHeight())));
      }
      niuma::ui::Apply(window);
      niuma::ui::Card(window, IsRuntimeCandidate()
          ? UiText(L"关于牛马电子功德 · 独立测试", L"About NiuMa Merit · Development Test")
          : UiText(L"关于牛马电子功德", L"About NiuMa Merit"), UiText(L"关闭", L"Close"));
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
      niuma::ui::Apply(window);
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
          niuma::ui::CardHeader(gState.dpi) + state->contentHeight + MulDiv(36, gState.dpi, 96)
          + state->padding * 3 + GetSystemMetrics(SM_CYHSCROLL));
      SetWindowPos(window, nullptr,
                   work.left + (work.right - work.left - width) / 2,
                   work.top + (work.bottom - work.top - height) / 2,
                   width, height, SWP_NOZORDER);
      niuma::ui::Apply(window);
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
        L"鼠标位置或窗口信息。\n本软件不包含网络请求、"
        L"遥测或自动更新。\n\n官方网站：\n"
      : L"NiuMa Merit v" + version + L"\n\n"
        L"Counts keyboard presses, mouse button presses, and scroll gestures without "
        L"reading specific content, mouse positions, or window information.\n"
        L"The app contains no network requests, "
        L"telemetry, or automatic updates."
        L"\n\nOfficial website:\n";
  text += L"https://gongde.zqscreen.cn/";
  text += UiText(L"\n\n如未正常计数，可联系开发者，或扫描下方抖音码进粉丝群寻求帮助。",
                L"\n\nIf input is not being counted, contact the developer or scan the Douyin code below to join the fan group for help.");
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
    const std::wstring fallback = text + L"\n\nhttps://gongde.zqscreen.cn/help-windows.html\n\n" + AboutDouyinCaption();
    niuma::ui::Message(owner, fallback.c_str(), UiText(L"关于牛马电子功德", L"About NiuMa Merit"),
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

// Calendar reads only the existing in-memory ledger. Painting never creates a
// missing overtime record, scans history files, or changes persisted values.
constexpr int kCalendarPrevious = 4201, kCalendarNext = 4202, kCalendarToday = 4203;
constexpr float kCalendarWidth = 760, kCalendarHeight = 704;
constexpr float kCalendarLeft = 26, kCalendarGridTop = 234, kCalendarGridHeight = 336;
#ifdef NIUMA_CALENDAR_DIAGNOSTICS
SYSTEMTIME gCalendarTodayForTest{};
int gCalendarLanguageForTest = -1;
#endif
SYSTEMTIME CalendarToday() {
#ifdef NIUMA_CALENDAR_DIAGNOSTICS
  if (gCalendarTodayForTest.wYear) return gCalendarTodayForTest;
#endif
  SYSTEMTIME now{}; GetLocalTime(&now); return now;
}
bool CalendarChinese() {
#ifdef NIUMA_CALENDAR_DIAGNOSTICS
  if (gCalendarLanguageForTest >= 0) return gCalendarLanguageForTest != 0;
#endif
  return IsChineseUi();
}
const wchar_t* CalendarText(const wchar_t* zh, const wchar_t* en) { return CalendarChinese() ? zh : en; }
std::wstring CalendarNumber(std::uint64_t value) {
  auto text = std::to_wstring(value);
  for (int i=static_cast<int>(text.size())-3;i>0;i-=3) text.insert(static_cast<std::size_t>(i),1,L',');
  return text;
}
std::wstring CalendarCompactNumber(std::uint64_t value) {
  const std::uint64_t unit = CalendarChinese() ? (value>=1000000000000ULL ? 1000000000000ULL :
      value>=100000000 ? 100000000 : value>=10000 ? 10000 : 1) :
      (value>=1000000000000ULL ? 1000000000000ULL : value>=1000000000 ? 1000000000 : value>=1000000 ? 1000000 : value>=1000 ? 1000 : 1);
  if (unit==1) return CalendarNumber(value);
  const wchar_t* suffix = CalendarChinese() ? (unit==10000 ? L"万" : unit==100000000 ? L"亿" : L"万亿") :
      (unit==1000 ? L"K" : unit==1000000 ? L"M" : unit==1000000000 ? L"B" : L"T");
  return std::to_wstring(value/unit)+L"."+std::to_wstring((value%unit)/(unit/10))+suffix;
}
std::wstring CalendarOvertimeShort(int seconds) {
  seconds=std::max(0,seconds);const auto h=seconds/3600,m=seconds%3600/60;
  if (seconds>0 && seconds<60) return CalendarText(L"加班 <1分",L"OT <1m");
  if (CalendarChinese()) return L"加班 "+(h ? std::to_wstring(h)+L"时" : L"")+std::to_wstring(m)+L"分";
  return L"OT "+(h ? std::to_wstring(h)+L"h " : L"")+std::to_wstring(m)+L"m";
}
float CalendarScale(HWND window) {
  RECT client{}; GetClientRect(window,&client);
  return std::max(.1f,std::min(client.right/kCalendarWidth,client.bottom/kCalendarHeight));
}
const wchar_t* CalendarFontFamily() {
  static const wchar_t* available=[] {
    for (const auto* name : {L"Microsoft YaHei UI",L"Microsoft YaHei",L"Segoe UI"}) {
      Gdiplus::FontFamily family(name);if(family.GetLastStatus()==Gdiplus::Ok)return name;
    }
    return L"Segoe UI";
  }();
  return available;
}
void DrawCalendarText(Gdiplus::Graphics& graphics,const std::wstring& text,
    const Gdiplus::RectF& rect,float size,const Gdiplus::Color& color,bool bold=false,
    Gdiplus::StringAlignment alignment=Gdiplus::StringAlignmentNear) {
  Gdiplus::StringFormat format;
  format.SetAlignment(alignment);format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  format.SetTrimming(Gdiplus::StringTrimmingEllipsisCharacter);
  float fitted=size;
  while(fitted>10) {
    Gdiplus::Font font(CalendarFontFamily(),fitted,bold?Gdiplus::FontStyleBold:Gdiplus::FontStyleRegular,Gdiplus::UnitPixel);
    Gdiplus::RectF measured;graphics.MeasureString(text.c_str(),-1,&font,Gdiplus::PointF(0,0),&measured);
    if(measured.Width<=rect.Width)break;fitted-=1;
  }
  Gdiplus::Font font(CalendarFontFamily(),fitted,bold?Gdiplus::FontStyleBold:Gdiplus::FontStyleRegular,Gdiplus::UnitPixel);
  Gdiplus::SolidBrush brush(color);graphics.DrawString(text.c_str(),-1,&font,rect,&format,&brush);
}
void ReloadCalendarRange() {
  const auto now=CalendarToday();gCalendar.range=niuma::CalendarMonthRange(now.wYear,now.wMonth);
  if(gDataStorage.model)for(const auto& entry:gDataStorage.model->current().counts.daily)
    if(entry.second>0)gCalendar.range.IncludeRecordedDay(std::wstring_view(InputDateKey(entry.first)));
  if(gInput.authoritative)for(const auto& entry:gInput.daily)
    if(entry.total>0)gCalendar.range.IncludeRecordedDay(std::wstring_view(InputDateKey(entry.date)));
  for(const auto& entry:gState.pendingDailyTotals)
    if(entry.second>0)gCalendar.range.IncludeRecordedDay(std::wstring_view(entry.first));
  for(const auto& entry:gOffwork.days)
    if(entry.second.present)gCalendar.range.IncludeRecordedDay(std::wstring_view(entry.first));
}
int CalendarLastSelectableDay() {
  const auto now=CalendarToday();
  return gCalendar.year==now.wYear && gCalendar.month==now.wMonth ? now.wDay : DaysInMonth(gCalendar.year,gCalendar.month);
}
void RefreshCalendarNavigation() {
  const auto now=CalendarToday();
  if(gCalendar.range.last!=niuma::CalendarMonthRange::Month(now.wYear,now.wMonth))ReloadCalendarRange();
  const auto month=gCalendar.range.Clamp(niuma::CalendarMonthRange::Month(gCalendar.year,gCalendar.month));
  gCalendar.year=month/12;gCalendar.month=month%12+1;
  gCalendar.selectedDay=std::clamp(gCalendar.selectedDay,1,CalendarLastSelectableDay());
  if(gCalendar.window) {
    EnableWindow(GetDlgItem(gCalendar.window,kCalendarPrevious),gCalendar.range.CanShift(month,-1));
    EnableWindow(GetDlgItem(gCalendar.window,kCalendarNext),gCalendar.range.CanShift(month,1));
  }
}
std::wstring CalendarDateKey(int day) {
  wchar_t key[16]{};swprintf_s(key,L"%04d-%02d-%02d",gCalendar.year,gCalendar.month,day);return key;
}
struct CalendarDayView {std::uint64_t merit=0;bool overtimeRecorded=false;int overtimeSeconds=0;};
struct CalendarMonthView {std::array<CalendarDayView,32> days{};std::uint64_t total=0;bool totalSaturated=false;};
CalendarMonthView ReadCalendarMonth() {
  CalendarMonthView view;
  const auto prefix=static_cast<input_core::LocalDate>(gCalendar.year*100+gCalendar.month);
  // One pass over the authoritative snapshot, rather than 31 full-history searches.
  if(gInput.authoritative) {
    for(const auto& day:gInput.daily)if(day.date/100==prefix && day.date%100>=1 && day.date%100<=31)
      view.days[day.date%100].merit=day.total;
  } else if(gDataStorage.model) {
    const auto& records=gDataStorage.model->current().counts.daily;
    for(auto i=records.lower_bound(prefix*100+1);i!=records.end() && i->first/100==prefix;++i)
      if(i->first%100>=1 && i->first%100<=31)view.days[i->first%100].merit=i->second;
  }
  for(int day=1;day<=CalendarLastSelectableDay();++day) {
    const auto key=CalendarDateKey(day);auto& value=view.days[day];
    const auto pending=gState.pendingDailyTotals.find(key);
    if(pending!=gState.pendingDailyTotals.end())value.merit=pending->second;
    if(key==gState.currentDay)value.merit=gState.todayTotal;
    const auto overtime=gOffwork.days.find(key);
    if(overtime!=gOffwork.days.end() && overtime->second.present) {
      value.overtimeRecorded=true;value.overtimeSeconds=overtime->second.seconds;
    }
    if(value.merit>std::numeric_limits<std::uint64_t>::max()-view.total) {
      view.total=std::numeric_limits<std::uint64_t>::max();view.totalSaturated=true;
    } else view.total+=value.merit;
  }
  return view;
}
int CalendarRows() {return (MondayOffset(gCalendar.year,gCalendar.month)+DaysInMonth(gCalendar.year,gCalendar.month)+6)/7;}
Gdiplus::RectF CalendarCell(int day) {
  const int slot=MondayOffset(gCalendar.year,gCalendar.month)+day-1;
  const float width=(kCalendarWidth-2*kCalendarLeft)/7,height=kCalendarGridHeight/CalendarRows();
  return {kCalendarLeft+(slot%7)*width,kCalendarGridTop+(slot/7)*height,width,height};
}
int CalendarHitDay(float x,float y) {
  if(x<kCalendarLeft || x>=kCalendarWidth-kCalendarLeft || y<kCalendarGridTop || y>=kCalendarGridTop+kCalendarGridHeight)return 0;
  const int column=static_cast<int>((x-kCalendarLeft)/((kCalendarWidth-2*kCalendarLeft)/7));
  const int row=static_cast<int>((y-kCalendarGridTop)/(kCalendarGridHeight/CalendarRows()));
  const int day=row*7+column-MondayOffset(gCalendar.year,gCalendar.month)+1;
  return day>=1 && day<=CalendarLastSelectableDay()?day:0;
}
void LayoutCalendar(HWND window) {
  const float scale=CalendarScale(window);
  const auto move=[&](int id,int x,int y,int w,int h){MoveWindow(GetDlgItem(window,id),
    static_cast<int>(x*scale),static_cast<int>(y*scale),static_cast<int>(w*scale),static_cast<int>(h*scale),TRUE);};
  move(kCalendarPrevious,26,20,30,32);move(kCalendarNext,282,20,30,32);move(kCalendarToday,332,20,100,32);
  HFONT font=CreateFontW(-static_cast<int>(14*scale),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,
    DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
  if(font){for(int id:{kCalendarPrevious,kCalendarNext,kCalendarToday})SendDlgItemMessageW(window,id,WM_SETFONT,reinterpret_cast<WPARAM>(font),TRUE);
    if(gCalendar.font)DeleteObject(gCalendar.font);gCalendar.font=font;}
}
void DrawCalendarButton(const DRAWITEMSTRUCT& item) {
  const float scale=CalendarScale(gCalendar.window);
  Gdiplus::Graphics graphics(item.hDC);graphics.ScaleTransform(scale,scale);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  const float width=(item.rcItem.right-item.rcItem.left)/scale,height=(item.rcItem.bottom-item.rcItem.top)/scale;
  const bool disabled=(item.itemState&ODS_DISABLED)!=0,pressed=(item.itemState&ODS_SELECTED)!=0;
  graphics.Clear(Gdiplus::Color::White);
  Gdiplus::GraphicsPath outline;niuma::ui::RoundPath(outline,{.5f,.5f,width-1,height-1},4);
  Gdiplus::SolidBrush fill(pressed?Gdiplus::Color(255,242,242,244):Gdiplus::Color::White);
  Gdiplus::Pen border(disabled?Gdiplus::Color(255,234,234,236):Gdiplus::Color(255,210,210,214),1);
  graphics.FillPath(&fill,&outline);graphics.DrawPath(&border,&outline);
  const Gdiplus::Color ink=disabled?Gdiplus::Color(255,194,194,199):Gdiplus::Color(255,29,29,31);
  if(item.CtlID==kCalendarToday)DrawCalendarText(graphics,CalendarText(L"回到今天",L"Today"),{6,1,width-12,height-2},14,ink,false,Gdiplus::StringAlignmentCenter);
  else {Gdiplus::Pen chevron(ink,1.5f);const float direction=item.CtlID==kCalendarPrevious?-1.f:1.f;
    const Gdiplus::PointF points[]={{width/2-direction*3,height/2-5},{width/2+direction*3,height/2},{width/2-direction*3,height/2+5}};
    graphics.DrawLines(&chevron,points,3);}
  if(item.itemState&ODS_FOCUS){Gdiplus::Pen focus(Gdiplus::Color(255,188,75,25),1);focus.SetDashStyle(Gdiplus::DashStyleDot);
    graphics.DrawRectangle(&focus,3.f,3.f,width-6,height-6);}
}
void DrawMeritCalendar(HDC dc) {
  RefreshCalendarNavigation();const auto data=ReadCalendarMonth();const auto now=CalendarToday();
  Gdiplus::Graphics graphics(dc);const float scale=CalendarScale(gCalendar.window);graphics.ScaleTransform(scale,scale);
  graphics.Clear(Gdiplus::Color::White);graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintClearTypeGridFit);
  const Gdiplus::Color ink(255,29,29,31),muted(255,110,110,115),accent(255,188,75,25),future(255,170,170,175);
  const Gdiplus::Color rule(255,233,233,236),selection(255,255,241,231);
  std::wstring month=std::to_wstring(gCalendar.year)+(CalendarChinese()?L"年":L" / ")+std::to_wstring(gCalendar.month)+(CalendarChinese()?L"月":L"");
  DrawCalendarText(graphics,month,{70,15,206,42},28,ink,true);
  DrawCalendarText(graphics,CalendarText(L"本月功德",L"This month's merit"),{26,88,420,24},13,muted);
  DrawCalendarText(graphics,(data.totalSaturated?L"≥":L"")+CalendarNumber(data.total),{23,113,440,58},44,ink,true);
  Gdiplus::Pen accentLine(accent,3);graphics.DrawLine(&accentLine,28.f,176.f,62.f,176.f);
  DrawCalendarText(graphics,CalendarText(L"累计功德",L"Total merit"),{490,99,244,23},13,muted,false,Gdiplus::StringAlignmentFar);
  DrawCalendarText(graphics,CalendarNumber(gState.total),{476,124,258,43},28,muted,true,Gdiplus::StringAlignmentFar);
  Gdiplus::Pen line(rule,1);graphics.DrawLine(&line,26.f,194.f,734.f,194.f);
  const wchar_t* zhWeekdays[]={L"一",L"二",L"三",L"四",L"五",L"六",L"日"};
  const wchar_t* enWeekdays[]={L"Mon",L"Tue",L"Wed",L"Thu",L"Fri",L"Sat",L"Sun"};
  const float cellWidth=(kCalendarWidth-52)/7;
  for(int column=0;column<7;++column)DrawCalendarText(graphics,CalendarChinese()?zhWeekdays[column]:enWeekdays[column],
    {26+column*cellWidth,202,cellWidth,24},13,muted,false,Gdiplus::StringAlignmentCenter);
  const int rows=CalendarRows();const float rowHeight=kCalendarGridHeight/rows;
  for(int row=0;row<=rows;++row)graphics.DrawLine(&line,26.f,kCalendarGridTop+row*rowHeight,734.f,kCalendarGridTop+row*rowHeight);
  for(int column=1;column<7;++column)graphics.DrawLine(&line,26+column*cellWidth,kCalendarGridTop,26+column*cellWidth,kCalendarGridTop+kCalendarGridHeight);
  for(int day=1;day<=DaysInMonth(gCalendar.year,gCalendar.month);++day) {
    const auto cell=CalendarCell(day);const bool today=gCalendar.year==now.wYear && gCalendar.month==now.wMonth && day==now.wDay;
    const bool selected=day==gCalendar.selectedDay,futureDay=day>CalendarLastSelectableDay();
    if(selected){Gdiplus::GraphicsPath path;niuma::ui::RoundPath(path,{cell.X+1,cell.Y+1,cell.Width-2,cell.Height-2},7);
      Gdiplus::SolidBrush fill(selection);graphics.FillPath(&fill,&path);}
    DrawCalendarText(graphics,std::to_wstring(day),{cell.X+12,cell.Y+4,cell.Width-22,22},17,
      futureDay?future:(selected||today?accent:ink),!futureDay);
    if(futureDay)continue;const auto& record=data.days[day];
    DrawCalendarText(graphics,record.merit?CalendarCompactNumber(record.merit):L"—",{cell.X+12,cell.Y+26,cell.Width-20,17},12,muted);
    if(record.overtimeRecorded)DrawCalendarText(graphics,CalendarOvertimeShort(record.overtimeSeconds),
      {cell.X+12,cell.Y+42,cell.Width-17,13},10.5f,accent);
  }
  Gdiplus::GraphicsPath detail;niuma::ui::RoundPath(detail,{26,590,708,90},9);
  Gdiplus::SolidBrush detailFill(Gdiplus::Color(255,252,247,242));graphics.FillPath(&detailFill,&detail);
  const auto& selected=data.days[gCalendar.selectedDay];const int weekday=(MondayOffset(gCalendar.year,gCalendar.month)+gCalendar.selectedDay-1)%7;
  const wchar_t* fullWeekdays[]={L"星期一",L"星期二",L"星期三",L"星期四",L"星期五",L"星期六",L"星期日"};
  const auto date=CalendarChinese()?std::to_wstring(gCalendar.month)+L"月"+std::to_wstring(gCalendar.selectedDay)+L"日，"+fullWeekdays[weekday]:
    std::wstring(enWeekdays[weekday])+L", "+std::to_wstring(gCalendar.year)+L"/"+std::to_wstring(gCalendar.month)+L"/"+std::to_wstring(gCalendar.selectedDay);
  DrawCalendarText(graphics,date,{44,603,226,28},17,ink,true);
  if(gCalendar.year==now.wYear && gCalendar.month==now.wMonth && gCalendar.selectedDay==now.wDay)
    DrawCalendarText(graphics,CalendarText(L"今天",L"Today"),{272,603,52,28},12,accent);
  DrawCalendarText(graphics,CalendarText(L"仅记录操作次数，不记录输入内容",L"Counts only. No input content recorded."),{44,643,284,22},10,muted);
  graphics.DrawLine(&line,340.f,608.f,340.f,664.f);graphics.DrawLine(&line,542.f,608.f,542.f,664.f);
  DrawCalendarText(graphics,CalendarText(L"当日功德",L"Day's merit"),{364,601,160,24},12,muted);
  DrawCalendarText(graphics,CalendarNumber(selected.merit),{364,629,160,40},29,ink,true);
  DrawCalendarText(graphics,CalendarText(L"加班时长",L"Overtime"),{564,601,152,24},12,muted);
  DrawCalendarText(graphics,selected.overtimeRecorded?OffworkTimeText(selected.overtimeSeconds):CalendarText(L"未记录",L"Not recorded"),
    {564,629,152,40},selected.overtimeRecorded?27.f:21.f,selected.overtimeRecorded?ink:muted,selected.overtimeRecorded);
  graphics.Flush(Gdiplus::FlushIntentionSync);
}
void PaintMeritCalendar(HWND window) {
  PAINTSTRUCT paint{};HDC dc=BeginPaint(window,&paint);RECT client{};GetClientRect(window,&client);
  if(dc && client.right>0 && client.bottom>0)niuma::ui::PaintBuffered(dc,client,[](HDC memory){DrawMeritCalendar(memory);});
  EndPaint(window,&paint);
}
void CalendarShiftMonth(int delta) {
  RefreshCalendarNavigation();const auto current=niuma::CalendarMonthRange::Month(gCalendar.year,gCalendar.month);
  const auto next=gCalendar.range.Shift(current,delta);gCalendar.year=next/12;gCalendar.month=next%12+1;
  RefreshCalendarNavigation();if(gCalendar.window)InvalidateRect(gCalendar.window,nullptr,FALSE);
}
void CalendarMoveSelection(int delta) {
  RefreshCalendarNavigation();const int next=gCalendar.selectedDay+delta;
  if(next>=1 && next<=CalendarLastSelectableDay())gCalendar.selectedDay=next;
  else if(next<1){const auto oldMonth=gCalendar.month;const auto oldYear=gCalendar.year;CalendarShiftMonth(-1);
    if(gCalendar.month!=oldMonth || gCalendar.year!=oldYear)gCalendar.selectedDay=std::max(1,DaysInMonth(gCalendar.year,gCalendar.month)+next);}
  else if(next>DaysInMonth(gCalendar.year,gCalendar.month)){
    const auto oldMonth=gCalendar.month;const auto oldYear=gCalendar.year;CalendarShiftMonth(1);
    if(gCalendar.month!=oldMonth || gCalendar.year!=oldYear)gCalendar.selectedDay=std::min(CalendarLastSelectableDay(),next-DaysInMonth(oldYear,oldMonth));}
  if(gCalendar.window)InvalidateRect(gCalendar.window,nullptr,FALSE);
}
LRESULT CALLBACK CalendarWindowProcedure(HWND window,UINT message,WPARAM wParam,LPARAM lParam) {
  switch(message) {
    case WM_ERASEBKGND:return 1;
    case WM_DRAWITEM:{const auto* item=reinterpret_cast<const DRAWITEMSTRUCT*>(lParam);
      if(item && item->CtlID>=kCalendarPrevious && item->CtlID<=kCalendarToday){DrawCalendarButton(*item);return TRUE;}break;}
    case WM_PAINT:PaintMeritCalendar(window);return 0;
    case WM_PRINTCLIENT:DrawMeritCalendar(reinterpret_cast<HDC>(wParam));return 0;
    case WM_SIZE:LayoutCalendar(window);InvalidateRect(window,nullptr,FALSE);return 0;
    case WM_DPICHANGED:{const auto* rect=reinterpret_cast<const RECT*>(lParam);SetWindowPos(window,nullptr,rect->left,rect->top,
      rect->right-rect->left,rect->bottom-rect->top,SWP_NOZORDER|SWP_NOACTIVATE);return 0;}
    case WM_GETDLGCODE:return DLGC_WANTARROWS;
    case WM_COMMAND:{
      if(LOWORD(wParam)==IDCANCEL){DestroyWindow(window);return 0;}
      if(LOWORD(wParam)==kCalendarPrevious)CalendarShiftMonth(-1);
      else if(LOWORD(wParam)==kCalendarNext)CalendarShiftMonth(1);
      else if(LOWORD(wParam)==kCalendarToday){const auto today=CalendarToday();gCalendar.year=today.wYear;gCalendar.month=today.wMonth;
        gCalendar.selectedDay=today.wDay;RefreshCalendarNavigation();InvalidateRect(window,nullptr,FALSE);}
      SetFocus(window);return 0;}
    case WM_LBUTTONUP:{const float scale=CalendarScale(window);const int day=CalendarHitDay(GET_X_LPARAM(lParam)/scale,GET_Y_LPARAM(lParam)/scale);
      if(day){gCalendar.selectedDay=day;SetFocus(window);InvalidateRect(window,nullptr,FALSE);}return 0;}
    case WM_KEYDOWN:
      if(wParam==VK_ESCAPE){DestroyWindow(window);return 0;}
      if(wParam==VK_LEFT || wParam==VK_RIGHT || wParam==VK_UP || wParam==VK_DOWN)
        CalendarMoveSelection(wParam==VK_LEFT?-1:wParam==VK_RIGHT?1:wParam==VK_UP?-7:7);
      else if(wParam==VK_PRIOR || wParam==VK_NEXT)CalendarShiftMonth(wParam==VK_PRIOR?-1:1);
      else if(wParam==VK_HOME || wParam==VK_END){gCalendar.selectedDay=wParam==VK_HOME?1:CalendarLastSelectableDay();InvalidateRect(window,nullptr,FALSE);}
      return 0;
    case WM_CLOSE:DestroyWindow(window);return 0;
    case WM_DESTROY:if(gCalendar.font){DeleteObject(gCalendar.font);gCalendar.font=nullptr;}gCalendar.window=nullptr;return 0;
    default:break;
  }
  return DefWindowProcW(window,message,wParam,lParam);
}
void ShowMeritCalendar(HWND owner) {
  RequestInputLedger();
  if(!gCalendar.window){
    const auto now=CalendarToday();gCalendar.year=now.wYear;gCalendar.month=now.wMonth;gCalendar.selectedDay=now.wDay;
    RECT work{};SystemParametersInfoW(SPI_GETWORKAREA,0,&work,0);
    const auto style=WS_CAPTION|WS_SYSMENU|WS_CLIPCHILDREN;
    RECT desired{0,0,ScaleDip(static_cast<int>(kCalendarWidth),gState.dpi),ScaleDip(static_cast<int>(kCalendarHeight),gState.dpi)};
    AdjustWindowRectEx(&desired,style,FALSE,WS_EX_TOOLWINDOW);
    const int width=std::min(desired.right-desired.left,work.right-work.left),height=std::min(desired.bottom-desired.top,work.bottom-work.top);
    gCalendar.window=CreateWindowExW(WS_EX_TOOLWINDOW,kCalendarClass,CalendarText(L"功德日历",L"Merit Calendar"),style,
      work.left+(work.right-work.left-width)/2,work.top+(work.bottom-work.top-height)/2,width,height,owner,nullptr,GetModuleHandleW(nullptr),nullptr);
    if(!gCalendar.window)return;
    for(const auto id:{kCalendarPrevious,kCalendarNext,kCalendarToday})CreateWindowExW(0,L"BUTTON",
      id==kCalendarPrevious?L"‹":id==kCalendarNext?L"›":CalendarText(L"回到今天",L"Today"),WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,
      0,0,1,1,gCalendar.window,reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),GetModuleHandleW(nullptr),nullptr);
  }
  ReloadCalendarRange();RefreshCalendarNavigation();LayoutCalendar(gCalendar.window);niuma::ui::WindowChrome(gCalendar.window);
  ShowWindow(gCalendar.window,SW_SHOW);SetForegroundWindow(gCalendar.window);SetFocus(gCalendar.window);InvalidateRect(gCalendar.window,nullptr,FALSE);
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

void DrawAppearancePicker(HDC dc, HDC updateDc, const RECT& client) {
  FillRect(dc, &client, niuma::ui::CanvasBrush());
  Gdiplus::Graphics graphics(dc);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
  const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
  // Cards never paint into the native button area, including partial rows.
  graphics.SetClip(Gdiplus::Rect(0, 0, client.right,
      std::min(client.bottom, static_cast<LONG>(ScaleDip(442, dpi)))));
  for (int index = 0; index < PickerItemCount(); ++index) {
    const RECT card = PickerCardRect(index, dpi);
    if (card.bottom <= 0 || card.top >= ScaleDip(442, dpi) ||
        !RectVisible(updateDc, &card)) continue;
    const bool selected = index == gPicker.pendingIndex;
    Gdiplus::SolidBrush background(selected
        ? Gdiplus::Color(255, 230, 241, 255)
        : Gdiplus::Color(255, 255, 255, 255));
    Gdiplus::Pen border(selected
        ? Gdiplus::Color(255, 0, 112, 245)
        : Gdiplus::Color(255, 222, 224, 230),
        selected ? static_cast<float>(ScaleDip(2, dpi)) : 1.0f);
    const Gdiplus::RectF cardRect(
        static_cast<float>(card.left), static_cast<float>(card.top),
        static_cast<float>(card.right - card.left),
        static_cast<float>(card.bottom - card.top));
    Gdiplus::GraphicsPath cardPath;
    niuma::ui::RoundPath(cardPath, cardRect, static_cast<float>(ScaleDip(14, dpi)));
    graphics.FillPath(&background, &cardPath);
    graphics.DrawPath(&border, &cardPath);

    Gdiplus::Image* thumbnail = gAppearance.builtinThumbnail.get();
    bool failed = false;
    if (index != 0) {
      const auto source = niuma::RequestAppearanceResources(
          *gAppearanceCatalog.packs()[static_cast<size_t>(index - 1)]);
      const auto* cached = gAppearance.thumbnails.Find(source);
      thumbnail = cached ? cached->image.image.get() : nullptr;
      failed = ThumbnailFailed(source);
    }
    // Fit the original canvas inside the preview area without stretching it.
    const float previewWidth = static_cast<float>(ScaleDip(116, dpi));
    const float previewHeight = static_cast<float>(ScaleDip(76, dpi));
    if (thumbnail) {
      const float previewScale = std::min(previewWidth / thumbnail->GetWidth(),
                                          previewHeight / thumbnail->GetHeight());
      const float imageWidth = thumbnail->GetWidth() * previewScale;
      const float imageHeight = thumbnail->GetHeight() * previewScale;
      graphics.DrawImage(thumbnail, Gdiplus::RectF(
          static_cast<float>(card.left + ScaleDip(20, dpi)) + (previewWidth - imageWidth) / 2,
          static_cast<float>(card.top + ScaleDip(22, dpi)) + (previewHeight - imageHeight) / 2,
          imageWidth, imageHeight));
    } else {
      Gdiplus::Font font(L"Microsoft YaHei UI", static_cast<float>(ScaleDip(12, dpi)),
          Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
      Gdiplus::SolidBrush ink(Gdiplus::Color(255, 105, 110, 118));
      Gdiplus::StringFormat format;
      format.SetAlignment(Gdiplus::StringAlignmentCenter);
      format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
      graphics.DrawString(failed ? UiText(L"预览不可用", L"Preview unavailable") :
          UiText(L"准备预览中", L"Preparing preview"), -1, &font,
          Gdiplus::RectF(static_cast<float>(card.left + ScaleDip(10, dpi)),
              static_cast<float>(card.top + ScaleDip(22, dpi)),
              static_cast<float>(ScaleDip(136, dpi)), previewHeight), &format, &ink);
    }
    std::wstring badge;
    if (index == CurrentPickerIndex()) badge = UiText(L"当前", L"Current");
    if (index > 0) {
      const auto& id = gAppearanceCatalog.packs()[static_cast<size_t>(index - 1)]->id;
      if (gAppearance.currentRequest && gAppearance.currentRequest->source.id == id)
        badge = UiText(L"准备中", L"Preparing");
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
      Gdiplus::SolidBrush badgeInk(Gdiplus::Color(255, 0, 95, 210));
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
    Gdiplus::SolidBrush text(Gdiplus::Color(255, 29, 29, 31));
    const std::wstring title = PickerItemTitle(index);
    graphics.DrawString(title.c_str(), -1, &font,
        Gdiplus::RectF(static_cast<float>(card.left),
            static_cast<float>(card.top + ScaleDip(100, dpi)),
            static_cast<float>(card.right - card.left),
            static_cast<float>(ScaleDip(25, dpi))), &format, &text);
  }
  graphics.Flush(Gdiplus::FlushIntentionSync);
}

void PaintAppearancePicker(HWND window) {
  PAINTSTRUCT paint = {};
  HDC dc = BeginPaint(window, &paint);
  RECT client = {};
  GetClientRect(window, &client);
  const int width = client.right - client.left;
  const int height = client.bottom - client.top;
  if (dc == nullptr || width <= 0 || height <= 0 || IsRectEmpty(&paint.rcPaint)) {
    EndPaint(window, &paint);
    return;
  }
  HDC bufferDc = CreateCompatibleDC(dc);
  HBITMAP bitmap = bufferDc ? CreateCompatibleBitmap(dc, width, height) : nullptr;
  HGDIOBJ previousBitmap = bitmap ? SelectObject(bufferDc, bitmap) : nullptr;
  const bool buffered = previousBitmap != nullptr && previousBitmap != HGDI_ERROR;
  if (buffered) {
    // Match the calendar's buffered rendering: never expose a cleared frame.
    DrawAppearancePicker(bufferDc, dc, client);
    BitBlt(dc, paint.rcPaint.left, paint.rcPaint.top,
        paint.rcPaint.right - paint.rcPaint.left, paint.rcPaint.bottom - paint.rcPaint.top,
        bufferDc, paint.rcPaint.left, paint.rcPaint.top, SRCCOPY);
    SelectObject(bufferDc, previousBitmap);
  } else {
    DrawAppearancePicker(dc, dc, client);
  }
  if (bitmap) DeleteObject(bitmap);
  if (bufferDc) DeleteDC(bufferDc);
  EndPaint(window, &paint);
}

LRESULT CALLBACK PickerWindowProcedure(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_ERASEBKGND:
      return 1;
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
      QueueVisibleThumbnails();
      return 0;
    case WM_LBUTTONUP: {
      const POINT point = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
      const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
      if (point.y < 0 || point.y >= ScaleDip(442, dpi)) return 0;
      for (int index = 0; index < PickerItemCount(); ++index) {
        const RECT card = PickerCardRect(index, dpi);
        if (PtInRect(&card, point)) {
          if (gPicker.pendingIndex == index) return 0;
          RECT previous = PickerCardRect(gPicker.pendingIndex, dpi);
          RECT selected = card;
          const int margin = ScaleDip(2, dpi);
          InflateRect(&previous, margin, margin);
          InflateRect(&selected, margin, margin);
          gPicker.pendingIndex = index;
          InvalidateRect(window, &previous, FALSE);
          InvalidateRect(window, &selected, FALSE);
          break;
        }
      }
      return 0;
    }
    case WM_MOUSEWHEEL: {
      const int maximumRow = std::max(0, (PickerItemCount() + 1) / 2 - 3);
      const int nextRow = std::clamp(
          gPicker.scrollRow + (GET_WHEEL_DELTA_WPARAM(wParam) < 0 ? 1 : -1),
          0, maximumRow);
      if (nextRow != gPicker.scrollRow) {
        gPicker.scrollRow = nextRow;
        const UINT dpi = gState.dpi == 0 ? 96 : gState.dpi;
        const RECT grid = {0, 0, ScaleDip(360, dpi), ScaleDip(442, dpi)};
        InvalidateRect(window, &grid, FALSE);
        QueueVisibleThumbnails();
      }
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
          niuma::ui::Message(window,
              UiText(L"内置形象不能删除。", L"Built-in appearances cannot be deleted."),
              WindowTitle(), MB_OK | MB_ICONINFORMATION);
          return 0;
        }
        const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 1);
        if (packIndex >= gAppearanceCatalog.packs().size()) return 0;
        const std::string id = gAppearanceCatalog.packs()[packIndex]->id;
        if (niuma::ui::Message(window,
                UiText(L"删除所选的本地形象包？",
                       L"Delete the selected local appearance pack?"),
                WindowTitle(), MB_YESNO | MB_ICONQUESTION) != IDYES) return 0;
        std::wstring error;
        if (!gAppearanceCatalog.Delete(id, &error)) {
          niuma::ui::Message(window, error.c_str(), WindowTitle(), MB_OK | MB_ICONERROR);
          return 0;
        }
        if (gState.selectedPackId == id) RequestCurrentAppearance({}, false);
        AppearanceCatalogChanged();
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
  std::wstring catalogError;
  gAppearanceCatalog.ReloadMetadata(AppearanceDirectory(), &catalogError);
  AppearanceCatalogChanged();
  if (!catalogError.empty()) ReportAppearanceFailure(catalogError);
  gPicker.pendingIndex = CurrentPickerIndex();
  PrepareBuiltinThumbnail();
  if (!gAppearanceCatalog.packs().empty()) InitializeAppearanceResources();
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
      WS_EX_TOOLWINDOW, kPickerClass, UiText(L"更换形象", L"Change Appearance"), WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN,
      pickerX, pickerY,
      width, height, owner, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (gPicker.window == nullptr) return;
  niuma::ui::Apply(gPicker.window);
  EnableWindow(owner, FALSE);
  ShowWindow(gPicker.window, SW_SHOW);
  QueueVisibleThumbnails();
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
      RequestCurrentAppearance({});
    } else {
      const size_t packIndex = static_cast<size_t>(gPicker.pendingIndex - 1);
      if (packIndex >= gAppearanceCatalog.packs().size()) return;
      RequestCurrentAppearance(gAppearanceCatalog.packs()[packIndex]->id);
    }
  }
}

std::wstring ImportFileArgument() {
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments == nullptr) return {};
  std::wstring result;
  for (int index = 1; index < argumentCount; ++index) {
    const std::wstring argument(arguments[index]);
    if (niuma::IsAppearancePackPath(argument) ||
        niuma::IsAppearanceBatchPath(argument) ||
        niuma::reminder::IsCatalogPackagePath(std::filesystem::path(argument))) {
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
    niuma::ui::Message(owner,
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
  AppearanceCatalogChanged();
  const bool singleRequested = !batch && installed && gLastImportedIds.size() == 1;
  const bool singleAccepted = singleRequested && RequestCurrentAppearance(gLastImportedIds.front(), false);
  // Refresh the current pack without implicitly selecting the last batch member.
  RenderLayeredWindow(GetTickCount64());
  if (gPicker.window && IsWindow(gPicker.window)) {
    gPicker.pendingIndex = CurrentPickerIndex();
    InvalidateRect(gPicker.window, nullptr, FALSE);
  }
  std::wstring message = singleAccepted
      ? UiText(L"导入完成，正在准备形象；准备成功后自动启用，失败时保留当前形象。",
               L"Imported. The appearance is being prepared and will be enabled when ready; a preparation failure keeps the current appearance.")
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
  if (canChoose && !singleRequested)
    message += UiText(L"\n\n现在打开形象列表选择吗？", L"\n\nOpen the appearance list to choose now?");
  if (showSuccess || !installed || !error.empty()) {
    const int response = niuma::ui::Message(owner, message.c_str(),
        !installed ? (canChoose ? UiText(L"部分形象已导入", L"Some Packs Imported")
                               : UiText(L"未能导入形象", L"No Packs Imported"))
                   : WindowTitle(),
        (canChoose && !singleRequested ? MB_YESNO : MB_OK) |
        (!installed || !error.empty() ? MB_ICONWARNING : MB_ICONINFORMATION));
    if (response == IDYES && IsMainWindowAlive(owner)) ShowAppearancePicker(owner);
  }
}

bool ShowPrivacyNoticeIfNeeded(HWND owner) {
  if (!IsMainWindowAlive(owner)) return false;
  if (gDataStorage.model && gDataStorage.model->current().guide.basicGuideShown) return true;
  if (!ShowPrivacyNotice(owner) || !IsMainWindowAlive(owner)) return false;
  if (gDataStorage.model) {
    MergeDataUpdate(gDataStorage.model->UpdateGuide({true, true}, GetTickCount64()));
    PumpDataStorage();
  }
  return true;
}

void ImportOfficialMessages(HWND owner, const std::wstring& filename);

void ImportPackageFile(HWND owner, const std::wstring& filename) {
  if (niuma::reminder::IsCatalogPackagePath(std::filesystem::path(filename)))
    ImportOfficialMessages(owner, filename);
  else
    ImportAppearancePack(owner, filename, true);
}

void DrainPendingImport(HWND window, void (*importFile)(HWND, const std::wstring&)) {
  if (!gImportReady || gImportActive || gPendingImports.empty()) return;
  const std::wstring path = gPendingImports.front();
  gPendingImports.erase(gPendingImports.begin());
  gImportActive = true;
  importFile(window, path);
  gImportActive = false;
  if (!gPendingImports.empty()) PostMessageW(window, kImportQueuedMessage, 0, 0);
}

bool PrepareClientStartup(HWND owner, const std::wstring& pendingImportFile) {
  if (!IsMainWindowAlive(owner)) return false;
  if (!pendingImportFile.empty()) ImportPackageFile(owner, pendingImportFile);
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
        SendMessageW(child, WM_SETFONT, static_cast<WPARAM>(
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
      niuma::ui::Apply(window);
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
        if (!saved || !ticking) niuma::ui::Message(window,
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
    niuma::ui::Message(owner, UiText(L"无法打开下班倒计时设置。", L"Unable to open countdown settings."),
        WindowTitle(), MB_OK | MB_ICONERROR);
  }
}

void ImportOfficialMessages(HWND owner, const std::wstring& filename) {
  if (!gState.catalogStore) {
    niuma::ui::Message(owner,
        UiText(L"本地文案库暂不可用，请退出应用后重试。",
               L"The local message catalog is unavailable. Quit the app and try again."),
        UiText(L"无法导入文案包", L"Could Not Import Messages"),
        MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
    return;
  }
  auto result = gState.catalogStore->InstallFile(std::filesystem::path(filename),
      niuma::reminder::OfficialCatalogSignatureVerifier());
  if (result.status == niuma::reminder::CatalogInstallStatus::Installed ||
      result.status == niuma::reminder::CatalogInstallStatus::AlreadyInstalled) {
    gState.reminderCatalog = result.catalog;
    size_t chinese = 0, english = 0;
    for (const auto& item : gState.reminderCatalog->items) {
      if (std::strcmp(item.language, "zh-CN") == 0) ++chinese;
      else if (std::strcmp(item.language, "en") == 0) ++english;
    }
    wchar_t message[256]{};
    swprintf_s(message, std::size(message), UiText(
        L"文案库版本 %u 已就绪（中文 %zu 条，英文 %zu 条）。提醒历史保持不变。",
        L"Message catalog version %u is ready (%zu Chinese, %zu English). Reminder history is unchanged."),
        gState.reminderCatalog->content_version, chinese, english);
    niuma::ui::Message(owner, message, UiText(L"文案包已导入", L"Messages Imported"),
        MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
    return;
  }
  const wchar_t* message = UiText(
      L"文件未安装，当前文案库和提醒历史保持不变。请确认文件来自官方并且版本较新。",
      L"The file was not installed. Your current catalog and reminder history are unchanged. Check that it is an official, newer catalog.");
  if (result.status == niuma::reminder::CatalogInstallStatus::CommitUncertain)
    message = UiText(L"文案库文件已完成本地替换，但系统未确认目录写入已持久保存。当前进程仍使用原文案库；重启后会按本地签名验证结果加载。请勿把本次提示视为已完成导入。提醒历史保持不变。",
                     L"The catalog files were replaced locally, but the system could not confirm durable directory storage. This process keeps using the previous catalog; after restart, the app will load whichever local catalog passes signature verification. Treat the import as unconfirmed. Reminder history is unchanged.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::UntrustedSignature)
    message = UiText(L"签名无效或发布密钥不受信任，当前文案库保持不变。",
                     L"The signature is invalid or its publisher key is not trusted. Your current catalog is unchanged.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::Downgrade)
    message = UiText(L"此文案库版本较旧，不能覆盖已安装的新版本。",
                     L"This catalog is older than the highest installed version and cannot replace it.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::SameVersionDifferentContent)
    message = UiText(L"相同版本号对应了不同内容，文件未安装。",
                     L"This version number is already associated with different content. The file was not installed.");
  niuma::ui::Message(owner, message, UiText(L"无法导入文案包", L"Could Not Import Messages"),
      MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
}

bool InstallTrayIcon(HWND window) {
  gTray = {};
  gTray.cbSize = sizeof(gTray); gTray.hWnd = window; gTray.uID = 1;
  gTray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  gTray.uCallbackMessage = kTrayMessage;
  gTray.hIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(103));
  if (!gTray.hIcon) gTray.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(gTray.szTip, UiText(L"牛马电子功德 · 右键可显示或隐藏形象",
      L"NiuMa Merit - right-click to show or hide"));
  const bool installed = Shell_NotifyIconW(NIM_ADD, &gTray) != FALSE;
  if (installed) { gTray.uVersion = NOTIFYICON_VERSION_4; Shell_NotifyIconW(NIM_SETVERSION, &gTray); }
  gVisibility.recoveryAvailable = installed;
  return installed;
}

bool ForegroundIsFullscreen() {
  HWND foreground = GetForegroundWindow();
  if (!foreground) return false;
  DWORD pid = 0; GetWindowThreadProcessId(foreground, &pid);
  // Opening our tray/menu/settings must not briefly unhide the pet over a game.
  if (pid == GetCurrentProcessId()) foreground = gLastFullscreenWindow;
  if (!foreground || !IsWindow(foreground)) return false;
  if (!IsWindowVisible(foreground) || IsIconic(foreground) ||
      foreground == GetDesktopWindow() || foreground == GetShellWindow()) return false;
  wchar_t name[128]{}; GetClassNameW(foreground, name, 128);
  for (const auto* shell : {L"Progman", L"WorkerW", L"Shell_TrayWnd", L"Shell_SecondaryTrayWnd"})
    if (wcscmp(name, shell) == 0) return false;
  QUERY_USER_NOTIFICATION_STATE notification{};
  if (SUCCEEDED(SHQueryUserNotificationState(&notification)) &&
      notification == QUNS_RUNNING_D3D_FULL_SCREEN) { gLastFullscreenWindow = foreground; return true; }
  MONITORINFO monitor{}; monitor.cbSize = sizeof(monitor);
  if (!GetMonitorInfoW(MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST), &monitor)) return false;
  // Users expect a maximized work window to keep the pet out of the way too.
  // Check native state rather than matching its taskbar/resize-border geometry.
  bool fullscreen = IsZoomed(foreground) != FALSE;
  if (!fullscreen) {
    // Use the content area in screen coordinates: invisible resize borders and
    // DWM shadows must neither cause a miss nor make a windowed video fullscreen.
    RECT client{}; POINT origin{};
    if (!GetClientRect(foreground, &client) || !ClientToScreen(foreground, &origin)) return false;
    fullscreen = niuma::client::core::CoversFullscreenMonitor(
        {origin.x,origin.y,static_cast<std::int64_t>(origin.x) + client.right,
         static_cast<std::int64_t>(origin.y) + client.bottom},
        {monitor.rcMonitor.left,monitor.rcMonitor.top,monitor.rcMonitor.right,monitor.rcMonitor.bottom});
  }
  if (fullscreen) gLastFullscreenWindow = foreground;
  return fullscreen;
}

void ApplyWindowVisibility() {
  const bool hidden = gVisibility.hidden();
  if (!gState.window || hidden == gVisibilityHidden) return;
  gVisibilityHidden = hidden;
  KillTimer(gState.window, kAnimationTimer); gState.timerRunning = false;
  gState.striking = false; gInput.previewUntil = 0;
  if (hidden) {
    CancelPendingReminder();
    if (gReminderWindow) DestroyWindow(gReminderWindow);
    ShowWindow(gState.window, SW_HIDE);
  } else {
    // Render the latest totals once. Hidden input never becomes an animation backlog.
    if (UsesCompositionRuntime() && gDisplay.display) gDisplay.display->Invalidate();
    RenderLayeredWindow(GetTickCount64());
    if (!gDisplay.failed) ShowWindow(gState.window, SW_SHOWNOACTIVATE);
  }
}

void RefreshFullscreenVisibility() {
  gVisibility.fullscreen = gVisibility.autoHideFullscreen && ForegroundIsFullscreen();
  if (!gVisibility.fullscreen) gVisibility.showDuringFullscreen = false;
  ApplyWindowVisibility();
}

void SetManualHidden(bool hidden) {
  // Refuse to hide if the recovery icon could not be installed.
  if (hidden && !gVisibility.recoveryAvailable && !InstallTrayIcon(gState.window)) {
    niuma::ui::Message(gState.window, UiText(L"托盘入口暂不可用，形象保持显示。请稍后重试。",
        L"The tray entry is unavailable. The appearance remains visible; try again later."),
        WindowTitle(), MB_OK | MB_ICONWARNING);
    return;
  }
  gVisibility.fullscreen = gVisibility.autoHideFullscreen && ForegroundIsFullscreen();
  gVisibility.manualHidden = hidden;
  gVisibility.showDuringFullscreen = !hidden && gVisibility.fullscreen;
  RefreshFullscreenVisibility();
}

void ToggleAutoHideFullscreen() {
  gVisibility.autoHideFullscreen = !gVisibility.autoHideFullscreen;
  gVisibility.showDuringFullscreen = false;
  if (gDataStorage.model) {
    MergeDataUpdate(gDataStorage.model->UpdateAutoHideFullscreen(
        gVisibility.autoHideFullscreen, GetTickCount64()));
    ArmDataStorageTimer();
  }
  RefreshFullscreenVisibility();
}

void ShowContextMenu(HWND window, POINT screenPoint) {
  if (gDataStorage.closing) { ShowCountingStatus(window); return; }
  HMENU menu = CreatePopupMenu();
  if (menu == nullptr) {
    return;
  }
  std::vector<niuma::ui::MenuItem> items;
  items.reserve(12);
  const auto append = [&](UINT_PTR id, const wchar_t* text, const wchar_t* icon,
                           bool checked = false, bool dividerBefore = false) {
    items.push_back({text, icon, checked, dividerBefore});
    AppendMenuW(menu, MF_OWNERDRAW |
        (checked ? MF_CHECKED : 0), id, reinterpret_cast<const wchar_t*>(&items.back()));
  };
  append(kMenuVisibility, gVisibility.hidden() ? UiText(L"显示形象（继续计数）", L"Show Appearance") :
      UiText(L"隐藏形象（继续计数）", L"Hide (Keep Counting)"), L"\xE890");
  append(kMenuAutoHide, UiText(L"全屏或最大化时自动隐身", L"Auto-hide in Fullscreen or Maximized"), L"\xE740", gVisibility.autoHideFullscreen);
  append(kMenuAppearance, UiText(L"更换形象", L"Change Appearance"), L"\xE77B");
  append(kMenuCalendar, UiText(L"功德日历…", L"Merit Calendar…"), L"\xE787");
  append(kMenuOffwork, UiText(L"下班倒计时…", L"Off-work Countdown…"), L"\xE823", gOffwork.enabled);
  if (IsRuntimeCandidate()) {
    append(kMenuLaunchAtLogin, UiText(L"测试数据 · 自动启动已禁用", L"Test data · Startup disabled"), L"\xE7F4", false, true);
    EnableMenuItem(menu, kMenuLaunchAtLogin, MF_BYCOMMAND | MF_GRAYED);
  } else {
    append(kMenuLaunchAtLogin, UiText(L"登录后自动启动", L"Start at Login"), L"\xE7F4", IsLaunchAtLoginEnabled(), true);
    if (gIsolatedAcceptance) EnableMenuItem(menu, kMenuLaunchAtLogin, MF_BYCOMMAND | MF_GRAYED);
  }
  append(kMenuAbout, UiText(L"关于牛马电子功德", L"About NiuMa Merit"), L"\xE946", false, true);
  append(kMenuQuit, UiText(L"退出", L"Exit"), L"\xE8AC");
  MENUINFO style{}; style.cbSize = sizeof(style); style.fMask = MIM_BACKGROUND | MIM_STYLE;
  style.hbrBack = niuma::ui::WhiteBrush(); style.dwStyle = MNS_NOCHECK;
  SetMenuInfo(menu, &style);

  // A hidden pet cannot become a foreground menu owner. A zero-size native
  // tool window owns only this popup, so outside clicks can dismiss it without
  // briefly showing the hidden appearance or stopping the message pump.
  HWND menuOwner = window;
  HWND temporaryOwner = nullptr;
  if (!IsWindowVisible(window)) {
    WNDCLASSW ownerClass{}; ownerClass.hInstance = GetModuleHandleW(nullptr);
    ownerClass.lpszClassName = L"NiuMaMeritTrayMenuOwner";
    ownerClass.lpfnWndProc = [](HWND hwnd, UINT message, WPARAM w, LPARAM l) -> LRESULT {
      if (message == WM_MEASUREITEM || message == WM_DRAWITEM)
        return SendMessageW(gState.window, message, w, l);
      return DefWindowProcW(hwnd, message, w, l);
    };
    RegisterClassW(&ownerClass);
    temporaryOwner = CreateWindowExW(WS_EX_TOOLWINDOW, ownerClass.lpszClassName, L"",
        WS_POPUP, screenPoint.x, screenPoint.y, 0, 0, nullptr, nullptr, ownerClass.hInstance, nullptr);
    if (temporaryOwner) { ShowWindow(temporaryOwner, SW_SHOWNOACTIVATE); menuOwner = temporaryOwner; }
  }
  const int command = niuma::ui::TrackMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, screenPoint, menuOwner);
  if (temporaryOwner) DestroyWindow(temporaryOwner);
  DestroyMenu(menu);

  if (command == static_cast<int>(kMenuVisibility)) {
    SetManualHidden(!gVisibility.hidden());
  } else if (command == static_cast<int>(kMenuAutoHide)) {
    ToggleAutoHideFullscreen();
  } else if (command == static_cast<int>(kMenuAbout)) {
    ShowAboutDialog(window);
  } else if (command == static_cast<int>(kMenuLaunchAtLogin)) {
    if (gIsolatedAcceptance) return;
    const bool enabled = !IsLaunchAtLoginEnabled();
    if (SetLaunchAtLoginEnabled(enabled)) {
      SaveLaunchAtLoginPreference(enabled);
    } else {
      niuma::ui::Message(window,
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
    PostMessageW(window, WM_CLOSE, 0, 0);
  }
}

void CancelClientClose(HWND window) {
  const bool resumeInput = !gIsolatedAcceptance || IsRuntimeCandidate() ||
      (gDataStorage.sessionQueryPending && gDataStorage.sessionResumeInput);
  gDataStorage.sessionQueryPending = false;
  gDataStorage.sessionResumeInput = false;
  gDataStorage.closing = false;
  gDataStorage.closeNoticeShown = false;
  gDataStorage.closeFailurePrompt = false;
  ShutdownBlockReasonDestroy(window);
  gOffwork.suspended = gDataStorage.wasOffworkSuspended;
  gOffwork.baselineValid = false;
  SetTimer(window, kDayTimer, 30000, nullptr);
  SetTimer(window, kReminderTimer, 1000, nullptr);
  SyncOffworkTimer();
  if (resumeInput) RestartGlobalListeners();
  gImportReady = window && IsWindow(window);
  if (gImportReady && !gPendingImports.empty()) PostMessageW(window, kImportQueuedMessage, 0, 0);
  ArmDataStorageTimer();
  PumpAppearanceResources();
  RefreshCountingStatus();
}

void ContinueClientClose(HWND window) {
  if (!gDataStorage.closing || gDataStorage.readyToDestroy || gDataStorage.closeFailurePrompt ||
      gDataStorage.sessionQueryPending) return;
  if (gDataStorage.model && gDataStorage.service && !gDataStorage.stopping) {
    PumpDataStorage();
    if ((gDataStorage.model->save_failed() || gDataStorage.mergeFailed) && !gDataStorage.model->in_flight()) {
      gDataStorage.closeFailurePrompt = true;
      const int response = niuma::ui::Message(window,
          UiText(L"最后的功德和设置尚未保存。选择“重试”继续保存并退出；选择“取消”返回程序，记录会继续保留在内存中。",
                 L"The final counts and settings have not been saved. Retry to save and exit, or Cancel to keep the app running with the records retained in memory."),
          WindowTitle(), MB_RETRYCANCEL | MB_ICONWARNING);
      gDataStorage.closeFailurePrompt = false;
      if (response != IDRETRY && window && IsWindow(window)) { CancelClientClose(window); return; }
      PumpDataStorage(true);
    }
    if (!DataStorageIdle()) {
      if (!gDataStorage.model->save_failed() && !gDataStorage.model->in_flight()) PumpDataStorage(true);
      if (!gDataStorage.closeNoticeShown && GetTickCount64() - gDataStorage.closeStarted >= 5000) {
        gDataStorage.closeNoticeShown = true;
        ShowCountingStatus(window);
      }
      ArmDataStorageTimer();
      return;
    }
    gDataStorage.stopping = true;
  }
  if (gDataStorage.service) {
    const auto stop = gDataStorage.service->Stop(0);
    if (stop.hasResult) ApplyDataStorageResult(stop.result);
    if (!stop.stopped) { ArmDataStorageTimer(); return; }
  }
  if (!StopAppearanceResources()) { ArmDataStorageTimer(); return; }
  gDataStorage.readyToDestroy = true;
  if (gDataStorage.orphanTimer) {
    KillTimer(nullptr, gDataStorage.orphanTimer); gDataStorage.orphanTimer = 0;
  }
  if (window && IsWindow(window)) {
    ShutdownBlockReasonDestroy(window);
    DestroyWindow(window);
  } else PostQuitMessage(0);
}

void PrepareClientClose(HWND window) {
  if (gDataStorage.closing) return;
  gDataStorage.closing = true;
  gDataStorage.closeStarted = GetTickCount64();
  gDataStorage.wasOffworkSuspended = gOffwork.suspended;
  gImportReady = false;
  // Pending selection is not a committed appearance. Retain the old prepared
  // pack during a cancellable system query and ignore its superseded result.
  CancelAppearanceRequests();
  // Collect the final complete ledger while both owners and the notification
  // HWND still exist. No more inputs may race the last saved snapshot.
  StopInputService();
  RefreshOffwork(true, true);
  gOffwork.suspended = true;
  KillTimer(window, kOffworkTimer); gOffwork.timerRunning = false;
  KillTimer(window, kDayTimer); KillTimer(window, kReminderTimer);
  KillTimer(window, kAnimationTimer); gState.timerRunning = false; gState.striking = false;
  if (gReminderWindow) DestroyWindow(gReminderWindow);
  SaveState();
  PumpDataStorage(true);
}

void BeginClientClose(HWND window) {
  // A user's explicit exit supersedes a pending system query. A later
  // WM_ENDSESSION(FALSE) must not cancel that independently requested exit.
  gDataStorage.sessionQueryPending = false;
  gDataStorage.sessionResumeInput = false;
  PrepareClientClose(window);
  ContinueClientClose(window);
}

bool PrepareSessionEnd(HWND window) {
  if (gDataStorage.readyToDestroy) return true;
  if (!gDataStorage.closing) {
    gDataStorage.sessionQueryPending = true;
    gDataStorage.sessionResumeInput = gInput.service && gInput.service->running();
    PrepareClientClose(window);
  }
  ShutdownBlockReasonCreate(window,
      UiText(L"正在保存最后的功德记录，请稍候。", L"Saving final merit records. Please wait."));
  // QUERY is preparation, not permission to destroy the window or stop its
  // writer. A normal local flush gets a short bounded opportunity to finish;
  // cancellation/timeout leaves accepted writes owned by the live service.
  const auto deadline = GetTickCount64() + 2000;
  while (IsWindow(window) && gDataStorage.closing && !DataStorageIdle() &&
      GetTickCount64() < deadline) {
    PumpDataStorage(true);
    if (DataStorageIdle()) break;
    if (gDataStorage.model && gDataStorage.model->save_failed() &&
        !gDataStorage.model->in_flight()) break;
    MSG message{};
    for (unsigned count = 0; count < 32 &&
        PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++count) {
      if (message.message == WM_QUIT) {
        PostQuitMessage(static_cast<int>(message.wParam));
        break;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (gDataStorage.closing && !DataStorageIdle())
      MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  }
  const bool ready = gDataStorage.readyToDestroy ||
      (gDataStorage.closing && DataStorageIdle());
  if (!ready && gDataStorage.sessionQueryPending) CancelClientClose(window);
  return ready;
}

void CALLBACK OrphanStorageTimer(HWND, UINT, UINT_PTR, DWORD) {
  ContinueClientClose(nullptr);
}

LRESULT CALLBACK WindowProcedure(
    HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == kTaskbarCreatedMessage) {
    InstallTrayIcon(window); ApplyWindowVisibility(); return 0;
  }
  switch (message) {
    case kTrayMessage: {
      const auto event = LOWORD(lParam);
      if (event == WM_CONTEXTMENU || event == WM_RBUTTONUP || event == NIN_KEYSELECT) {
        POINT point{}; GetCursorPos(&point);
        SetForegroundWindow(window);
        ShowContextMenu(window, point);
        PostMessageW(window, WM_NULL, 0, 0);
      } else if (event == NIN_SELECT || event == WM_LBUTTONDBLCLK) {
        SetManualHidden(false);
      }
      return 0;
    }
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
    case niuma::entry_probe::kFrameControlMessage:
      if ((wParam == niuma::entry_probe::kStartFrames && StartRuntimeEntryFrames()) ||
          (wParam == niuma::entry_probe::kStopFrames && StopRuntimeEntryFrames()))
        return niuma::entry_probe::kFrameControlAck;
      return 0;
#endif
    case WM_MEASUREITEM:
      if (niuma::ui::MeasureMenu(reinterpret_cast<MEASUREITEMSTRUCT*>(lParam), gState.dpi)) return TRUE;
      break;
    case WM_DRAWITEM:
      if (niuma::ui::DrawMenu(reinterpret_cast<DRAWITEMSTRUCT*>(lParam), gState.dpi)) return TRUE;
      break;
    case WM_CREATE:
      gState.window = window;
      return 0;

    case kInputSnapshotMessage:
      ConsumeInputSnapshot();
      return 0;

    case kAppearanceReadyMessage:
      PumpAppearanceResources();
      if (gDataStorage.closing) ContinueClientClose(window);
      return 0;

    case kCountMessage:
      CountGlobalDelivery(false, lParam, wParam);
      return 0;

    case kScrollMessage:
      CountGlobalDelivery(true, lParam, wParam);
      return 0;

    case WM_COPYDATA: {
      const auto* copy = reinterpret_cast<const COPYDATASTRUCT*>(lParam);
      if (copy == nullptr || copy->dwData != kPackFileCopyData ||
          copy->lpData == nullptr || copy->cbData < sizeof(wchar_t) ||
          copy->cbData > 32768 * sizeof(wchar_t) ||
          copy->cbData % sizeof(wchar_t) != 0) return FALSE;
      const auto* path = static_cast<const wchar_t*>(copy->lpData);
      const size_t codeUnits = copy->cbData / sizeof(wchar_t);
      if (path[codeUnits - 1] != L'\0') return FALSE;
      const std::wstring sourcePath(path, codeUnits - 1);
      if (sourcePath.find(L'\0') != std::wstring::npos) return FALSE;
      if (!niuma::IsAppearancePackPath(sourcePath) &&
          !niuma::IsAppearanceBatchPath(sourcePath) &&
          !niuma::reminder::IsCatalogPackagePath(std::filesystem::path(sourcePath))) return FALSE;
      if (gPendingImports.size() >= 64) return FALSE;
      gPendingImports.push_back(sourcePath);
      if (gImportReady) PostMessageW(window, kImportQueuedMessage, 0, 0);
      return TRUE;
    }

    case kImportQueuedMessage:
      DrainPendingImport(window, ImportPackageFile);
      return 0;

    case kDisplayFailureMessage:
      if (UsesCompositionRuntime() && gDisplay.failed && !gDisplay.noticeShown && !gDataStorage.closing) {
        gDisplay.noticeShown = true;
        if (SoftwareDisplayForTest()) return 0;
        const int response = niuma::ui::Message(window,
            UiText(L"形象显示暂时不可用，计数和记录仍在继续。选择重试恢复显示，或取消并保存退出。",
                   L"The appearance display is unavailable. Counting and records continue. Retry to restore the display, or Cancel to save and exit."),
            WindowTitle(), MB_RETRYCANCEL | MB_ICONWARNING);
        if (response == IDRETRY) {
          gDisplay.noticeShown = false; gDisplay.recoveryAttempts = 0; RetryCompositionDisplay();
        } else BeginClientClose(window);
      }
      return 0;

    case WM_TIMER: {
      if (wParam == kDisplayRetryTimer) { RetryCompositionDisplay(); return 0; }
      if (wParam == kAppearanceTimer) {
        KillTimer(window, kAppearanceTimer); gAppearance.timerArmed = false;
        PumpAppearanceResources();
        if (gDataStorage.closing) ContinueClientClose(window);
        return 0;
      }
      if (wParam == kStorageTimer) {
        KillTimer(window, kStorageTimer); gDataStorage.timerArmed = false;
        ConsumeInputSnapshot();
        PumpDataStorage();
        if (gDataStorage.closing) ContinueClientClose(window);
        return 0;
      }
      if (wParam == kAcceptanceExitTimer && gReminderPreviewAcceptance) {
        KillTimer(window, kAcceptanceExitTimer);
        BeginClientClose(window);
        return 0;
      }
      if (wParam == kReminderTimer) {
        if (!gDataStorage.closing) {
          if (!gVisibility.recoveryAvailable) InstallTrayIcon(window);
          RefreshFullscreenVisibility();
        }
        ConsumeInputSnapshot();  // Also recovers a failed coalesced PostMessage.
        PumpDataStorage();  // Recover a failed storage timer without synchronous IO.
        const ULONGLONG now = GetTickCount64();
        const auto nowUtc = static_cast<std::int64_t>(std::time(nullptr));
        const auto clockTransition = gState.reminderClockGuard.Observe(nowUtc, now);
        ApplyReminderClockTransition(clockTransition, nowUtc);
        if (gReminderWindow != nullptr && gReminderDismissAt != 0 &&
            now >= gReminderDismissAt) {
          KillTimer(gReminderWindow, kReminderDismissTimer);
          DestroyWindow(gReminderWindow);
        }
        if (gInput.authoritative || gInput.loadFailed) return 0;
        const bool listenerHealthy = gState.keyboardHook != nullptr &&
            gState.mouseHook != nullptr && !gState.reminderClockGuard.guarded();
        const bool wasConsumed = gState.reminderActivity.segment_consumed();
        const auto trigger = gState.reminderActivity.Evaluate(now, listenerHealthy);
        const bool isConsumed = gState.reminderActivity.segment_consumed();
        if (wasConsumed && !isConsumed) PersistReminderUnlockIfNeeded(wasConsumed);
        if (trigger != niuma::reminder::ActivitySampler::Trigger::None)
          PresentReminderForTrigger(trigger);
        return 0;
      }
      if (wParam == kOffworkTimer) {
        if (gOffwork.enabled && !gOffwork.suspended) {
          const auto previous = gOffwork.snapshot;
          RefreshOffwork();
          const auto& current = gOffwork.snapshot;
          if (previous.valid != current.valid || previous.overtime != current.overtime ||
              (current.valid && (current.overtime
                  ? previous.overtimeSeconds != current.overtimeSeconds
                  : previous.remainingSeconds != current.remainingSeconds)))
          {
            RenderLayeredWindow(GetTickCount64());
            if (gCalendar.window) InvalidateRect(gCalendar.window, nullptr, FALSE);
          }
        }
        return 0;
      }
      if (wParam == kDayTimer) {
        // Retry failed local saves even when the countdown itself is disabled.
        if (GetTickCount64() - gOffwork.lastFlush >= 60000) FlushOffwork();
        if (gInput.authoritative) {
          ConsumeInputSnapshot();
          RequestInputLedger();
        } else if (EnsureCurrentDay()) RenderLayeredWindow(GetTickCount64());
        if (gCalendar.window != nullptr) InvalidateRect(gCalendar.window, nullptr, FALSE);
        return 0;
      }
      if (wParam == kAnimationTimer && gVisibility.hidden()) {
        KillTimer(window, kAnimationTimer); gState.timerRunning = false; return 0;
      }
      if (wParam != kAnimationTimer) {
        break;
      }
      const ULONGLONG now = GetTickCount64();
      if (gInput.previewUntil && now >= gInput.previewUntil) {
        gInput.previewUntil = 0;
        if (gInput.authoritative) ApplyInputView(gInput.latest);
      }
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
      if (!gState.striking) {
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
      const std::string requested = gAppearance.currentRequest
          ? gAppearance.currentRequest->source.id : gState.selectedPackId;
      if (UsesCompositionRuntime())
        RequestCurrentAppearance(requested == "builtin.woodfish" ? std::string{} : requested, false, true);
      else if (!requested.empty()) RequestCurrentAppearance(requested, false, true);
      RenderLayeredWindow(GetTickCount64());
      if (gReminderWindow != nullptr) PositionReminderWindow(gReminderWindow);
      return 0;
    }

    case WM_DISPLAYCHANGE:
      if (UsesCompositionRuntime() && gDisplay.display) gDisplay.display->Invalidate();
      gOffwork.baselineValid = false;
      RefreshOffwork(false, true);
      ClampWindowToWorkArea();
      RenderLayeredWindow(GetTickCount64());
      if (gReminderWindow != nullptr) PositionReminderWindow(gReminderWindow);
      return 0;

    case WM_EXITSIZEMOVE:
      SaveState();
      return 0;

    case WM_MOVE:
      if (gReminderWindow != nullptr) PositionReminderWindow(gReminderWindow);
      return 0;

    case WM_TIMECHANGE:
      NotifyReminderClockChange();
      gOffwork.baselineValid = false;
      RefreshOffwork(false, true);
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case WM_SETTINGCHANGE:
      gOffwork.baselineValid = false;
      InterruptReminderObservation();
      RefreshOffwork(false, true);
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case kOffworkSessionChange:
      if (wParam == 0x7) {  // WTS_SESSION_LOCK
        BeginReminderPause(AppState::ReminderPauseKind::SessionLock);
      } else if (wParam == 0x8) {  // WTS_SESSION_UNLOCK
        ResumeReminderPause(false);
      } else {
        InterruptReminderObservation();
      }
      gOffwork.baselineValid = false;
      RefreshOffwork(false, true);
      RenderLayeredWindow(GetTickCount64());
      return 0;

    case WM_POWERBROADCAST:
      if (wParam == PBT_APMSUSPEND) {
        BeginReminderPause(AppState::ReminderPauseKind::Sleep);
        RefreshOffwork(false, true);
        gOffwork.baselineValid = false;
        gOffwork.suspended = true;
        SyncOffworkTimer();
      } else if (wParam == PBT_APMRESUMEAUTOMATIC || wParam == PBT_APMRESUMESUSPEND) {
        ResumeReminderPause(true);
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
      if (gInput.authoritative) {
        // Let the input owner decide hook availability at dispatch. The UI
        // never increments its view while another thread owns the ledger.
        input_runtime::InputCommand command;
        command.kind = input_runtime::InputCommandKind::LocalFallbackClick;
        command.expectedEpoch = gInput.latest.input.epoch;
        command.capturedMs = GetTickCount64();
        command.capturedDate = input_runtime::InputService::CaptureLocalDate();
        if (!MouseListenerAvailable()) SendInputCommand(command);
      } else if (!gInput.loadFailed && !gState.mouseHook) CountOneOperation();
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

    case WM_CLOSE:
      BeginClientClose(window);
      return 0;

    case WM_QUERYENDSESSION:
      return PrepareSessionEnd(window) ? TRUE : FALSE;

    case WM_ENDSESSION:
      if (wParam != 0) BeginClientClose(window);
      else if (gDataStorage.sessionQueryPending) CancelClientClose(window);
      return 0;

    case WM_DESTROY:
      Shell_NotifyIconW(NIM_DELETE, &gTray); gVisibility.recoveryAvailable = false;
#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
      WriteRuntimeEntryObservation(true);
      WriteRuntimeEntryFrames();
#endif
      KillTimer(window, kDisplayRetryTimer);
      if (gDisplay.display) gDisplay.display->Shutdown();
      // Known exit routes arrive only after the latest file write and worker
      // stop are confirmed. Unexpected destruction uses a thread timer to keep
      // the owner alive; it never abandons an accepted file operation.
      StopInputService();
      if (!gDataStorage.readyToDestroy) {
        gDataStorage.closing = true;
        gDataStorage.closeStarted = GetTickCount64();
        RefreshOffwork(true, true);
        SaveState(); PumpDataStorage(true);
      }
      if (gReminderWindow) DestroyWindow(gReminderWindow);
      KillTimer(window, kOffworkTimer);
      gOffwork.timerRunning = false;
      UnregisterOffworkSessionNotifications(window);
      if (gOffwork.dialog) EndDialog(gOffwork.dialog, IDCANCEL);
      if (gCountingCheck.window) DestroyWindow(gCountingCheck.window);
      KillTimer(window, kDayTimer); KillTimer(window, kReminderTimer);
      KillTimer(window, kStorageTimer); gDataStorage.timerArmed = false;
      KillTimer(window, kAppearanceTimer); gAppearance.timerArmed = false;
      KillTimer(window, kAnimationTimer); gState.timerRunning = false;
      gState.window = nullptr;
      if (gDataStorage.readyToDestroy || !gDataStorage.service) PostQuitMessage(0);
      else {
        gDataStorage.orphanTimer = SetTimer(nullptr, 0, 100, OrphanStorageTimer);
        if (!gDataStorage.orphanTimer) PostQuitMessage(0);  // Final owner drain below handles this path.
      }
      return 0;

    default:
      break;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

bool TransferImport(HWND receiver, const std::wstring& file, UINT timeout = 5000) {
  if (!receiver || file.empty()) return false;
  COPYDATASTRUCT copy = {};
  copy.dwData = kPackFileCopyData;
  copy.cbData = static_cast<DWORD>((file.size() + 1) * sizeof(wchar_t));
  copy.lpData = const_cast<wchar_t*>(file.c_str());
  DWORD_PTR accepted = FALSE;
  return SendMessageTimeoutW(receiver, WM_COPYDATA, 0,
      reinterpret_cast<LPARAM>(&copy), SMTO_ABORTIFHUNG | SMTO_BLOCK,
      timeout, &accepted) != 0 && accepted == TRUE;
}

}  // namespace

int WINAPI wWinMain(
    HINSTANCE instance, HINSTANCE, PWSTR, int) {
  if (!InitializeAcceptanceContext()) return 2;
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
  if (!IsRuntimeCandidate() || !niuma::legacy_diag::Configure(gAcceptanceRoot)) return 2;
#endif
#if defined(NIUMA_SELF_INSTALL)
  if (!gIsolatedAcceptance) {
    const auto setup = niuma::installation::PrepareLaunch(instance, NIUMA_APP_VERSION_W);
    if (setup.handled) return setup.exitCode;
    gInstallStartupChoice = setup.startupChoice;
  }
#endif
  EnableBestDpiAwareness();

  const std::wstring pendingImportFile = ImportFileArgument();

  gState.mutex = CreateMutexW(nullptr, TRUE,
#if defined(NIUMA_RUNTIME_CANDIDATE)
      IsRuntimeCandidate() ? kRuntimeMutexName :
#endif
      gIsolatedAcceptance ? kAcceptanceMutexName : kMutexName);
  if (gState.mutex == nullptr) {
    return 1;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (IsRuntimeCandidate()) {
      // A second candidate may name another private profile. Do not forward
      // its import into the already-running candidate's different test data.
      niuma::ui::Message(nullptr,
          UiText(L"独立测试版已经运行。请在当前测试版中导入素材，或先退出后再打开另一测试目录。",
                 L"A development candidate is already running. Import packs there, or exit it before opening another test profile."),
          WindowTitle(), MB_OK | MB_ICONINFORMATION);
      CloseHandle(gState.mutex); gState.mutex = nullptr;
      return 0;
    }
    if (!pendingImportFile.empty()) {
      HWND existingWindow = nullptr;
      for (int attempt = 0; attempt < 20 && existingWindow == nullptr; ++attempt) {
        existingWindow = FindWindowW(MainWindowClass(), nullptr);
        if (existingWindow == nullptr) Sleep(50);
      }
      if (!TransferImport(existingWindow, pendingImportFile)) {
        niuma::ui::Message(nullptr, UiText(
            L"文件尚未导入。请先关闭牛马的启动提示，等待桌面形象出现，再重新双击此文件。若刚才的导入窗口已打开，请先完成它。",
            L"The file has not been imported. Dismiss NiuMa's startup notices and wait for the desktop character, then double-click the file again. If an import dialog has already opened, complete it first."),
            WindowTitle(), MB_OK | MB_ICONWARNING);
        CloseHandle(gState.mutex);
        gState.mutex = nullptr;
        return 2;
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
    niuma::ui::Message(
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

#if defined(NIUMA_RUNTIME_ENTRY_PROBE)
  if (!PrepareRuntimeEntryScenario()) {
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex); CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) CoUninitialize();
    return 3;
  }
#endif
  std::wstring catalogError;
  const bool catalogLoaded = gAppearanceCatalog.ReloadMetadata(AppearanceDirectory(), &catalogError);
  if (!catalogLoaded || !catalogError.empty()) {
    niuma::ui::Message(nullptr, catalogError.c_str(), WindowTitle(), MB_OK | MB_ICONWARNING);
  }

  WNDCLASSEXW windowClass = {};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.lpfnWndProc = WindowProcedure;
  windowClass.hInstance = instance;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_HAND);
  windowClass.lpszClassName = MainWindowClass();
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
  pickerClass.hbrBackground = niuma::ui::CanvasBrush();
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
  calendarClass.hbrBackground = nullptr;
  calendarClass.lpszClassName = kCalendarClass;
  if (RegisterClassExW(&calendarClass) == 0) {
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex);
    CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) CoUninitialize();
    return 1;
  }

  WNDCLASSEXW reminderClass = {};
  reminderClass.cbSize = sizeof(reminderClass);
  reminderClass.lpfnWndProc = ReminderWindowProcedure;
  reminderClass.hInstance = instance;
  reminderClass.hCursor = LoadCursorW(nullptr, IDC_HAND);
  reminderClass.hbrBackground = nullptr;
  reminderClass.lpszClassName = kReminderClass;
  RegisterClassExW(&reminderClass);

  if (!InitializeDataStorage()) {
    niuma::ui::Message(nullptr,
        UiText(L"本地功德记录未能完整读取，程序已停止启动，原文件没有被覆盖。请检查文件访问权限后重试。",
               L"Local records could not be fully loaded. Startup stopped and the original file was not overwritten. Check file access and retry."),
        WindowTitle(), MB_OK | MB_ICONERROR);
    ReleaseAllPngResources();
    Gdiplus::GdiplusShutdown(gState.gdiplusToken);
    ReleaseMutex(gState.mutex); CloseHandle(gState.mutex);
    if (SUCCEEDED(comResult)) CoUninitialize();
    return 1;
  }
  gState.dpi = SystemDpi();
  LoadOffworkSettings();
  if (gDataStorage.model) gVisibility.autoHideFullscreen = gDataStorage.model->current().autoHideFullscreen;
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
    niuma::ui::Message(nullptr,
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
      (UsesCompositionRuntime() && niuma::runtime::HasCompositionSystem() ? WS_EX_NOREDIRECTIONBITMAP : WS_EX_LAYERED) |
          WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      MainWindowClass(), WindowTitle(), WS_POPUP,
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
  if (UsesCompositionRuntime()) {
    gDisplay.startupSelection = gState.selectedPackId;
    RequestCurrentAppearance({}, false);
    if (gAppearance.currentRequest) gDisplay.startupRequest = gAppearance.currentRequest->id;
    PrepareBuiltinThumbnail();
    // The fixed picker image replaces these lazy GDI PNG resources; the GPU
    // worker reads the executable's immutable resources independently.
    ReleasePngResource(gFish); ReleasePngResource(gMallet);
  } else if (!gState.selectedPackId.empty()) RequestCurrentAppearance(gState.selectedPackId, false);
  RefreshOffwork(false, true);
  const std::wstring dataPath = DataPath();
  if (!dataPath.empty()) {
    const auto reminderDirectory = std::filesystem::path(dataPath).parent_path() / L"Reminders";
    gState.reminderStore = std::make_unique<niuma::reminder::ReminderStore>(reminderDirectory);
    gState.catalogStore = std::make_unique<niuma::reminder::CatalogUpdateStore>(
        reminderDirectory / L"Catalog");
    gState.reminderCatalog = gState.catalogStore->Load(
        niuma::reminder::OfficialCatalogSignatureVerifier(), nullptr,
        &gState.reminderCatalogCommitUncertain);
    gState.reminderActivity.RestoreSegmentConsumed(gState.reminderStore->SegmentConsumed());
  }
  const auto reminderStartupUtc = static_cast<std::int64_t>(std::time(nullptr));
  const ULONGLONG reminderStartupTick = GetTickCount64();
  const std::string reminderStartupDate = CurrentReminderLocalDate();
  const bool persistedClockGuard = gState.reminderStore &&
      gState.reminderStore->ClockGuard(reminderStartupUtc, reminderStartupDate.c_str());
  gState.reminderClockGuard.Start(reminderStartupUtc, reminderStartupTick,
      persistedClockGuard);
  InstallTrayIcon(window);
  gVisibility.fullscreen = gVisibility.autoHideFullscreen && ForegroundIsFullscreen();
  RenderLayeredWindow(GetTickCount64());
  ShowWindow(window, gVisibility.hidden() ? SW_HIDE : SW_SHOWNOACTIVATE);
  gVisibilityHidden = gVisibility.hidden();
  SetWindowPos(
      window, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | (gVisibility.hidden() ? 0 : SWP_SHOWWINDOW));
  SetTimer(window, kDayTimer, 30000, nullptr);
  SetTimer(window, kReminderTimer, 1000, nullptr);
  ArmDataStorageTimer();
  if (!gIsolatedAcceptance || IsRuntimeCandidate()) RegisterOffworkSessionNotifications(window);
  if (!SyncOffworkTimer()) {
    niuma::ui::Message(window, UiText(L"无法启动下班倒计时逐秒刷新，请在设置中关闭后重新开启。",
        L"The countdown refresh timer could not start. Turn it off and on in settings."),
        WindowTitle(), MB_OK | MB_ICONWARNING);
  }

  if (!gIsolatedAcceptance) {
    wchar_t executable[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, executable,
                           static_cast<DWORD>(std::size(executable))) != 0) {
      std::wstring associationError;
      niuma::RegisterPackFileAssociations(executable, &associationError);
    }
  }

  if (!gIsolatedAcceptance) {
#if defined(NIUMA_SELF_INSTALL)
    if (gInstallStartupChoice && SetLaunchAtLoginEnabled(*gInstallStartupChoice))
      SaveLaunchAtLoginPreference(*gInstallStartupChoice);
#endif
    ConfigureLaunchAtLogin();
  }
  if (!gIsolatedAcceptance || IsRuntimeCandidate()) {
#if !defined(NIUMA_RUNTIME_ENTRY_PROBE)
    // The separate entry probe omits only this ordinary developer notice.
    // It still requires the candidate arguments and a validated private root.
    if (IsRuntimeCandidate())
      niuma::ui::Message(window,
          UiText(L"这是独立开发测试版。功德、日历、设置和导入素材仅保存在本次测试目录，不会更改正式版数据。\n\n确认后正常统计本机输入次数，不保存按键内容。自动启动和文件关联已禁用。",
                 L"This is an isolated development candidate. Counts, calendar, settings and imported packs stay in its test folder; installed-app data is unchanged.\n\nAfter this notice, normal input counting starts without storing key contents. Startup registration and file associations are disabled."),
          WindowTitle(), MB_OK | MB_ICONINFORMATION);
#endif
    RestartGlobalListeners();
  }
  if ((!gIsolatedAcceptance || IsRuntimeCandidate()) &&
      !PrepareClientStartup(window, pendingImportFile) && IsMainWindowAlive(window)) {
    PostMessageW(window, WM_CLOSE, 0, 0);
  }
  gImportReady = IsMainWindowAlive(window);
  if (gImportReady && !gPendingImports.empty()) PostMessageW(window, kImportQueuedMessage, 0, 0);
  // A listener failure leaves click-only/partial counting and a reachable retry
  // entry, instead of terminating the client and losing its recovery path.

  MSG message = {};
  if (IsMainWindowAlive(window)) {
    if (gReminderPreviewAcceptance) {
      const char* previewStage = "not-started";
      PresentReminderForTrigger(niuma::reminder::ActivitySampler::Trigger::HighIntensity,
          &previewStage);
      const DWORD previewError = GetLastError();
      const std::wstring reportPath = gAcceptanceRoot + L"\\preview-status.txt";
      if (FILE* report = _wfopen(reportPath.c_str(), L"wb")) {
        std::fprintf(report, "stage=%s\nwin32_error=%lu\npet_visible=%d\nbubble_visible=%d\nstorage_fault=%d\n",
            previewStage, static_cast<unsigned long>(previewError),
            IsWindowVisible(window) != FALSE,
            gReminderWindow != nullptr && IsWindowVisible(gReminderWindow) != FALSE,
            gState.reminderStorageFault);
        std::fclose(report);
      }
      SetTimer(window, kAcceptanceExitTimer,
          niuma::reminder::kReminderDisplayMilliseconds + 4000, nullptr);
    }
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      if (gCountingCheck.window && IsDialogMessageW(gCountingCheck.window, &message)) continue;
      if (gCalendar.window && (message.hwnd == gCalendar.window || IsChild(gCalendar.window, message.hwnd)) &&
          IsDialogMessageW(gCalendar.window, &message)) continue;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

  if (!gDataStorage.readyToDestroy && gDataStorage.service) {
    if (gState.window) BeginClientClose(gState.window);
    else {
      gDataStorage.closing = true;
      gDataStorage.closeStarted = GetTickCount64();
      StopInputService(); SaveState(); PumpDataStorage(true);
    }
    // WM_QUIT/error can arrive independently of WM_CLOSE. Retain both owners
    // until their real completion, while continuing to dispatch UI messages.
    while (!gDataStorage.readyToDestroy) {
      ContinueClientClose(gState.window);
      if (gDataStorage.readyToDestroy) break;
      MsgWaitForMultipleObjectsEx(0, nullptr, 100, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
      MSG pending{};
      while (PeekMessageW(&pending, nullptr, 0, 0, PM_REMOVE)) {
        if (pending.message == WM_QUIT) continue;
        TranslateMessage(&pending); DispatchMessageW(&pending);
      }
    }
  }
  StopInputService();
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
