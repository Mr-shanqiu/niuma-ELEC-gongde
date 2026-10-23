#ifdef NDEBUG
#undef NDEBUG
#endif
#if !defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
#error This isolated adapter test requires the diagnostic InputService build.
#endif

// Include the real application adapter without invoking wWinMain. Each fixture
// owns a new directory and window. Hooks admit only this test's tagged F24;
// no real profile, automatic startup, associations or installed app is touched.
#define wWinMain NiuMaUnusedApplicationEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
constexpr wchar_t kFixtureClass[] = L"NiuMaRuntimeAppFixture";
constexpr ULONG_PTR kTestTag = 0x4e540000;
constexpr ULONG_PTR kTestTagMask = ~static_cast<ULONG_PTR>(0xffff);
#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

LRESULT CALLBACK FixtureProcedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  // F24 is only a tagged counter stimulus, never a shortcut in another app.
  if (message == WM_KEYDOWN || message == WM_KEYUP) return 0;
  return WindowProcedure(window, message, wp, lp);
}

std::uint64_t ProfileCount(const std::filesystem::path& path,
                           const std::wstring& section, const std::wstring& key) {
  wchar_t text[64]{};
  GetPrivateProfileStringW(section.c_str(), key.c_str(), L"missing", text,
      static_cast<DWORD>(std::size(text)), path.c_str());
  CHECK(text[0] != L'\0');
  std::uint64_t value = 0;
  for (const wchar_t* character = text; *character; ++character) {
    CHECK(*character >= L'0' && *character <= L'9');
    const auto digit = static_cast<unsigned>(*character - L'0');
    CHECK(value <= (std::numeric_limits<std::uint64_t>::max() - digit) / 10);
    value = value * 10 + digit;
  }
  return value;
}

struct Fixture {
  HWND window = nullptr;
  std::filesystem::path directory;
  std::map<std::wstring, std::uint64_t> expectedDays;
  std::wstring today;
  unsigned verification = 0;

