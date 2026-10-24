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

  Fixture(const std::filesystem::path& parent, const wchar_t* name, bool composition = false,
          bool requireForeground = true) {
    gDisplay = DisplayAdapter{};
#if defined(NIUMA_RUNTIME_CANDIDATE)
    gRuntimeCandidate = composition;
    gDisplay.allowSoftwareForTest = composition;
#endif
    gInput = InputAdapter{};
    gDataStorage = DataStorageAdapter{};
    gAppearance = AppearanceAdapter{};
    gAppearanceCatalog = niuma::AppearanceCatalog{};
    gPicker = PickerState{};
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
    window = CreateWindowExW((composition ? WS_EX_NOREDIRECTIONBITMAP : 0) |
        (requireForeground ? 0 : WS_EX_NOACTIVATE),
        kFixtureClass, L"NiuMa isolated runtime adapter test",
        composition ? WS_POPUP | WS_VISIBLE : WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        60, 60, composition ? gState.windowWidth : 560,
        composition ? gState.windowHeight : 240, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    CHECK(window && gState.window == window);
    ShowWindow(window, requireForeground ? SW_SHOW : SW_SHOWNOACTIVATE);
    if (requireForeground) {
      SetForegroundWindow(window);
      Await([&] { return GetForegroundWindow() == window; });
    }
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
      if (gAppearance.service && !gAppearance.service->Stop(5000).stopped)
        std::terminate();
      gDataStorage.readyToDestroy = true;
      if (window && IsWindow(window)) DestroyWindow(window);
      gInput.service.reset();
      gDataStorage.service.reset();
      gAppearance = AppearanceAdapter{};
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
    gAppearance = AppearanceAdapter{};
    gPicker = PickerState{};
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
    PumpAppearanceResources();
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
    gInput.diagnostic = options.diagnostic;
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
  // The real save-failure UI opens its owned status window once. Close that
  // window and reclaim our fixture before sending any diagnostic keystrokes.
  if (gCountingCheck.window) DestroyWindow(gCountingCheck.window);
  SetForegroundWindow(fixture.window);
  fixture.Await([&] { return GetForegroundWindow() == fixture.window; });

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

void SessionQueryCancellation(const std::filesystem::path& root) {
  {
    Fixture fixture(root, L"session-query");
    fixture.Start();
    fixture.Keys(1);
    fixture.Await([] { return gState.total == 1001; });
    auto* const writer = gDataStorage.service.get();
    // These messages go only to our owned fixture HWND, never to the OS.
    CHECK(WindowProcedure(fixture.window, WM_QUERYENDSESSION, 0, 0) == TRUE);
    CHECK(IsWindow(fixture.window) && gDataStorage.sessionQueryPending &&
        gDataStorage.closing && !gDataStorage.stopping && !gDataStorage.readyToDestroy);
    CHECK(gDataStorage.service.get() == writer && writer->running());
    CHECK(!gInput.service->running() && DataStorageIdle() && !gImportReady);
    fixture.CheckStored(1001, 11);
    WindowProcedure(fixture.window, WM_ENDSESSION, FALSE, 0);
    CHECK(IsWindow(fixture.window) && !gDataStorage.closing &&
        !gDataStorage.sessionQueryPending && gImportReady);
    CHECK(gInput.service->running() && writer->running());
    fixture.Keys(2);
    fixture.Await([] { return gState.total == 1003; });
    fixture.DrainStorage();
    fixture.CheckStored(1003, 13);

    // Retain an accepted write without consuming its completion. QUERY must
    // time out, keep that exact request owned, and resume rather than exit.
    gState.selectedPackId = "session-pending-write";
    gState.dirty = true;
    PumpDataStorage(true);
    CHECK(gDataStorage.inFlight && gDataStorage.model->in_flight());
    const auto acceptedId = gDataStorage.inFlight->id;
    gDataStorage.pumping = true;
    const auto queryStarted = GetTickCount64();
    CHECK(WindowProcedure(fixture.window, WM_QUERYENDSESSION, 0, 0) == FALSE);
    CHECK(GetTickCount64() - queryStarted < 4000);
    CHECK(IsWindow(fixture.window) && !gDataStorage.closing &&
        !gDataStorage.sessionQueryPending && !gDataStorage.stopping && gImportReady);
    CHECK(gDataStorage.service.get() == writer && writer->running() &&
        gDataStorage.inFlight && gDataStorage.inFlight->id == acceptedId &&
        gDataStorage.model->in_flight() && gInput.service->running());
    // Windows may still send END(FALSE) after our own timeout veto.
    WindowProcedure(fixture.window, WM_ENDSESSION, FALSE, 0);
    CHECK(!gDataStorage.closing && gInput.service->running());
    gDataStorage.pumping = false;
    fixture.Keys(1);
    fixture.Await([] { return gState.total == 1004; });
    fixture.DrainStorage();
    fixture.CheckStored(1004, 14);

    CHECK(WindowProcedure(fixture.window, WM_QUERYENDSESSION, 0, 0) == TRUE);
    CHECK(IsWindow(fixture.window) && writer->running());
    WindowProcedure(fixture.window, WM_ENDSESSION, TRUE, 0);
    fixture.Await([&] { return !IsWindow(fixture.window); });
    CHECK(gDataStorage.readyToDestroy && !writer->running());
    fixture.CheckStored(1004, 14);
  }
  {
    Fixture fixture(root, L"explicit-close");
    fixture.Start();
    gDataStorage.pumping = true;
    WindowProcedure(fixture.window, WM_CLOSE, 0, 0);
    CHECK(gDataStorage.closing && !gDataStorage.sessionQueryPending);
    WindowProcedure(fixture.window, WM_ENDSESSION, FALSE, 0);
    CHECK(gDataStorage.closing && !gDataStorage.sessionQueryPending);
    gDataStorage.pumping = false;
    fixture.Await([&] { return !IsWindow(fixture.window); });
    CHECK(gDataStorage.readyToDestroy);
  }
  std::cout << "PASS system query cancel/timeout resumes counting and saving; accepted write retained; only confirmed end destroys HWND\n";
}

#if defined(NIUMA_RUNTIME_CANDIDATE)
void SaveVisualFrame(const std::filesystem::path& path, const niuma::runtime::PixelImage& image) {
  Gdiplus::Bitmap bitmap(image.width, image.height, static_cast<INT>(image.strideBytes),
      PixelFormat32bppPARGB, const_cast<BYTE*>(image.bgraPremultiplied.data()));
  const CLSID encoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}};
  CHECK(bitmap.Save(path.c_str(), &encoder) == Gdiplus::Ok);
}
void ComparePackageVisuals(Fixture& fixture, const std::filesystem::path& output, const std::string& id) {
  const auto* metadata = gAppearanceCatalog.Find(id);
  CHECK(id.empty() || metadata);
  niuma::AppearanceAnimationOptions options;
  options.pixelDensity = 1;
  niuma::AppearanceResourceMemory memory;
  std::unique_ptr<niuma::AppearancePack> reference;
  std::wstring error;
  if (metadata) CHECK(niuma::PrepareAppearanceAnimation(niuma::RequestAppearanceResources(*metadata), options,
      &reference, &memory, &error) == niuma::AppearancePreparationStatus::Ready);
  CHECK(LoadAllPngResources());
  gState.windowWidth = 240; gState.windowHeight = 250; gState.dpi = 192;
  SetWindowPos(gState.window, nullptr, 0, 0, 240, 250, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  if (gDisplay.display->scene()->pixelDensity != 1) {
    CHECK(RequestCurrentAppearance(id,false,true));
    fixture.Await([] { return !gAppearance.currentRequest; },15000);
    CHECK(!gDisplay.failed && gDisplay.display->scene()->pixelDensity == 1);
  }
  for (unsigned elapsed : {0u,420u,650u}) {
    const auto now = GetTickCount64();
    gState.striking = true; gState.strikeStarted = now - elapsed; gState.strikeDurationMs = 1000;
    input_runtime::ClientDisplayState view;
    view.action = {true,0,gState.strikeStarted,1000};
    view.text.merit = std::to_wstring(gState.todayTotal);
    view.text.pixelScale = 1;
    niuma::runtime::PixelImage gpu;
    CHECK(gDisplay.display->DrawLatest(view, now, 240, 250, &gpu));
    // Render the unchanged GDI adapter into its owned diagnostic DIB. The
    // production candidate never enters this reference or GPU-readback path.
    gAppearance.current = std::move(reference);
    gRuntimeCandidate = false;
    RenderLayeredWindow(now);
    gRuntimeCandidate = true;
    reference = std::move(gAppearance.current);
    CHECK(gLayeredSurface.bytes() == gpu.bgraPremultiplied.size());
    niuma::runtime::PixelImage gdi;
    gdi.width = 240; gdi.height = 250; gdi.strideBytes = 960;
    auto* begin = static_cast<const BYTE*>(gLayeredSurface.pixels());
    gdi.bgraPremultiplied.assign(begin,begin+gLayeredSurface.bytes());
    unsigned maxDifference = 0; std::uint64_t totalDifference = 0, visible = 0;
    for (std::size_t i = 0; i < gdi.bgraPremultiplied.size(); i += 4) {
      if (!gdi.bgraPremultiplied[i+3] && !gpu.bgraPremultiplied[i+3]) continue;
      ++visible;
      for (unsigned c=0;c<4;++c) {
        const auto difference = static_cast<unsigned>(std::abs(int(gdi.bgraPremultiplied[i+c])-int(gpu.bgraPremultiplied[i+c])));
        maxDifference = std::max(maxDifference,difference); totalDifference += difference;
      }
    }
    CHECK(visible>0);
    const auto base = (id.empty() ? "builtin.woodfish" : id)+"-"+std::to_string(elapsed);
    SaveVisualFrame(output/(base+"-gdi.png"),gdi);
    SaveVisualFrame(output/(base+"-gpu.png"),gpu);
    std::cout << "VISUAL " << base << " meanAbsVisibleChannel=" <<
        double(totalDifference)/(visible*4) << " maxChannel=" << maxDifference <<
        " diagnosticReadback=true; filter differences require visual review\n";
  }
  gState.striking = false;
  gLayeredSurface.Reset(); gArtworkSurface.Reset(); gArtworkValid = false;
  gWidgetGlyphCache.Clear();
  ReleasePngResource(gFish); ReleasePngResource(gMallet);
}
void CompositionApplicationAdapter(const std::filesystem::path& root) {
  struct NativeSession {
    ULONG_PTR gdi = 0;
    NativeSession() {
      CHECK(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)));
      Gdiplus::GdiplusStartupInput input;
      CHECK(Gdiplus::GdiplusStartup(&gdi, &input, nullptr) == Gdiplus::Ok);
    }
    ~NativeSession() { Gdiplus::GdiplusShutdown(gdi); CoUninitialize(); }
  } native;
  {
    Fixture fixture(root, L"composition-app", true);
    CHECK(IsRuntimeCandidate());
    CHECK(RequestCurrentAppearance({}, false));
    fixture.Await([] { return !gAppearance.currentRequest && gDisplay.display &&
        gDisplay.display->scene() != nullptr; }, 15000);
    CHECK(!gDisplay.failed && gDisplay.display->ready() && !gAppearance.current &&
        gDisplay.display->scene()->kind == input_runtime::AppearanceSceneKind::Woodfish);
    ComparePackageVisuals(fixture, fixture.directory, {});
    wchar_t fixtureRoot[MAX_PATH]{};
    CHECK(GetEnvironmentVariableW(L"NIUMA_RUNTIME_FIXTURE_DIR", fixtureRoot, MAX_PATH) > 0);
    std::wstring catalogError;
    CHECK(gAppearanceCatalog.ReloadMetadata(AppearanceDirectory(), &catalogError) && catalogError.empty());
    for (const wchar_t* name : {L"offwork-button.nmgpack", L"koi-bubbles.nmgpack"}) {
      std::string installed;
      std::wstring error;
      CHECK(gAppearanceCatalog.Install((std::filesystem::path(fixtureRoot) / name).wstring(),
          AppearanceDirectory(), &installed, &error));
      CHECK(!installed.empty() && error.empty());
      CHECK(RequestCurrentAppearance(installed, false));
      fixture.Await([&] { return !gAppearance.currentRequest && gDisplay.display->scene() &&
          gDisplay.display->scene()->source.id == installed; }, 15000);
      CHECK(!gDisplay.failed && gState.selectedPackId == installed && !gAppearance.current);
      CHECK(gDisplay.display->scene()->memory.residentBytes() <= 24 * 1024 * 1024);
      fixture.DrainStorage();
      CHECK(gDataStorage.model->current().appearance.selectedPackId == installed);
      ComparePackageVisuals(fixture, fixture.directory, installed);
    }
    const auto diagnosticCaptures = gDisplay.display->BackendStats().diagnosticReadbacks;
    CHECK(diagnosticCaptures == 9);
    fixture.Start();
    fixture.Keys(12);
    fixture.Await([] { return gState.total == 1012; });
    fixture.Await([] { return !gState.striking && !gState.timerRunning; });
    CHECK(!gDisplay.failed && gDisplay.display->Stats().framesPresented > 0);
    auto presents = gDisplay.display->Stats().framesPresented;
    auto uploads = gDisplay.display->Stats().textureUploads;
    for (unsigned i = 0; i < 60; ++i) RenderLayeredWindow(GetTickCount64());
    CHECK(gDisplay.display->Stats().framesPresented == presents &&
        gDisplay.display->Stats().textureUploads == uploads);
    CHECK(gDisplay.display->BackendStats().diagnosticReadbacks == diagnosticCaptures &&
        gLayeredSurface.bytes() == 0 && gArtworkSurface.bytes() == 0);
    gDisplay.measuredFrames = 0;  // Cold startup/assets/visual diagnostics are separate.
    for (unsigned i = 0; i < 30; ++i) {
      fixture.Keys(1);
      fixture.Until(GetTickCount64()+100);
    }
    fixture.Await([] { return gState.total == 1042 && !gState.striking && !gState.timerRunning; });
    CHECK(!gDisplay.failed);
    const auto activeFrames = gDisplay.measuredFrames;
    auto* const assets = gAppearance.service.get();
    const auto prepared = assets->Snapshot().completed;
    const auto* scene = gDisplay.display->scene();
    RECT proposed{60,60,240,248};
    WindowProcedure(fixture.window, WM_DPICHANGED, MAKELONG(144,144),
        reinterpret_cast<LPARAM>(&proposed));
    CHECK(!gDisplay.failed && gDisplay.display->scene() == scene && gAppearance.currentRequest);
    fixture.Await([&] { return !gAppearance.currentRequest && assets->Snapshot().completed > prepared; },15000);
    CHECK(!gDisplay.failed && gDisplay.display->scene()->pixelDensity == .75f);
    scene = gDisplay.display->scene();
    CHECK(gDisplay.display->RecreateDevice());
    RenderLayeredWindow(GetTickCount64());
    CHECK(!gDisplay.failed && gInput.service->running());
    // A cancellable session query retains both scene and asset worker.
    fixture.DrainStorage();
    CHECK(WindowProcedure(fixture.window, WM_QUERYENDSESSION, 0, 0) == TRUE);
    WindowProcedure(fixture.window, WM_ENDSESSION, FALSE, 0);
    CHECK(IsWindow(fixture.window) && !gDataStorage.closing &&
        gDisplay.display->scene() == scene && gAppearance.service.get() == assets);
    SetForegroundWindow(fixture.window);
    fixture.Await([&] { return GetForegroundWindow() == fixture.window; });
    fixture.Keys(2);
    fixture.Await([] { return gState.total == 1044; });
    fixture.DrainStorage(); fixture.CheckStored(1044,54);
    const auto percentile = [](auto samples, std::size_t count, double fraction) {
      CHECK(count > 0);
      std::sort(samples.begin(),samples.begin()+count);
      return samples[static_cast<std::size_t>(std::ceil(count*fraction))-1];
    };
    const auto frameP95 = percentile(gDisplay.frameWorkMs,activeFrames,.95);
    const auto frameP99 = percentile(gDisplay.frameWorkMs,activeFrames,.99);
    const auto regionP95 = percentile(gDisplay.regionWorkMs,activeFrames,.95);
    const auto& adapter = gDisplay.display->Adapter();
    std::ofstream metrics(fixture.directory / L"display-metrics.json");
    CHECK(metrics.good());
    metrics << "{\"adapterKind\":\"" << adapter.kind << "\",\"vendor\":" << adapter.vendorId <<
        ",\"device\":" << adapter.deviceId << ",\"hardwareAccelerated\":" <<
        (adapter.hardwareAccelerated ? "true" : "false") << ",\"frameSamples\":" << activeFrames <<
        ",\"frameWorkWallP95Ms\":" << frameP95 << ",\"frameWorkWallP99Ms\":" << frameP99 <<
        ",\"regionP95Ms\":" << regionP95 << ",\"currentCpuSceneBytes\":" <<
        gDisplay.display->scene()->memory.residentBytes() << ",\"textureBytes\":" <<
        gDisplay.display->BackendStats().textureBytes << ",\"textPixelBytes\":" <<
        gDisplay.display->TextStats().pixelBytes << ",\"physicalTypingMeasured\":false,"
        "\"scope\":\"actual app adapter, private data, tagged synthetic input; active-frame elapsed wall time includes Present wait; not thread CPU time\"}\n";
    metrics.close(); CHECK(metrics.good());
    WindowProcedure(fixture.window, WM_CLOSE, 0, 0);
    fixture.Await([&] { return !IsWindow(fixture.window); });
    CHECK(gDataStorage.readyToDestroy && !gDisplay.display->ready() && assets->Snapshot().stopped);
  }
  gDisplay = DisplayAdapter{};
  gRuntimeCandidate = false;
  std::cout << "PASS actual application composition adapter: real package imports/worker and owned popup with tagged hook, idle no Present, DPI prepared swap, device recreation, session cancel, durable counts, joined exit; software permitted for CI\n";
}
#endif

