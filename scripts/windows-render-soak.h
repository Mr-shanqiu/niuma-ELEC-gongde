// Included only by the disposable native diagnostic, never by the client.
#include <atomic>
#include <thread>

namespace soak {
std::atomic<std::uint64_t> posted{0}, handled{0}, postFailures{0};
std::atomic<bool> stop{false};
LARGE_INTEGER frequency{};
perf::RollingTiming queueLatency;
constexpr UINT kDoneMessage = WM_APP + 1001;
bool sourceDone = false;

LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == kCountMessage) {
    CountGlobalDelivery(false, 0, wp);
    LARGE_INTEGER now{}; QueryPerformanceCounter(&now);
    queueLatency.Add(static_cast<double>(now.QuadPart - lp) * 1000 / frequency.QuadPart);
    ++handled;
    return 0;
  }
  if (message == WM_TIMER &&
      (wp == kAnimationTimer || wp == kOffworkTimer || wp == kDayTimer))
    return WindowProcedure(window, message, wp, lp);
  if (message == kDoneMessage) { sourceDone = true; return 0; }
  return DefWindowProcW(window, message, wp, lp);
}

std::uint64_t CpuTicks() {
  FILETIME created{}, exited{}, kernel{}, user{};
  Check(GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) != 0,
      "process CPU sample");
  ULARGE_INTEGER k{}, u{};
  k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
  u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
  return k.QuadPart + u.QuadPart;
}
}

