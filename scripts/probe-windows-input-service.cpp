// Isolated CI-only probe. No product entry point, user data, actual key contents,
// autostart, file associations, or persistent settings are accessed.
#include "../src/windows/runtime/input_service.h"

#if !defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
#error This isolated probe requires NIUMA_INPUT_SERVICE_DIAGNOSTICS.
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {
using namespace niuma::windows::runtime;
using niuma::client::core::InputFault;
constexpr unsigned kKeys = 120;
constexpr ULONG_PTR kTag = 0x4e520000;
constexpr ULONG_PTR kTagMask = ~static_cast<ULONG_PTR>(0xffff);
constexpr UINT kInputWake = WM_APP + 70;
constexpr UINT kBlockUi = WM_APP + 71;
constexpr wchar_t kWindowClass[] = L"NiuMaIsolatedInputServiceProbe";
LARGE_INTEGER frequency{};

LONGLONG Tick() noexcept {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return value.QuadPart;
}

double Milliseconds(LONGLONG ticks) noexcept {
  return static_cast<double>(ticks) * 1000.0 / static_cast<double>(frequency.QuadPart);
}

struct Samples {
  std::array<std::atomic<LONGLONG>, kKeys> sent, entered, counted, witnessed;
  std::atomic<unsigned> accepted{0}, observedKeys{0}, witnessKeys{0};
  std::atomic<DWORD> sourceError{0};
  std::atomic<bool> senderDone{false}, stop{false};
  Samples() {
    for (unsigned i = 0; i < kKeys; ++i) sent[i] = entered[i] = counted[i] = witnessed[i] = 0;
  }
};

void CountedKey(void* context, unsigned index, LONGLONG entered, LONGLONG counted) noexcept {
  auto& samples = *static_cast<Samples*>(context);
  if (index >= kKeys) return;
  samples.entered[index].store(entered, std::memory_order_relaxed);
  samples.counted[index].store(counted, std::memory_order_relaxed);
  samples.observedKeys.fetch_add(1, std::memory_order_release);
}

class Witness {
 public:
  explicit Witness(Samples& samples) : samples_(samples) {}
  ~Witness() { Stop(); }

  bool Start() {
    ready_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!ready_ || !stop_) { error = GetLastError(); return false; }
    thread_ = std::thread([this] {
      current_ = this;
      MSG message{};
      PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
      HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, Hook, GetModuleHandleW(nullptr), 0);
      error = hook ? ERROR_SUCCESS : GetLastError();
      installed.store(hook != nullptr, std::memory_order_release);
      SetEvent(ready_);
      if (hook) {
        bool quit = false;
        while (!quit) {
          const DWORD result = MsgWaitForMultipleObjectsEx(1, &stop_, INFINITE,
              QS_ALLINPUT, MWMO_INPUTAVAILABLE);
          if (result == WAIT_OBJECT_0 || result == WAIT_FAILED) break;
          while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { quit = true; break; }
            DispatchMessageW(&message);
          }
        }
        if (!UnhookWindowsHookEx(hook)) cleanupError = GetLastError();
      }
      current_ = nullptr;
    });
    const auto ready = WaitForSingleObject(ready_, 5000);
    if (ready != WAIT_OBJECT_0) { error = ERROR_TIMEOUT; return false; }
    return installed.load(std::memory_order_acquire);
  }

  void Stop() noexcept {
    if (thread_.joinable()) { SetEvent(stop_); thread_.join(); }
    if (ready_) CloseHandle(ready_);
    if (stop_) CloseHandle(stop_);
    ready_ = stop_ = nullptr;
  }

  std::atomic<DWORD> error{0}, cleanupError{0};
  std::atomic<bool> installed{false};

 private:
  static thread_local Witness* current_;
  static LRESULT CALLBACK Hook(int code, WPARAM message, LPARAM data) noexcept {
    if (current_ && code == HC_ACTION && data &&
        (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
      const auto* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
      const unsigned sequence = static_cast<unsigned>(event->dwExtraInfo & 0xffff);
      if (event->vkCode == VK_F24 && (event->dwExtraInfo & kTagMask) == kTag &&
          sequence != 0 && sequence <= kKeys) {
        current_->samples_.witnessed[sequence - 1].store(Tick(), std::memory_order_relaxed);
        current_->samples_.witnessKeys.fetch_add(1, std::memory_order_release);
      }
    }
    return CallNextHookEx(nullptr, code, message, data);
  }
  Samples& samples_;
  HANDLE ready_ = nullptr, stop_ = nullptr;
  std::thread thread_;
};
thread_local Witness* Witness::current_ = nullptr;

struct UiContext {
  InputService* service = nullptr;
  unsigned stallMs = 0;
  unsigned wakeCount = 0;
  unsigned stallCount = 0;
  std::array<double, 3> actualStalls{};
  InputServiceSnapshot last;
};

LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lp);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  auto* context = reinterpret_cast<UiContext*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (context && message == kInputWake) {
    ++context->wakeCount;
    context->service->ReadLatest(context->last);
    return 0;
  }
  if (context && message == kBlockUi) {
    const auto started = Tick();
    while (Milliseconds(Tick() - started) < context->stallMs) YieldProcessor();
    if (context->stallCount < context->actualStalls.size())
      context->actualStalls[context->stallCount] = Milliseconds(Tick() - started);
    ++context->stallCount;
    return 0;
  }
  if (message == WM_KEYDOWN || message == WM_KEYUP) return 0;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    const HDC dc = BeginPaint(window, &paint);
    RECT rect{};
    GetClientRect(window, &rect);
    DrawTextW(dc, L"Isolated input-thread test\nSynthetic F24 events only\nNo product settings or user key contents", -1,
        &rect, DT_CENTER | DT_VCENTER | DT_WORDBREAK | DT_NOPREFIX);
    EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcW(window, message, wp, lp);
}

void PumpOnce(DWORD waitMs = 1) {
  MSG message{};
  for (unsigned batch = 0; batch < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++batch) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  MsgWaitForMultipleObjectsEx(0, nullptr, waitMs, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
}

struct Timing {
  unsigned samples = 0;
  double mean = 0, p95 = 0, p99 = 0, maximum = 0;
};

Timing TimingBetween(const std::array<std::atomic<LONGLONG>, kKeys>& end,
                     const std::array<std::atomic<LONGLONG>, kKeys>& start) {
  std::vector<double> values;
  for (unsigned i = 0; i < kKeys; ++i) {
    const auto from = start[i].load(), to = end[i].load();
    if (from && to >= from) values.push_back(Milliseconds(to - from));
  }
  Timing result;
  result.samples = static_cast<unsigned>(values.size());
  if (values.empty()) return result;
  std::sort(values.begin(), values.end());
  for (const auto value : values) result.mean += value;
  result.mean /= static_cast<double>(values.size());
  result.p95 = values[(values.size() - 1) * 95 / 100];
  result.p99 = values[(values.size() - 1) * 99 / 100];
  result.maximum = values.back();
  return result;
}

struct Result {
  const char* name = "";
  unsigned uiStallMs = 0, ioStallMs = 0;
  bool functionalPassed = false, latencyPassed = false;
  bool visible = false, foreground = false, serviceStopped = false;
  DWORD startError = 0, keyboardError = 0, mouseError = 0, witnessError = 0, sourceError = 0, cleanupError = 0;
  unsigned accepted = 0, observed = 0, witnessed = 0, uiWakes = 0, uiStalls = 0;
  std::uint64_t countDelta = 0, dailyDelta = 0, unaccounted = 0;
  unsigned accountingFault = 0;
  double ioActualMs = 0, p95Delta = 0;
  std::array<double, 3> actualStalls{};
  Timing hook, count, witness, callback;
};

Result RunScenario(const char* name, unsigned uiStallMs, unsigned ioStallMs) {
  Result result;
  result.name = name;
  result.uiStallMs = uiStallMs;
  result.ioStallMs = ioStallMs;
  Samples samples;
  InputService service;
  UiContext context;
  context.service = &service;
  context.stallMs = uiStallMs;
  HWND window = CreateWindowExW(0, kWindowClass, L"NiuMa isolated input service probe",
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
      80, 80, 520, 220, nullptr, nullptr, GetModuleHandleW(nullptr), &context);
  if (!window) { result.startError = GetLastError(); return result; }
  ShowWindow(window, SW_SHOW);
  SetForegroundWindow(window);
  const auto focusDeadline = GetTickCount64() + 1000;
  while (GetForegroundWindow() != window && GetTickCount64() < focusDeadline) PumpOnce(10);
  result.visible = IsWindowVisible(window) != FALSE;
  result.foreground = GetForegroundWindow() == window;
  if (!result.foreground) {
    result.startError = ERROR_ACCESS_DENIED;
    DestroyWindow(window);
    return result;
  }

  // Install first: the application hook will precede this witness in the real
  // hook chain. Witness timing therefore includes application forwarding.
  Witness witness(samples);
  if (!witness.Start()) {
    result.witnessError = witness.error.load();
    witness.Stop();
    DestroyWindow(window);
    return result;
  }
  InputServiceOptions options;
  options.total = 1000;
  options.date = InputService::CaptureLocalDate();
  options.daily = {{options.date, 50}};
  options.notificationWindow = window;
  options.notificationMessage = kInputWake;
  options.diagnostic = {kTagMask, kTag, kKeys, &samples, CountedKey};
  const auto start = service.Start(options);
  result.startError = start.error;
  result.keyboardError = start.keyboardError;
  result.mouseError = start.mouseError;
  result.witnessError = witness.error.load();
  if (!start.started || start.keyboardError || start.mouseError) {
    service.Stop();
    witness.Stop();
    DestroyWindow(window);
    return result;
  }

  const auto settle = GetTickCount64() + 150;
  while (GetTickCount64() < settle) PumpOnce(5);
  LONGLONG ioStarted = 0, ioFinished = 0;
  std::thread storage;
  if (ioStallMs) storage = std::thread([&] {
    ioStarted = Tick();
    Sleep(ioStallMs);  // Simulated independent storage task, not a real disk test.
    while (Milliseconds(Tick() - ioStarted) < ioStallMs) Sleep(1);
    ioFinished = Tick();
  });
  const auto begun = std::chrono::steady_clock::now();
  std::thread sender([&] {
    for (unsigned i = 0; i < kKeys && !samples.stop.load(); ++i) {
      if (GetForegroundWindow() != window) { samples.sourceError = ERROR_BUSY; break; }
      if (uiStallMs && (i == 20 || i == 60 || i == 100)) {
        if (!PostMessageW(window, kBlockUi, 0, 0)) { samples.sourceError = GetLastError(); break; }
      }
      INPUT input[2]{};
      for (auto& event : input) {
        event.type = INPUT_KEYBOARD;
        event.ki.wVk = VK_F24;
        event.ki.dwExtraInfo = kTag | (i + 1);
      }
      input[1].ki.dwFlags = KEYEVENTF_KEYUP;
      samples.sent[i] = Tick();
      SetLastError(ERROR_SUCCESS);
      const auto accepted = SendInput(2, input, sizeof(INPUT));
      samples.accepted.fetch_add(accepted);
      if (accepted != 2) { samples.sourceError = GetLastError(); break; }
      std::this_thread::sleep_until(begun + std::chrono::milliseconds((i + 1) * 20));
    }
    samples.senderDone = true;
  });
  while (IsWindow(window) && std::chrono::steady_clock::now() - begun < std::chrono::seconds(15)) {
    PumpOnce();
    if (samples.senderDone.load() && samples.observedKeys.load() == kKeys &&
        samples.witnessKeys.load() == kKeys) break;
    if (samples.senderDone.load() && samples.accepted.load() != kKeys * 2) break;
  }
  samples.stop = true;
  sender.join();
  if (storage.joinable()) storage.join();
  // Drain any already accepted pair and UI completion notification before stop.
  const auto drainUntil = GetTickCount64() + 50;
  while (IsWindow(window) && GetTickCount64() < drainUntil) PumpOnce(1);
  const auto& final = service.Stop();
  witness.Stop();

  result.serviceStopped = final.stopped && !service.running();
  result.cleanupError = final.cleanupError ? final.cleanupError : witness.cleanupError.load();
  result.accepted = samples.accepted.load();
  result.observed = samples.observedKeys.load();
  result.witnessed = samples.witnessKeys.load();
  result.sourceError = samples.sourceError.load();
  result.countDelta = final.snapshot.input.total - options.total;
  for (const auto& daily : final.daily)
    result.dailyDelta += daily.total - (daily.date == options.date ? 50 : 0);
  result.unaccounted = final.snapshot.input.unaccountedOperations;
  result.accountingFault = static_cast<unsigned>(final.snapshot.input.fault);
  result.uiWakes = context.wakeCount;
  result.uiStalls = context.stallCount;
  result.actualStalls = context.actualStalls;
  result.ioActualMs = ioFinished >= ioStarted ? Milliseconds(ioFinished - ioStarted) : 0;
  result.hook = TimingBetween(samples.entered, samples.sent);
  result.count = TimingBetween(samples.counted, samples.sent);
  result.witness = TimingBetween(samples.witnessed, samples.sent);
  result.callback = TimingBetween(samples.counted, samples.entered);
  result.functionalPassed = result.serviceStopped && !result.cleanupError && !result.sourceError &&
      result.accepted == kKeys * 2 && result.observed == kKeys && result.witnessed == kKeys &&
      result.countDelta == kKeys && result.dailyDelta == kKeys && result.unaccounted == 0 &&
      final.snapshot.input.fault == InputFault::None && result.hook.samples == kKeys &&
      result.count.samples == kKeys && result.witness.samples == kKeys &&
      (!uiStallMs || result.uiStalls == 3) && (!ioStallMs || result.ioActualMs >= ioStallMs);
  if (IsWindow(window)) DestroyWindow(window);
  return result;
}

void WriteTiming(std::ostream& output, const Timing& timing) {
  output << "{\"samples\":" << timing.samples << ",\"meanMs\":" << timing.mean
      << ",\"p95Ms\":" << timing.p95 << ",\"p99Ms\":" << timing.p99
      << ",\"maxMs\":" << timing.maximum << '}';
}

void WriteResult(std::ostream& output, const Result& result) {
  output << "{\"scenario\":\"" << result.name << "\",\"functionalPassed\":"
      << (result.functionalPassed ? "true" : "false") << ",\"latencyBudgetPassed\":"
      << (result.latencyPassed ? "true" : "false") << ",\"uiStallRequestedMs\":" << result.uiStallMs
      << ",\"uiStalls\":" << result.uiStalls << ",\"uiStallActualMs\":["
      << result.actualStalls[0] << ',' << result.actualStalls[1] << ',' << result.actualStalls[2]
      << "],\"storageTaskRequestedMs\":" << result.ioStallMs << ",\"storageTaskActualMs\":" << result.ioActualMs
      << ",\"acceptedInjectedEvents\":" << result.accepted << ",\"applicationKeydowns\":" << result.observed
      << ",\"independentWitnessKeydowns\":" << result.witnessed << ",\"countDelta\":" << result.countDelta
      << ",\"dailyDelta\":" << result.dailyDelta << ",\"unaccountedOperations\":" << result.unaccounted
      << ",\"accountingFault\":" << result.accountingFault << ",\"uiWakeMessages\":" << result.uiWakes
      << ",\"windowVisible\":" << (result.visible ? "true" : "false")
      << ",\"ownedForegroundWindow\":" << (result.foreground ? "true" : "false")
      << ",\"serviceStopped\":" << (result.serviceStopped ? "true" : "false")
      << ",\"startError\":" << result.startError << ",\"keyboardError\":" << result.keyboardError
      << ",\"mouseError\":" << result.mouseError << ",\"witnessError\":" << result.witnessError
      << ",\"sourceError\":" << result.sourceError << ",\"cleanupError\":" << result.cleanupError
      << ",\"sourceToApplicationHook\":";
  WriteTiming(output, result.hook);
  output << ",\"sourceToCountCompletion\":"; WriteTiming(output, result.count);
  output << ",\"sourceToIndependentWitness\":"; WriteTiming(output, result.witness);
  output << ",\"applicationBeforeForwardingWork\":"; WriteTiming(output, result.callback);
  output << ",\"witnessP95IncreaseFromBaselineMs\":" << result.p95Delta << '}';
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) {
    std::cerr << "Usage: niuma-input-service-probe <report.json>\n";
    return 2;
  }
  QueryPerformanceFrequency(&frequency);
  WNDCLASSW windowClass{};
  windowClass.lpfnWndProc = Procedure;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  windowClass.lpszClassName = kWindowClass;
  if (!RegisterClassW(&windowClass)) {
    std::cerr << "Unable to register isolated window: " << GetLastError() << '\n';
    return 2;
  }
  std::array<Result, 4> results = {
      RunScenario("baseline", 0, 0),
      RunScenario("ui-blocked-100ms", 100, 0),
      RunScenario("ui-blocked-500ms", 500, 0),
      RunScenario("storage-task-blocked-2000ms", 0, 2000),
  };
  bool passed = true;
  for (auto& result : results) {
    result.p95Delta = result.witness.p95 - results[0].witness.p95;
    result.latencyPassed = result.witness.samples == kKeys && result.witness.p95 <= 10 &&
        result.witness.p99 <= 25 && result.p95Delta <= 2;
    passed = passed && result.functionalPassed && result.latencyPassed;
  }
  const std::filesystem::path report(argv[1]);
  if (!report.parent_path().empty()) std::filesystem::create_directories(report.parent_path());
  std::ofstream output(report);
  if (!output) { std::cerr << "Unable to write report\n"; return 2; }
  output << std::fixed << std::setprecision(6)
      << "{\"status\":\"" << (passed ? "passed" : "blocked-or-failed")
      << "\",\"knownKeydownsPerScenario\":" << kKeys
      << ",\"realWindowsHooks\":true,\"independentDownstreamWitness\":true,"
         "\"physicalKeyboardTest\":false,\"productMainEntryRun\":false,\"productDataAccessed\":false,"
         "\"actualPersistenceTest\":false,\"scope\":\"dedicated input service with tagged synthetic F24; "
         "UI busy waits and a simulated independent storage task; full product integration and real typing remain pending\","
         "\"thresholds\":{\"witnessP95Ms\":10,\"witnessP99Ms\":25,\"p95IncreaseMs\":2},\"scenarios\":[";
  for (std::size_t i = 0; i < results.size(); ++i) {
    if (i) output << ',';
    WriteResult(output, results[i]);
  }
  output << "]}\n";
  std::cout << "Input service probe " << (passed ? "passed" : "blocked or failed") << '\n';
  return passed ? 0 : 1;
}