void AppearanceAdapterBoundaries(const std::filesystem::path& root) {
  struct GdiSession {
    ULONG_PTR token = 0;
    GdiSession() {
      Gdiplus::GdiplusStartupInput input;
      CHECK(Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok);
    }
    ~GdiSession() { Gdiplus::GdiplusShutdown(token); }
  } graphics;
  Fixture fixture(root, L"appearance-adapter");
  // Adapter-only prepared-result fixtures. Actual PNG preparation and pixel
  // equality are covered by the separate, already-passed resource tests.
  auto& metadata = const_cast<std::vector<std::unique_ptr<niuma::AppearancePack>>&>(
      gAppearanceCatalog.packs());
  for (unsigned index = 0; index < 10; ++index) {
    auto pack = std::make_unique<niuma::AppearancePack>();
    pack->id = "fixture." + std::to_string(index);
    pack->sourcePath = (fixture.directory / (std::to_wstring(index) + L".niuma")).wstring();
    pack->contentFingerprint = std::string(63, 'a') + "0123456789"[index];
    metadata.push_back(std::move(pack));
  }
  const auto source = [&](unsigned index) { return niuma::RequestAppearanceResources(*metadata[index]); };
  const auto request = [&](unsigned index, input_runtime::AppearanceLoadKind kind) {
    input_runtime::AppearanceLoadRequest item;
    item.id = ++gAppearance.nextRequest;
    item.generation = gAppearance.generation;
    item.kind = kind;
    item.source = source(index);
    item.animationOptions.pixelDensity = 1.0f;
    return item;
  };
  const auto ready = [](const input_runtime::AppearanceLoadRequest& item) {
    input_runtime::AppearanceLoadResult result;
    result.request = std::make_shared<const input_runtime::AppearanceLoadRequest>(item);
    result.status = niuma::AppearancePreparationStatus::Ready;
    if (item.kind == input_runtime::AppearanceLoadKind::Current) {
      result.animation = std::make_unique<niuma::AppearancePack>();
      result.animation->id = item.source.id;
      result.animation->sourcePath = item.source.sourcePath;
      result.animation->contentFingerprint = item.source.contentFingerprint;
    } else {
      result.thumbnail = std::make_unique<niuma::AppearanceThumbnail>();
      result.thumbnail->source = item.source;
      result.thumbnail->image.image = std::make_unique<Gdiplus::Bitmap>(240, 250, PixelFormat32bppARGB);
    }
    return result;
  };
  auto initial = ready(request(0, input_runtime::AppearanceLoadKind::Current));
  gAppearance.current = std::move(initial.animation);
  gState.selectedPackId = metadata[0]->id;
  SaveState(); fixture.DrainStorage();
  const auto original = CurrentAppearancePack();
  const auto unchanged = [&] {
    CHECK(CurrentAppearancePack() == original && gState.selectedPackId == metadata[0]->id);
    CHECK(gDataStorage.model->current().appearance.selectedPackId == metadata[0]->id);
  };

  auto wanted = request(1, input_runtime::AppearanceLoadKind::Current);
  gAppearance.currentRequest = wanted;
  auto stale = wanted; ++stale.generation;
  ApplyAppearanceLoadResult(ready(stale));
  unchanged(); CHECK(gAppearance.currentRequest);
  auto wrongDensity = wanted; wrongDensity.animationOptions.pixelDensity = 2;
  ApplyAppearanceLoadResult(ready(wrongDensity));
  unchanged(); CHECK(gAppearance.currentRequest);
  auto failed = ready(wanted);
  failed.animation.reset();
  failed.status = niuma::AppearancePreparationStatus::BudgetExceeded;
  failed.error = ERROR_NOT_ENOUGH_MEMORY;
  failed.detail = L"fixture budget exceeded";
  ApplyAppearanceLoadResult(std::move(failed));
  unchanged(); CHECK(!gAppearance.currentRequest && !gAppearance.error.empty());

  wanted = request(1, input_runtime::AppearanceLoadKind::Current);
  gAppearance.currentRequest = wanted;
  metadata[1]->contentFingerprint = std::string(64, 'b');
  ApplyAppearanceLoadResult(ready(wanted));
  unchanged(); CHECK(!gAppearance.currentRequest);
  wanted = request(1, input_runtime::AppearanceLoadKind::Current);
  gAppearance.currentRequest = wanted;
  ApplyAppearanceLoadResult(ready(wanted));
  CHECK(CurrentAppearancePack() && CurrentAppearancePack()->id == metadata[1]->id);
  CHECK(gState.selectedPackId == metadata[1]->id && !gAppearance.currentRequest);
  fixture.DrainStorage();
  CHECK(gDataStorage.model->current().appearance.selectedPackId == metadata[1]->id);

  // Cache rejection must be remembered; it must not turn paint notifications
  // into repeated preparation of the same thumbnail.
  gAppearance.thumbnails = niuma::AppearanceThumbnailCache(1, 1);
  auto thumbnail = request(0, input_runtime::AppearanceLoadKind::Thumbnail);
  gAppearance.thumbnailRequest = thumbnail;
  ApplyAppearanceLoadResult(ready(thumbnail));
  CHECK(!gAppearance.thumbnailRequest && ThumbnailFailed(source(0)) &&
      gAppearance.thumbnails.size() == 0);
  gAppearance.thumbnails = niuma::AppearanceThumbnailCache{};
  thumbnail = request(1, input_runtime::AppearanceLoadKind::Thumbnail);
  gAppearance.thumbnailRequest = thumbnail;
  ApplyAppearanceLoadResult(ready(thumbnail));
  CHECK(gAppearance.thumbnails.Find(source(1)) && gAppearance.thumbnails.size() == 1);

  // The real worker handles missing private fixture files. No global hooks
  // start, and no test success result is substituted for this error path.
  CHECK(InitializeAppearanceResources());
  auto* const loader = gAppearance.service.get();
  CHECK(RequestCurrentAppearance(metadata[0]->id, false, true));
  CHECK(gState.selectedPackId == metadata[1]->id);
  fixture.Await([] { return !gAppearance.currentRequest && !gAppearance.error.empty(); });
  CHECK(CurrentAppearancePack()->id == metadata[1]->id &&
      gDataStorage.model->current().appearance.selectedPackId == metadata[1]->id);
  gPicker.window = fixture.window;
  gPicker.scrollRow = 0;
  QueueVisibleThumbnails();
  fixture.Await([&] {
    const auto state = loader->Snapshot();
    return !gAppearance.thumbnailRequest && !state.activeId && !state.pendingId && !state.readyId;
  });
  CHECK(gAppearance.failedThumbnails.size() == 6 && gAppearance.thumbnails.size() == 1);
  const auto completed = loader->Snapshot().completed;
  for (unsigned count = 0; count < 16; ++count) PumpAppearanceResources();
  CHECK(loader->Snapshot().completed == completed && !gAppearance.thumbnailRequest);
  gPicker.window = nullptr;

  // A cancelled shutdown keeps the loader alive. Explicit close waits for its
  // real stopped acknowledgement before destroying the notification HWND.
  CHECK(WindowProcedure(fixture.window, WM_QUERYENDSESSION, 0, 0) == TRUE);
  CHECK(loader->Snapshot().running && IsWindow(fixture.window));
  WindowProcedure(fixture.window, WM_ENDSESSION, FALSE, 0);
  CHECK(loader->Snapshot().running && !gAppearance.stopping && IsWindow(fixture.window));
  CHECK(!gInput.service);  // This group never installs global hooks.
  WindowProcedure(fixture.window, WM_CLOSE, 0, 0);
  fixture.Await([&] { return !IsWindow(fixture.window); });
  CHECK(loader->Snapshot().stopped && gDataStorage.readyToDestroy);
  std::cout << "PASS app resource adapter: stale/error/DPI/fingerprint gates, commit after ready, thumbnail failure bound, real loader error and exit ownership\n";
}