  Fixture(const std::filesystem::path& parent, const wchar_t* name) {
    gInput = InputAdapter{};
    gDataStorage = DataStorageAdapter{};
    gState = AppState{};
    gCountingCheck = CountingCheck{};
    gOffwork = OffworkState{};
    gReminderWindow = nullptr;
    gReminderText.clear();
    gReminderDismissAt = 0;
    gIsolatedAcceptance = true;
    gReminderPreviewAcceptance = false;
    directory = parent / name;
    CHECK(CreateDirectoryW(directory.c_str(), nullptr) != FALSE);
    gAcceptanceRoot = directory.wstring();
    today = InputDateKey(input_runtime::InputService::CaptureLocalDate());
    // Larger than the old 4096-character profile buffer: every historical
    // row must survive the complete preload and the final atomic save.
    for (unsigned year = 1980; year < 2024; ++year) {
      for (unsigned month = 1; month <= 12; ++month) {
        const auto date = year * 10000 + month * 100 + 1;
        expectedDays[InputDateKey(date)] = (year - 1979) * 20 + month;
      }
    }
    expectedDays[today] = 10;
    std::vector<wchar_t> section;
    for (const auto& day : expectedDays) {
      const auto line = day.first + L"=" + std::to_wstring(day.second);
      section.insert(section.end(), line.begin(), line.end());
      section.push_back(L'\0');
    }
    section.push_back(L'\0');
    CHECK(section.size() > 4096);
    CHECK(WritePrivateProfileSectionW(L"daily", section.data(), DataPath().c_str()));
    CHECK(WritePrivateProfileStringW(L"state", L"total", L"1000", DataPath().c_str()));
    CHECK(WritePrivateProfileStringW(L"state", L"unrelated", L"keep", DataPath().c_str()));
    CHECK(WritePrivateProfileStringW(L"offwork_daily", L"2024-01-02", L"kept", DataPath().c_str()));
    // Flush/close the fixture writer before the service becomes the sole writer.
    WritePrivateProfileStringW(nullptr, nullptr, nullptr, DataPath().c_str());
    CHECK(InitializeDataStorage());
    LoadOffworkSettings();
    gState.total = ReadIniTotal();
    CHECK(EnsureCurrentDay());
    CHECK(gState.todayTotal == 10);
    window = CreateWindowExW(0, kFixtureClass, L"NiuMa isolated runtime adapter test",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        60, 60, 560, 240, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    CHECK(window && gState.window == window);
    ShowWindow(window, SW_SHOW);
    SetForegroundWindow(window);
    Await([&] { return GetForegroundWindow() == window; });
  }

  ~Fixture() {
    // Also safe on a failed CHECK: join hooks while the owned HWND still exists.
    StopInputService();
    gCountingCheck.window = nullptr;
    gDataStorage.pumping = false;
    if (gReminderWindow) DestroyWindow(gReminderWindow);
    if (std::uncaught_exceptions() != 0) {
      // A failed assertion must exit as failure, not open a human retry dialog.
      // This fixture owns every byte; join its writer before releasing its HWND.
      if (gDataStorage.service && !gDataStorage.service->Stop(5000).stopped)
        std::terminate();
      gDataStorage.readyToDestroy = true;
      if (window && IsWindow(window)) DestroyWindow(window);
      gInput.service.reset();
      gDataStorage.service.reset();
      return;
    }
    if (window && IsWindow(window)) {
      BeginClientClose(window);
      const auto deadline = GetTickCount64() + 10000;
      while (IsWindow(window) && GetTickCount64() < deadline) Pump();
      if (IsWindow(window)) {
        std::cerr << "FAILED isolated client close did not complete\n";
        std::terminate();
      }
    }
    gInput.service.reset();
    gDataStorage.service.reset();
    MSG message{};
    while (PeekMessageW(&message, nullptr, WM_QUIT, WM_QUIT, PM_REMOVE)) {}
  }

  void Pump(DWORD wait = 1) {
    MSG message{};
    for (unsigned n = 0; n < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++n) {
      if (message.message == WM_QUIT) continue;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    PumpDataStorage();
    MsgWaitForMultipleObjectsEx(0, nullptr, wait, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  }
  template <typename Predicate>
  void Await(Predicate predicate, ULONGLONG timeout = 5000) {
    const auto deadline = GetTickCount64() + timeout;
    while (!predicate()) {
      CHECK(GetTickCount64() < deadline);
      Pump();
    }
  }
  void Until(ULONGLONG tick) { while (GetTickCount64() < tick) Pump(); }

  void Start(bool noMouse = false, bool reminder = false) {
    input_runtime::InputServiceOptions options;
    // The real preload/model adapter retains every historical date.
    CHECK(LoadInputLedger(options));
    CHECK(options.daily.size() == expectedDays.size());
    CHECK(options.total == 1000 && options.date == ParseInputDate(today));
    for (const auto& day : options.daily)
      CHECK(expectedDays.at(InputDateKey(day.date)) == day.total);
    options.notificationWindow = window;
    options.notificationMessage = kInputSnapshotMessage;
    options.diagnostic.tagMask = kTestTagMask;
    options.diagnostic.tagValue = kTestTag;
    options.diagnostic.maximumSequence = 64;
    options.diagnostic.forceMouseUnavailable = noMouse;
    options.diagnostic.seedReminderOpportunity = reminder;
    // Only installation differs from the production startup wrapper: its
    // diagnostic admission excludes physical user input and may force no mouse.
    gInput.daily = options.daily;
    gInput.daily.reserve(input_core::InputCore::kDefaultDayCapacity);
    gInput.ledger.total = options.total;
    gInput.ledger.date = options.date;
    gInput.service = std::make_unique<input_runtime::InputService>();
    const auto started = gInput.service->Start(options);
    CHECK(started.started && started.keyboardError == ERROR_SUCCESS);
    CHECK(noMouse ? started.mouseError == ERROR_ACCESS_DENIED : started.mouseError == ERROR_SUCCESS);
    gInput.authoritative = true;
    ++gInput.instanceGeneration;
    gInput.reminderConsumed = options.reminderSegmentConsumed;
    gInput.handledReminder = reminder ? 1 : 0;
    gState.pendingDailyTotals.clear();
    ConsumeInputSnapshot();
    CHECK(gInput.latest.running && gInput.latest.input.epoch == 1);
    RequestInputLedger();
    Await([&] { return !gInput.ledgerRequest && gInput.ledger.ready; });
  }

  void Keys(unsigned pairs) {
    CHECK(GetForegroundWindow() == window);
    for (unsigned i = 0; i < pairs; ++i) {
      INPUT input[2]{};
      for (auto& event : input) {
        event.type = INPUT_KEYBOARD;
        event.ki.wVk = VK_F24;
        event.ki.dwExtraInfo = kTestTag | (i + 1);
      }
      input[1].ki.dwFlags = KEYEVENTF_KEYUP;
      CHECK(SendInput(2, input, sizeof(INPUT)) == 2);
    }
  }

  void LedgerAt(std::uint64_t total) {
    RequestInputLedger();
    Await([&] { return !gInput.ledgerRequest && gInput.ledger.total == total; });
  }

  void DrainStorage() {
    Await([&] {
      ConsumeInputSnapshot();
      PumpDataStorage(true);
      return DataStorageIdle();
    });
  }

  void CheckStored(std::uint64_t total, std::uint64_t todayTotal) {
    // Read a fresh snapshot path with the legacy profile API. A reader cache
    // cannot hide a missed replacement of the live data.ini.
    const auto snapshot = directory / (L"verify-" + std::to_wstring(++verification) + L".ini");
    CHECK(CopyFileW(DataPath().c_str(), snapshot.c_str(), TRUE));
    CHECK(ProfileCount(snapshot, L"state", L"total") == total);
    CHECK(ProfileCount(snapshot, L"daily", today) == todayTotal);
    for (const auto& day : expectedDays)
      if (day.first != today) CHECK(ProfileCount(snapshot, L"daily", day.first) == day.second);
    wchar_t kept[32]{};
    GetPrivateProfileStringW(L"state", L"unrelated", L"", kept, 32, snapshot.c_str());
    CHECK(std::wstring(kept) == L"keep");
    GetPrivateProfileStringW(L"offwork_daily", L"2024-01-02", L"", kept, 32, snapshot.c_str());
    CHECK(std::wstring(kept) == L"kept");
  }

  void PrepareReminder() {
    gState.reminderStore = std::make_unique<niuma::reminder::ReminderStore>(directory / L"Reminders");
    CHECK(gState.reminderStore->SetSegmentConsumed(false,
        static_cast<std::int64_t>(std::time(nullptr))) == niuma::reminder::StoreResult::Success);
    CHECK(gInput.latest.pendingReminderId && gInput.latest.pendingReminderEpoch == 1);
    // This is the real selection + durable reservation + hidden popup path.
    PresentReminderForTrigger(gInput.latest.pendingReminder);
    CHECK(!gReminderWindow && gInput.pendingReminderWindow);
    CHECK(!IsWindowVisible(gInput.pendingReminderWindow));
    CHECK(gInput.reminderCommand && gInput.reminderEpoch == 1 && gInput.reminderOpportunity);
    CHECK(gState.reminderStore->SegmentConsumed());
    std::unordered_set<std::string> recent;
    bool warm = false;
    CHECK(gState.reminderStore->ReadSelectionHistory(CurrentReminderLocalDate().c_str(),
        static_cast<std::int64_t>(std::time(nullptr)), &recent, &warm));
    CHECK(recent.size() == 1);  // Exactly one durable reservation before display.
  }
};

void FullLedgerAndFinalSave(const std::filesystem::path& root) {
  Fixture fixture(root, L"ledger");
  fixture.Start();
  fixture.Keys(3);
  fixture.Await([] { return gState.total == 1003; });
  CHECK(gState.todayTotal == 13 && gCountingCheck.observedCount);
  fixture.LedgerAt(1003);
  SaveState();
  fixture.DrainStorage();
  CHECK(!gState.dirty);
  fixture.CheckStored(1003, 13);

  // Block replacement only inside this owned fixture. No writer is in flight.
  const auto kept = fixture.directory / L"before-failed-save.ini";
  CHECK(MoveFileW(DataPath().c_str(), kept.c_str()));
  CHECK(CreateDirectoryW(DataPath().c_str(), nullptr));
  gState.selectedPackId = "fixture-save-retry";
  SaveState();
  PumpDataStorage(true);
  fixture.Await([] { return gDataStorage.model->save_failed() &&
      !gDataStorage.model->in_flight(); });
  CHECK(gDataStorage.model->dirty() && !DataStorageIdle());
  CHECK(gDataStorage.model->current().counts.total == 1003 &&
      gInput.daily.size() == fixture.expectedDays.size());
  CHECK(RemoveDirectoryW(DataPath().c_str()));
  CHECK(MoveFileW(kept.c_str(), DataPath().c_str()));
  gState.selectedPackId.clear();
  SaveState();
  fixture.DrainStorage();
  fixture.CheckStored(1003, 13);

  // Hold the storage consumer while input advances. UI total/today must never
  // get paired with the older full ledger by the real SaveState adapter.
  gDataStorage.pumping = true;
  fixture.Keys(2);
  fixture.Await([] { return gState.total == 1005; });
  CHECK(gInput.ledger.total == 1003);
  gDataStorage.pumping = false;
  SaveState();
  CHECK(gState.dirty);
  CHECK(gDataStorage.model->current().counts.total == 1003 &&
      gDataStorage.model->current().counts.daily.at(ParseInputDate(fixture.today)) == 13);
  fixture.LedgerAt(1005);
  fixture.DrainStorage();
  fixture.CheckStored(1005, 15);

  gDataStorage.pumping = true;
  fixture.Keys(2);
  fixture.Await([] { return gState.total == 1007; });
  CHECK(gInput.ledger.total == 1005);
  gDataStorage.pumping = false;
  StopInputService();
  CHECK(gInput.finalCollected && !gInput.latest.running);
  CHECK(gInput.ledger.total == 1007 && gState.total == 1007);
  SaveState();
  fixture.DrainStorage();
  CHECK(!gState.dirty);
  fixture.CheckStored(1007, 17);
  std::cout << "PASS full historical ledger, version-consistent save, real failed-write retry and final save\n";
}

void FallbackRestartAndSelfCheck(const std::filesystem::path& root) {
  Fixture fixture(root, L"controls");
  fixture.Start(true);
  CHECK(!MouseListenerAvailable() && KeyboardListenerAvailable());
  WindowProcedure(fixture.window, WM_NCLBUTTONDOWN, HTNOWHERE, 0);
  fixture.Await([] { return gState.total == 1001; });
  CHECK(!gCountingCheck.observedCount);
  fixture.Keys(1);
  fixture.Await([] { return gState.total == 1002; });
  CHECK(gCountingCheck.observedCount);
  const auto oldEpoch = gInput.latest.input.epoch;
  CountingStatusProcedure(fixture.window, WM_COMMAND, kStatusRetry, 0);
  fixture.Await([&] { return gInput.latest.input.epoch == oldEpoch + 1; });
  CHECK(gState.total == 1002 && !gCountingCheck.observedCount);
  CHECK(!MouseListenerAvailable() && KeyboardListenerAvailable());

  // The real UI command starts an owner-timed 2s preparation + 10s capture.
  // Point status rendering at our owned window; absent child labels are harmless.
  gCountingCheck.window = fixture.window;
  CountingStatusProcedure(fixture.window, WM_COMMAND, kStatusStart, 0);
  fixture.Await([] { return gInput.latest.selfCheck.active &&
      gInput.latest.selfCheck.generation == gCountingCheck.generation; });
  fixture.Until(gCountingCheck.starts + 20);
  fixture.Keys(2);
  fixture.Await([] { return gState.total == 1004 && gCountingCheck.keys == 2; });
  WindowProcedure(fixture.window, WM_NCLBUTTONDOWN, HTNOWHERE, 0);
  fixture.Await([] { return gState.total == 1005; });
  CHECK(gCountingCheck.keys == 2 && gCountingCheck.clicks == 0 &&
      gCountingCheck.handled == 2 && gCountingCheck.expected == 2 && gCountingCheck.counted == 2);
  fixture.Await([] { return !gCountingCheck.active; }, 12000);
  CHECK(!gCountingCheck.deliveryFault && !gCountingCheck.result.empty());
  CHECK(!gInput.latest.selfCheck.active && !gInput.latest.selfCheck.cancelled);
  gCountingCheck.window = nullptr;
  StopInputService();
  SaveState();
  fixture.DrainStorage();
  fixture.CheckStored(1005, 15);
  std::cout << "PASS real fallback, listener retry and owner-aggregated self-check\n";
}

void ReminderShownOnlyAfterConfirmation(const std::filesystem::path& root) {
  Fixture fixture(root, L"reminder-confirmed");
  fixture.Start(false, true);
  fixture.PrepareReminder();
  const auto command = gInput.reminderCommand;
  const auto opportunity = gInput.reminderOpportunity;
  fixture.Await([] { return gReminderWindow != nullptr; });
  CHECK(!gInput.pendingReminderWindow && IsWindowVisible(gReminderWindow));
  const auto& confirmed = gInput.latest.reminderConfirmation;
  CHECK(confirmed.confirmed && confirmed.commandId == command &&
      confirmed.epoch == gInput.latest.input.epoch && confirmed.opportunityId == opportunity);
  DestroyWindow(gReminderWindow);
  CHECK(!gReminderWindow);
  std::cout << "PASS durable reservation stays hidden until exact owner confirmation\n";
}

void ReminderDiscardedAfterEpochChange(const std::filesystem::path& root) {
  Fixture fixture(root, L"reminder-stale");
  fixture.Start(false, true);
  fixture.PrepareReminder();
  const HWND hidden = gInput.pendingReminderWindow;
  const auto oldEpoch = gInput.reminderEpoch;
  input_runtime::InputCommand restart;
  restart.kind = input_runtime::InputCommandKind::RestartListeners;
  CHECK(SendInputCommand(restart));
  // Hold UI dispatch while the owner processes confirmation followed by restart.
  // The retained earlier confirmation must not reveal a stale hidden window.
  input_runtime::InputServiceSnapshot owner;
  const auto deadline = GetTickCount64() + 5000;
  do {
    CHECK(GetTickCount64() < deadline);
    gInput.service->ReadLatest(owner);
    Sleep(1);
  } while (owner.input.epoch == oldEpoch || !owner.input.epoch);
  CHECK(!IsWindowVisible(hidden) && !gReminderWindow);
  // ReadLatest above was the one consumer of this publication. Hand that
  // complete view to the real adapter, exactly as ConsumeInputSnapshot does;
  // a second ReadLatest legitimately reports no NEW publication.
  ApplyInputView(owner);
  ConsumeInputSnapshot();
  CHECK(!gInput.pendingReminderWindow && !gReminderWindow && !IsWindow(hidden));
  CHECK(gInput.latest.input.epoch == oldEpoch + 1);
  std::unordered_set<std::string> recent;
  bool warm = false;
  CHECK(gState.reminderStore->ReadSelectionHistory(CurrentReminderLocalDate().c_str(),
      static_cast<std::int64_t>(std::time(nullptr)), &recent, &warm));
  CHECK(recent.size() == 1);  // Cancellation did not undo/replay its reservation.
  std::cout << "PASS stale epoch destroys hidden reminder without replay\n";
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  try {
    CHECK(argc == 2);
    const auto parent = std::filesystem::absolute(argv[1]);
    CHECK(std::filesystem::is_directory(parent));
    const auto root = parent / (L"niuma-runtime-app-" + std::to_wstring(GetCurrentProcessId()));
    CHECK(CreateDirectoryW(root.c_str(), nullptr));
    WNDCLASSW cls{};
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpfnWndProc = FixtureProcedure;
    cls.lpszClassName = kFixtureClass;
    CHECK(RegisterClassW(&cls));
    cls.lpfnWndProc = ReminderWindowProcedure;
    cls.lpszClassName = kReminderClass;
    CHECK(RegisterClassW(&cls));
    FullLedgerAndFinalSave(root);
    FallbackRestartAndSelfCheck(root);
    ReminderShownOnlyAfterConfirmation(root);
    ReminderDiscardedAfterEpochChange(root);
    std::ofstream receipt(root / L"RUNTIME_APP_RESULT.json");
    CHECK(receipt.good());
    receipt << "{\"status\":\"passed\",\"groups\":4,"
        "\"fullLedgerRows\":529,\"realAdapterPaths\":true,"
        "\"taggedInputOnly\":true,\"diagnosticServiceInstallation\":true,"
        "\"asyncStorageAdapter\":true,\"normalCloseJoinedOwners\":true,"
        "\"realUserProfile\":false,\"installedAppStarted\":false,"
        "\"humanAcceptance\":false,\"performanceClaim\":false}\n";
    receipt.close();
    CHECK(receipt.good());
    std::wcout << L"RESULT " << root.wstring() << L"\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAILED " << error.what() << "; Win32=" << GetLastError() << "\n";
    return 1;
  }
}