static int RunRenderSoak(const std::filesystem::path& root,
    const std::filesystem::path& report, unsigned duration) {
  using namespace soak;
  const auto acceptance = report.parent_path() / (std::string("soak-data-") + NIUMA_PROFILE_VERSION);
  std::filesystem::create_directories(acceptance);
  gIsolatedAcceptance = true;
  gAcceptanceRoot = acceptance.wstring();
  Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "soak COM");
  Gdiplus::GdiplusStartupInput startup;
  Check(Gdiplus::GdiplusStartup(&gState.gdiplusToken, &startup, nullptr) == Gdiplus::Ok, "soak GDI+");
  Check(LoadAllPngResources(), "soak resource load");
  auto pack = std::make_unique<niuma::AppearancePack>();
  LoadFixture(root / L"assets/appearance-packs/offwork-button", *pack);
  gProfileFixturePack = pack.get();
  SYSTEMTIME local{}; GetLocalTime(&local); gState.currentDay = DateKey(local);
  gOffwork.enabled = true;
  gState.dpi = 192;
  gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
  gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
  WNDCLASSW wc{}; wc.lpfnWndProc = Procedure;
  wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"NiuMaOwnedSoakFixture";
  Check(RegisterClassW(&wc) != 0, "soak window class");
  gState.window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      wc.lpszClassName, L"Owned render soak", WS_POPUP, 0, 0,
      gState.windowWidth, gState.windowHeight, nullptr, nullptr, wc.hInstance, nullptr);
  Check(gState.window != nullptr, "soak owned window");
  gOffwork.enabled = true;
  RefreshOffwork(false);
  Check(SyncOffworkTimer(), "soak countdown timer");
  RenderLayeredWindow(GetTickCount64());
  QueryPerformanceFrequency(&frequency);
  const auto initialTotal = gState.total;
  const auto started = std::chrono::steady_clock::now();
  std::thread source([&] {
    // Known messages to this one window, not keyboard injection or user input.
    for (unsigned i = 0; i < duration * 20 && !stop; ++i) {
      const auto elapsed = i / 20;
      if (elapsed < duration * 2 / 3) {
        LARGE_INTEGER sent{}; QueryPerformanceCounter(&sent);
        ++posted;
        if (!PostMessageW(gState.window, kCountMessage, 0, static_cast<LPARAM>(sent.QuadPart))) {
          --posted; ++postFailures; break;
        }
      }
      std::this_thread::sleep_until(started + std::chrono::milliseconds((i + 1) * 50));
    }
    PostMessageW(gState.window, kDoneMessage, 0, 0);
  });
  std::ofstream output(report); Check(output.good(), "soak report output");
  output << std::fixed << std::setprecision(4)
      << "{\"version\":\"" << NIUMA_PROFILE_VERSION << "\",\"durationSeconds\":" << duration
      << ",\"knownInputRatePerSecond\":20,\"scope\":\"real product count and timer handlers; known posted messages; hidden owned window; isolated persistence\","
         "\"realHooksInstalled\":false,\"physicalTypingMeasured\":false,\"samples\":[";
  std::uint64_t lastCpu = CpuTicks();
  auto lastSampleTime = started;
  unsigned nextSample = 5, lastChurn = 0, reloads = 0, switches = 0;
  bool first = true, idleRestored = false;
  perf::soakMode = true;
  while (!sourceDone) {
    MSG message{};
    const auto pumpStarted = std::chrono::steady_clock::now();
    // An overdue 16ms timer can stay ready when an original frame takes 100ms.
    // Bound only this diagnostic pump batch so monitoring/churn still executes.
    for (unsigned batch = 0; batch < 16 && PeekMessageW(&message, gState.window, 0, 0, PM_REMOVE); ++batch) {
      DispatchMessageW(&message);
      if (std::chrono::steady_clock::now() - pumpStarted >= std::chrono::milliseconds(20)) break;
    }
    const auto now = std::chrono::steady_clock::now();
    const auto elapsed = std::chrono::duration<double>(now - started).count();
    if (elapsed > duration + 15) { stop = true; break; }
    const auto second = static_cast<unsigned>(elapsed);
    const unsigned phase = second < duration / 3 ? 0 : second < duration * 2 / 3 ? 1 : 2;
    if (phase == 1 && second != lastChurn) {
      lastChurn = second;
      if (second % 10 == 0) {
        auto replacement = std::make_unique<niuma::AppearancePack>();
        LoadFixture(root / L"assets/appearance-packs/offwork-button", *replacement);
        gProfileFixturePack = nullptr;
        pack = std::move(replacement); ++reloads;
      }
      gProfileFixturePack = second % 2 ? nullptr : pack.get();
      gState.dpi = (second % 3 + 1) * 96;
      gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
      gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
      SetWindowPos(gState.window, nullptr, 0, 0, gState.windowWidth, gState.windowHeight,
          SWP_NOZORDER | SWP_NOACTIVATE);
      RenderLayeredWindow(GetTickCount64()); ++switches;
    }
    if (phase == 2 && !idleRestored) {
      idleRestored = true;
      gProfileFixturePack = pack.get(); gState.dpi = 192;
      gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
      gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
      SetWindowPos(gState.window, nullptr, 0, 0, gState.windowWidth, gState.windowHeight,
          SWP_NOZORDER | SWP_NOACTIVATE);
      RenderLayeredWindow(GetTickCount64());
    }
    if (elapsed >= nextSample) {
      PROCESS_MEMORY_COUNTERS_EX memory{};
      Check(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)) != 0,
          "soak memory sample");
      DWORD handles = 0; Check(GetProcessHandleCount(GetCurrentProcess(), &handles) != 0, "soak handle sample");
      const auto cpu = CpuTicks();
      const auto interval = std::chrono::duration<double>(now - lastSampleTime).count();
      const auto sent = posted.load(), received = handled.load();
      if (!first) output << ','; first = false;
      output << "{\"elapsedSeconds\":" << elapsed << ",\"phase\":" << phase
          << ",\"privateBytes\":" << memory.PrivateUsage << ",\"workingSetBytes\":" << memory.WorkingSetSize
          << ",\"gdiObjects\":" << GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS)
          << ",\"userObjects\":" << GetGuiResources(GetCurrentProcess(), GR_USEROBJECTS)
          << ",\"handles\":" << handles << ",\"oneCoreCpuPercent\":" << (cpu-lastCpu)/100000.0/interval
          << ",\"posted\":" << sent << ",\"handled\":" << received << ",\"pending\":" << sent-received
          << ",\"queueCompletionMeanMs\":" << (queueLatency.count ? queueLatency.total/queueLatency.count : 0)
          << ",\"queueCompletionP95Ms\":" << queueLatency.P95() << ",\"queueCompletionMaxMs\":" << queueLatency.maximum
          << ",\"frames\":" << perf::soakFrames.count
          << ",\"frameMeanMs\":" << (perf::soakFrames.count ? perf::soakFrames.total/perf::soakFrames.count : 0)
          << ",\"frameP95Ms\":" << perf::soakFrames.P95() << '}';
      output.flush();
      std::printf("SOAK %.0fs phase=%u private=%llu handles=%lu pending=%llu\n", elapsed, phase,
          static_cast<unsigned long long>(memory.PrivateUsage), handles, static_cast<unsigned long long>(sent-received));
      std::fflush(stdout);
      perf::soakFrames = {}; queueLatency = {}; lastCpu = cpu; lastSampleTime = now;
      nextSample += 5;
    }
    MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
  }
  stop = true; source.join();
  MSG message{};
  while (PeekMessageW(&message, gState.window, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
  perf::soakMode = false;
  SaveState(); FlushOffwork();
  const auto countDelta = gState.total - initialTotal;
  const bool persisted = ReadIniTotal() == gState.total;
  output << "],\"posted\":" << posted.load() << ",\"handled\":" << handled.load()
      << ",\"postFailures\":" << postFailures.load() << ",\"countDelta\":" << countDelta
      << ",\"persistedCountMatches\":" << (persisted ? "true" : "false")
      << ",\"sourceReloads\":" << reloads << ",\"shapeOrDpiChanges\":" << switches
      << ",\"completed\":" << (sourceDone ? "true" : "false") << '}';
  output.close();
  KillTimer(gState.window, kAnimationTimer); KillTimer(gState.window, kOffworkTimer);
  gProfileFixturePack = nullptr; pack.reset(); ReleaseAllPngResources();
  DestroyWindow(gState.window); gState.window = nullptr;
  Gdiplus::GdiplusShutdown(gState.gdiplusToken); CoUninitialize();
  Check(sourceDone && postFailures.load() == 0 && posted.load() == handled.load() && handled.load() == countDelta && persisted,
      "soak completes with exact input and persisted count");
  return 0;
}