#if defined(NIUMA_RUNTIME_CANDIDATE)
void RuntimeCandidateIsolation(const std::filesystem::path& evidence) {
  CHECK(!gInput.service && !gDataStorage.service);
  CHECK(!InitializeAcceptanceMode(false, false, false, false, L""));
  CHECK(!InitializeAcceptanceMode(false, false, true, false, L""));
  wchar_t temporary[MAX_PATH]{};
  const DWORD length = GetTempPathW(MAX_PATH, temporary);
  CHECK(length && length < MAX_PATH);
  const auto root = std::filesystem::path(temporary) /
      (L"niuma-candidate-path-test-" + std::to_wstring(GetCurrentProcessId()) +
       L"-" + std::to_wstring(GetTickCount64()));
  CHECK(CreateDirectoryW(root.c_str(), nullptr));
  // This is the only tree this scope may remove; every entry is test-owned.
  struct RemoveOwnedTree {
    std::filesystem::path path;
    ~RemoveOwnedTree() { std::error_code error; std::filesystem::remove_all(path, error); }
  } cleanup{root};
  const auto valid = root / L"valid";
  const auto copied = root / L"copied-marker";
  const auto foreign = root / L"foreign";
  CHECK(CreateDirectoryW(valid.c_str(), nullptr));
  CHECK(CreateDirectoryW(copied.c_str(), nullptr));
  CHECK(CreateDirectoryW(foreign.c_str(), nullptr));
  CHECK(!InitializeAcceptanceMode(true, false, true, false, valid.wstring()));
  CHECK(!InitializeAcceptanceMode(false, true, true, false, valid.wstring()));
  CHECK(!InitializeAcceptanceMode(false, false, true, true, valid.wstring()));
  CHECK(std::filesystem::is_empty(valid));
  std::wstring canonical;
  CHECK(!InitializeRuntimeCandidateDirectory(temporary, &canonical));
  CHECK(!InitializeRuntimeCandidateDirectory(evidence.wstring(), &canonical));
  CHECK(InitializeRuntimeCandidateDirectory(valid.wstring(), &canonical));
  const auto boundRoot = canonical;
  const auto marker = valid / kRuntimeProfileMarker;
  CHECK(std::filesystem::is_regular_file(marker));
  {
    std::ofstream file(valid / L"data.ini"); file << "[state]\ntotal=27\n";
    CHECK(file.good());
  }
  CHECK(InitializeRuntimeCandidateDirectory(valid.wstring(), &canonical));
  CHECK(canonical == boundRoot);
  CHECK(CopyFileW(marker.c_str(), (copied / kRuntimeProfileMarker).c_str(), TRUE));
  CHECK(!InitializeRuntimeCandidateDirectory(copied.wstring(), &canonical));
  {
    std::ofstream file(foreign / L"data.ini"); file << "existing foreign data";
    CHECK(file.good());
  }
  CHECK(!InitializeRuntimeCandidateDirectory(foreign.wstring(), &canonical));

  bool reparseChecked = false;
  const auto link = root / L"linked-root";
  if (CreateSymbolicLinkW(link.c_str(), valid.c_str(),
      SYMBOLIC_LINK_FLAG_DIRECTORY | 0x2 /* ALLOW_UNPRIVILEGED_CREATE */)) {
    reparseChecked = true;
    CHECK(!InitializeRuntimeCandidateDirectory(link.wstring(), &canonical));
    CHECK(!InitializeRuntimeCandidateDirectory((link / L"..").wstring(), &canonical));
    CHECK(RemoveDirectoryW(link.c_str()));
    const auto nested = valid / L"linked-child";
    CHECK(CreateSymbolicLinkW(nested.c_str(), foreign.c_str(), SYMBOLIC_LINK_FLAG_DIRECTORY | 0x2));
    CHECK(!InitializeRuntimeCandidateDirectory(valid.wstring(), &canonical));
    CHECK(RemoveDirectoryW(nested.c_str()));
  } else {
    CHECK(GetLastError() == ERROR_PRIVILEGE_NOT_HELD || GetLastError() == ERROR_INVALID_PARAMETER);
    std::cout << "SKIP filesystem reparse fixture: runner has no symlink privilege\n";
  }
  CHECK(InitializeAcceptanceMode(false, false, true, false, valid.wstring()));
  CHECK(IsRuntimeCandidate() && gIsolatedAcceptance && !gReminderPreviewAcceptance);
  CHECK(DataPath() == boundRoot + L"\\data.ini");
  CHECK(wcscmp(MainWindowClass(), kWindowClass) != 0 &&
      wcscmp(kRuntimeMutexName, kMutexName) != 0 &&
      (wcsstr(WindowTitle(), L"测试数据") || wcsstr(WindowTitle(), L"Test Data")));
  CHECK(!SetLaunchAtLoginEnabled(true) && !SetLaunchAtLoginEnabled(false) &&
      !IsLaunchAtLoginEnabled());
  CHECK(!gInput.service && !gDataStorage.service);  // No global hooks or worker launched.
  CHECK(ProfileCount(valid / L"data.ini", L"state", L"total") == 27);
  {
    std::ofstream file(marker, std::ios::binary | std::ios::trunc);
    file << "not a candidate marker"; CHECK(file.good());
  }
  CHECK(!InitializeRuntimeCandidateDirectory(valid.wstring(), &canonical));
  gRuntimeCandidate = false;
  gIsolatedAcceptance = false;
  gReminderPreviewAcceptance = false;
  gAcceptanceRoot.clear();
  std::cout << "PASS isolated runtime candidate entry, path-bound marker/restart, no system writes or hooks; reparse="
      << reparseChecked << "\n";
}
#endif
}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  try {
    CHECK(argc == 2 || (argc == 3 && (wcscmp(argv[2], L"--appearance-only") == 0 ||
        wcscmp(argv[2], L"--composition-only") == 0)));
    const bool appearanceOnly = argc == 3 && wcscmp(argv[2], L"--appearance-only") == 0;
    const bool compositionOnly = argc == 3 && wcscmp(argv[2], L"--composition-only") == 0;
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
    if (!appearanceOnly && !compositionOnly) {
      FullLedgerAndFinalSave(root);
      FallbackRestartAndSelfCheck(root);
      ReminderShownOnlyAfterConfirmation(root);
      ReminderDiscardedAfterEpochChange(root);
      SessionQueryCancellation(root);
#if defined(NIUMA_RUNTIME_CANDIDATE)
      RuntimeCandidateIsolation(root);
#endif
    }
    if (!compositionOnly) AppearanceAdapterBoundaries(root);
#if defined(NIUMA_RUNTIME_CANDIDATE)
    if (!appearanceOnly) CompositionApplicationAdapter(root);
#endif
    std::ofstream receipt(root / L"RUNTIME_APP_RESULT.json");
    CHECK(receipt.good());
    receipt << "{\"status\":\"passed\",\"groups\":"
#if defined(NIUMA_RUNTIME_CANDIDATE)
        << ((appearanceOnly || compositionOnly) ? 1 : 8) << ",\"candidatePathIsolation\":" << (!appearanceOnly && !compositionOnly ? "true" : "false") << ","
#else
        << ((appearanceOnly || compositionOnly) ? 1 : 6) << ","
#endif
        << "\"scope\":\"" << (appearanceOnly ? "appearance-only" : compositionOnly ? "composition-only" : "full-adapter") << "\","
        << "\"fullLedgerRows\":529,\"realAdapterPaths\":true,"
        << "\"inputChecksRun\":" << (!appearanceOnly ? "true" : "false") << ","
        << "\"diagnosticServiceInstallation\":" << (!appearanceOnly ? "true" : "false") << ","
        <<
        "\"asyncStorageAdapter\":true,\"normalCloseJoinedOwners\":true,"
        "\"syntheticShutdownCancellation\":true,\"actualSystemShutdown\":false,"
        "\"appearanceAdapter\":true,\"preparedSuccessFixtures\":true,\"realMissingFileLoader\":true,"
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
