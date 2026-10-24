// Private complete-app measurement. No global input injection, installed
// profile, security changes, screenshot readback, or hardware verdict in CI.
#define wmain NiuMaUnusedAdapterMain
#include "test-windows-runtime-app.cpp"
#undef wmain

namespace {
using niuma::runtime::GpuTimingRead;
struct Distribution {
  std::vector<double> values;
  Distribution() { values.reserve(8192); }
  void Add(double value) {
    CHECK(std::isfinite(value) && value >= 0);
    CHECK(values.size() < 8192);
    values.push_back(value);
  }
  void Write(std::ostream& out) {
    if (values.empty()) { out << "null"; return; }
    std::sort(values.begin(), values.end());
    double sum = 0;
    for (const auto value : values) sum += value;
    const auto p = [&](double fraction) {
      return values[static_cast<std::size_t>(std::ceil(values.size() * fraction)) - 1];
    };
    out << "{\"samples\":" << values.size() << ",\"meanMs\":" << sum / values.size()
        << ",\"p95Ms\":" << p(.95) << ",\"p99Ms\":" << p(.99)
        << ",\"maxMs\":" << values.back() << "}";
  }
};
std::uint64_t ThreadCpu() {
  FILETIME created{}, exited{}, kernel{}, user{};
  CHECK(GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user));
  ULARGE_INTEGER k{}, u{};
  k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
  u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
  return k.QuadPart + u.QuadPart;
}
void RunFrameMetrics(const std::filesystem::path& parent, unsigned seconds) {
  CHECK(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)));
  Gdiplus::GdiplusStartupInput startup;
  ULONG_PTR gdi = 0;
  CHECK(Gdiplus::GdiplusStartup(&gdi, &startup, nullptr) == Gdiplus::Ok);
  {
    // No system input is injected by this probe. A foreground-window wait is
    // unrelated to the measurement and can fail for an SSH-launched process.
    Fixture fixture(parent, L"frame-metrics", true, false);
    std::cout << "STAGE passive-fixture-ready\n" << std::flush;
    gOffwork.enabled = true; gOffwork.hour = 18; gOffwork.minute = 0;
    gState.dpi = 192;
    gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
    gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
    CHECK(SetWindowPos(fixture.window, nullptr, 0, 0, gState.windowWidth,
        gState.windowHeight, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE));
    wchar_t fixtureRoot[MAX_PATH]{};
    CHECK(GetEnvironmentVariableW(L"NIUMA_RUNTIME_FIXTURE_DIR", fixtureRoot, MAX_PATH) > 0);
    std::wstring error;
    std::string id;
    CHECK(gAppearanceCatalog.Install((std::filesystem::path(fixtureRoot) /
        L"offwork-button.nmgpack").wstring(), AppearanceDirectory(), &id, &error));
    CHECK(RequestCurrentAppearance(id, false));
    fixture.Await([] { return !gAppearance.currentRequest && gDisplay.display &&
        gDisplay.display->scene(); }, 15000);
    CHECK(!gDisplay.failed);
    std::cout << "STAGE scene-ready\n" << std::flush;
    auto& display = *gDisplay.display;
    niuma::runtime::GpuTimingSample sentinel{123, -99};
    CHECK(display.ReadDiagnosticGpuTiming(sentinel) == GpuTimingRead::Disabled);
    CHECK(sentinel.frame == 123 && sentinel.intervalMs == -99);
    const bool gpuEnabled = display.EnableDiagnosticGpuTiming();
    if (gpuEnabled) {
      CHECK(display.ReadDiagnosticGpuTiming(sentinel) == GpuTimingRead::Pending);
      CHECK(sentinel.frame == 123 && sentinel.intervalMs == -99);
    }
    fixture.Start(true); // Only tagged diagnostics are accepted; no physical keys recorded.
    RefreshOffwork(false); CHECK(SyncOffworkTimer()); ResizeOffworkWindow();
    Distribution whole, work, submit, present, region, gpu;
    Distribution regionMath, regionAll, regionStrong, regionWeak, regionSerialize, regionCreate, regionInstall;
    const auto collect = [&] {
      for (std::size_t i = 0; i < gDisplay.measuredFrames; ++i) {
        whole.Add(gDisplay.frameWorkMs[i]);
        work.Add(gDisplay.frameWithoutPresentMs[i]);
        submit.Add(gDisplay.drawSubmitMs[i]);
        present.Add(gDisplay.presentCallMs[i]);
        region.Add(gDisplay.regionWorkMs[i]);
        const auto& detail = gDisplay.regionDetails[i];
        CHECK(detail.supportAllMs + detail.supportStrongMs + detail.weakResolveMs <= detail.mathMs + .01);
        CHECK(detail.mathMs + detail.serializeMs + detail.nativeCreateMs + gDisplay.regionInstallMs[i] <=
            gDisplay.regionWorkMs[i] + .01);
        regionMath.Add(detail.mathMs);
        regionAll.Add(detail.supportAllMs);
        regionStrong.Add(detail.supportStrongMs);
        regionWeak.Add(detail.weakResolveMs);
        regionSerialize.Add(detail.serializeMs);
        regionCreate.Add(detail.nativeCreateMs);
        regionInstall.Add(gDisplay.regionInstallMs[i]);
      }
      gDisplay.measuredFrames = 0;
      if (!gpuEnabled) return;
      for (unsigned i = 0; i < 4; ++i) {
        niuma::runtime::GpuTimingSample value{0, -1};
        const auto read = display.ReadDiagnosticGpuTiming(value);
        if (read == GpuTimingRead::Ready) gpu.Add(value.intervalMs);
        else if (read == GpuTimingRead::Invalid) CHECK(value.intervalMs == -1);
        else { CHECK(value.intervalMs == -1); break; }
      }
    };
    // Verify the fixed ring drops measurements rather than blocking rendering.
    // These startup/control frames are excluded from the measured distribution.
    if (gpuEnabled) {
      for (unsigned i = 0; i < 8; ++i) {
        display.Invalidate(); RenderCompositionWindow(GetTickCount64());
        CHECK(!gDisplay.failed);
      }
      CHECK(display.DiagnosticGpuTimingStats().pending == 4);
      CHECK(display.DiagnosticGpuTimingStats().dropped >= 4);
      const auto deadline = GetTickCount64() + 5000;
      while (display.DiagnosticGpuTimingStats().pending && GetTickCount64() < deadline) {
        collect(); Sleep(1);
      }
      CHECK(display.DiagnosticGpuTimingStats().pending == 0);
    }
    whole.values.clear(); work.values.clear(); submit.values.clear();
    present.values.clear(); region.values.clear(); gpu.values.clear();
    regionMath.values.clear(); regionAll.values.clear(); regionStrong.values.clear();
    regionWeak.values.clear(); regionSerialize.values.clear(); regionCreate.values.clear(); regionInstall.values.clear();
    gDisplay.measuredFrames = 0;
    const auto controls = display.DiagnosticGpuTimingStats();
    const auto cpuStart = ThreadCpu();
    const auto started = GetTickCount64(), end = started + seconds * 1000ULL;
    auto nextOperation = started;
    unsigned operations = 0;
    while (GetTickCount64() < end) {
      fixture.Pump(2);
      CHECK(!gDisplay.failed && gInput.service->running());
      const auto now = GetTickCount64();
      if (now >= nextOperation) {
        input_runtime::InputCommand command;
        command.kind = input_runtime::InputCommandKind::LocalFallbackClick;
        command.expectedEpoch = gInput.latest.input.epoch;
        command.capturedMs = now;
        command.capturedDate = input_runtime::InputService::CaptureLocalDate();
        CHECK(SendInputCommand(command)); ++operations;
        nextOperation = now + 100;
      }
      collect();
    }
    const auto uiCpu100ns = ThreadCpu() - cpuStart;
    const auto elapsed = GetTickCount64() - started;
    const auto timing = display.DiagnosticGpuTimingStats();
    CHECK(!whole.values.empty());
    if (gpuEnabled && SUCCEEDED(timing.error)) CHECK(!gpu.values.empty());
    std::ofstream out(fixture.directory / L"frame-metrics.json");
    out << "{\"adapterKind\":\"" << display.Adapter().kind << "\",\"vendorId\":"
        << display.Adapter().vendorId << ",\"deviceId\":" << display.Adapter().deviceId
        << ",\"elapsedMs\":" << elapsed << ",\"diagnosticDpi\":192,\"syntheticCommands\":"
        << operations << ",\"uiThreadCpuMs\":" << uiCpu100ns / 10000.0
        << ",\"frameWallIncludingPresent\":"; whole.Write(out);
    out << ",\"appWorkWallExcludingPresent\":"; work.Write(out);
    out << ",\"drawSubmissionCallWall\":"; submit.Write(out);
    out << ",\"presentCallWall\":"; present.Write(out);
    out << ",\"hitRegionCallWall\":"; region.Write(out);
    out << ",\"regionMathWall\":"; regionMath.Write(out);
    out << ",\"regionSupportAllWall\":"; regionAll.Write(out);
    out << ",\"regionSupportStrongWall\":"; regionStrong.Write(out);
    out << ",\"regionWeakResolveWall\":"; regionWeak.Write(out);
    out << ",\"regionSerializeWall\":"; regionSerialize.Write(out);
    out << ",\"regionNativeCreateWall\":"; regionCreate.Write(out);
    out << ",\"regionNativeInstallWall\":"; regionInstall.Write(out);
    out << ",\"gpuDrawTimestampInterval\":"; gpu.Write(out);
    out << ",\"gpuQueriesEnabled\":" << (gpuEnabled ? "true" : "false")
        << ",\"gpuQueryError\":" << static_cast<long>(timing.error)
        << ",\"gpuQueriesInvalid\":" << timing.invalid - controls.invalid
        << ",\"gpuQueriesDropped\":" << timing.dropped - controls.dropped
        << ",\"controlRingFullDrops\":" << controls.dropped
        << ",\"gpuQueriesPending\":" << timing.pending
        << ",\"gpuIntervalIsActiveExecutionTime\":false,\"dwmMeasured\":false,"
           "\"hardwarePerformanceAccepted\":false,\"physicalInputMeasured\":false,"
           "\"cpuCallTimesAreElapsedNotExecution\":true,\"normalClientEnablesGpuQueries\":false}\n";
    out.close(); CHECK(out.good());
    fixture.DrainStorage();
    WindowProcedure(fixture.window, WM_CLOSE, 0, 0);
    fixture.Await([&] { return !IsWindow(fixture.window); }, 10000);
    CHECK(gDataStorage.readyToDestroy && gAppearance.service->Snapshot().stopped);
    CHECK(!display.DiagnosticGpuTimingStats().enabled && display.DiagnosticGpuTimingStats().pending == 0);
    std::wcout << L"FRAME METRICS " << fixture.directory.wstring() << L"\n";
  }
  gDisplay = DisplayAdapter{}; gAppearanceCatalog = niuma::AppearanceCatalog{};
  gRuntimeCandidate = false;
  Gdiplus::GdiplusShutdown(gdi); CoUninitialize();
}
}
int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  try {
    CHECK(argc == 3 && std::filesystem::is_directory(argv[1]));
    const auto seconds = std::stoul(argv[2]);
    CHECK(seconds >= 10 && seconds <= 90);
    WNDCLASSW cls{}; cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpfnWndProc = FixtureProcedure; cls.lpszClassName = kFixtureClass;
    CHECK(RegisterClassW(&cls));
    cls.lpfnWndProc = ReminderWindowProcedure; cls.lpszClassName = kReminderClass;
    CHECK(RegisterClassW(&cls));
    RunFrameMetrics(std::filesystem::path(argv[1]), seconds);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAILED frame metrics: " << error.what() << "; Win32=" << GetLastError() << "\n";
    return 1;
  }
}
