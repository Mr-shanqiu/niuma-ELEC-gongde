// External receiver for same-machine no-client/old-client/new-client trials.
// Only synthetic tagged F24 is recorded in this owned window. No global hook,
// user text, client profile, startup entry, association or security change.
#include <windows.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
constexpr unsigned kMaximumPairs = 600;
constexpr ULONG_PTR kTag = 0x4e490000;
constexpr ULONG_PTR kMask = ~static_cast<ULONG_PTR>(0xffff);
constexpr wchar_t kClass[] = L"NiuMaExternalInputDeliveryProbe";
struct State {
  std::array<std::atomic<LONGLONG>, kMaximumPairs> sent{}, returned{};
  std::array<LONGLONG, kMaximumPairs> received{}, painted{};
  std::atomic<unsigned> sentPairs{0}, acceptedEvents{0}, abortReason{0};
  std::atomic<bool> finished{false}, stop{false};
  std::atomic<DWORD> sourceError{0};
  LARGE_INTEGER frequency{};
  LONGLONG started = 0;
  HWND window = nullptr;
  HANDLE client = nullptr;
  unsigned wanted = 0, receivedPairs = 0, latest = 0;
  ~State() { if (client) CloseHandle(client); }
};
LONGLONG Tick() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return value.QuadPart; }
double Ms(LONGLONG ticks, const State& state) {
  return static_cast<double>(ticks) * 1000.0 / state.frequency.QuadPart;
}
LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lp);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  auto* state = reinterpret_cast<State*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (state && message == WM_KEYDOWN && wp == VK_F24) {
    const auto tag = static_cast<ULONG_PTR>(GetMessageExtraInfo());
    const auto sequence = static_cast<unsigned>(tag & 0xffff);
    if ((tag & kMask) == kTag && sequence && sequence <= state->wanted) {
      if (!state->received[sequence - 1]) {
        state->received[sequence - 1] = Tick();
        ++state->receivedPairs;
      }
      state->latest = sequence;
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    }
  }
  if (state && message == WM_PAINT) {
    PAINTSTRUCT ps{};
    const HDC dc = BeginPaint(window, &ps);
    RECT rect{}; GetClientRect(window, &rect);
    FillRect(dc, &rect, reinterpret_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
    const auto text = L"Independent input delivery test\nSynthetic F24 only\nReceived: " +
        std::to_wstring(state->receivedPairs) + L" / " + std::to_wstring(state->wanted);
    DrawTextW(dc, text.c_str(), -1, &rect, DT_CENTER | DT_VCENTER | DT_WORDBREAK);
    EndPaint(window, &ps);
    if (state->latest && !state->painted[state->latest - 1]) state->painted[state->latest - 1] = Tick();
    return 0;
  }
  if (state && message == WM_CLOSE) {
    if (!state->finished) state->abortReason = 6;
    state->stop = true;
    DestroyWindow(window);
    return 0;
  }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, message, wp, lp);
}
void Pump(DWORD waitMs = 10) {
  MSG message{};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    if (message.message == WM_QUIT) continue;
    TranslateMessage(&message); DispatchMessageW(&message);
  }
  MsgWaitForMultipleObjectsEx(0, nullptr, waitMs, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
}
void WriteDistribution(std::ostream& out, std::vector<double> values) {
  if (values.empty()) { out << "null"; return; }
  std::sort(values.begin(), values.end());
  double total = 0; for (const auto value : values) total += value;
  const auto p = [&](unsigned percentile) { return values[(values.size() * percentile + 99) / 100 - 1]; };
  out << "{\"samples\":" << values.size() << ",\"meanMs\":" << total / values.size()
      << ",\"p95Ms\":" << p(95) << ",\"p99Ms\":" << p(99) << ",\"maxMs\":" << values.back() << "}";
}
int Run(const std::filesystem::path& report, unsigned pairs, DWORD clientPid) {
  if (std::filesystem::exists(report) || !std::filesystem::is_directory(report.parent_path()))
    throw std::runtime_error("A new report path in an existing evidence directory is required");
  State state;
  state.wanted = pairs;
  if (!QueryPerformanceFrequency(&state.frequency)) throw std::runtime_error("QPC unavailable");
  if (clientPid) {
    state.client = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, clientPid);
    if (!state.client) throw std::runtime_error("Could not bind the expected client process");
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  WNDCLASSW cls{}; cls.hInstance = GetModuleHandleW(nullptr); cls.lpfnWndProc = Procedure;
  cls.lpszClassName = kClass; cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  if (!RegisterClassW(&cls)) throw std::runtime_error("RegisterClass failed");
  state.window = CreateWindowExW(WS_EX_APPWINDOW, kClass, L"NiuMa independent input test — synthetic F24 only",
      WS_OVERLAPPEDWINDOW | WS_VISIBLE, 60, 60, 560, 220, nullptr, nullptr, cls.hInstance, &state);
  if (!state.window) throw std::runtime_error("Receiver window could not be created");
  ShowWindow(state.window, SW_SHOW);
  SetForegroundWindow(state.window); SetFocus(state.window);
  const auto focusDeadline = GetTickCount64() + 15000;
  while (IsWindow(state.window) && GetForegroundWindow() != state.window && GetTickCount64() < focusDeadline) Pump();
  const bool foreground = IsWindow(state.window) && GetForegroundWindow() == state.window;
  std::thread sender;
  state.started = Tick();
  if (foreground) {
    sender = std::thread([&] {
      const auto cadenceStart = std::chrono::steady_clock::now();
      for (unsigned i = 0; i < pairs && !state.stop; ++i) {
        if (GetForegroundWindow() != state.window) { state.abortReason = 1; break; }
        if (state.client && WaitForSingleObject(state.client, 0) != WAIT_TIMEOUT) { state.abortReason = 2; break; }
        INPUT keys[2]{};
        for (auto& key : keys) { key.type = INPUT_KEYBOARD; key.ki.wVk = VK_F24; key.ki.dwExtraInfo = kTag | (i + 1); }
        keys[1].ki.dwFlags = KEYEVENTF_KEYUP;
        state.sent[i] = Tick(); SetLastError(0);
        const auto accepted = SendInput(2, keys, sizeof(INPUT));
        state.returned[i] = Tick(); state.acceptedEvents += accepted;
        if (accepted != 2) {
          state.sourceError = GetLastError(); state.abortReason = 3;
          // Pair submission can fail partially. Release only this fixed test
          // key; never replay a keydown or inject user text to recover.
          if (accepted == 1) SendInput(1, &keys[1], sizeof(INPUT));
          break;
        }
        ++state.sentPairs;
        const auto next = cadenceStart + std::chrono::milliseconds((i + 1) * 100);
        // Equal requested cadence across versions. A blocked chain must not
        // lower the offered load silently or replay a burst to catch up.
        if (std::chrono::steady_clock::now() > next) { state.abortReason = 7; break; }
        std::this_thread::sleep_until(next);
      }
      state.finished = true;
    });
  } else { state.abortReason = 4; state.finished = true; }
  const auto deadline = GetTickCount64() + pairs * 100ULL + 10000;
  auto finishedAt = 0ULL;
  while (IsWindow(state.window)) {
    Pump();
    if (state.finished && !finishedAt) finishedAt = GetTickCount64();
    if (state.finished && (state.abortReason || state.receivedPairs == pairs) &&
        GetTickCount64() - finishedAt >= 150) break;
    if (GetTickCount64() >= deadline) { state.abortReason = 5; break; }
  }
  state.stop = true;
  if (sender.joinable()) sender.join();
  const auto elapsedMs = Ms(Tick() - state.started, state);
  if (IsWindow(state.window)) DestroyWindow(state.window);
  UnregisterClassW(kClass, cls.hInstance);
  std::vector<double> delivery, paint, calls;
  for (unsigned i = 0; i < pairs; ++i) {
    const auto start = state.sent[i].load(), returned = state.returned[i].load();
    if (!start) continue;
    if (state.received[i] >= start) delivery.push_back(Ms(state.received[i] - start, state));
    if (state.painted[i] >= start) paint.push_back(Ms(state.painted[i] - start, state));
    if (returned >= start) calls.push_back(Ms(returned - start, state));
  }
  const bool complete = foreground && !state.abortReason && state.sentPairs == pairs &&
      state.acceptedEvents == pairs * 2 && delivery.size() == pairs;
  std::ofstream out(report);
  if (!out.good()) throw std::runtime_error("Could not create report");
  out << "{\"executionComplete\":" << (complete ? "true" : "false")
      << ",\"foregroundEstablished\":" << (foreground ? "true" : "false")
      << ",\"requestedPairs\":" << pairs << ",\"sentPairs\":" << state.sentPairs
      << ",\"acceptedInjectedEvents\":" << state.acceptedEvents << ",\"receivedPairs\":" << state.receivedPairs
      << ",\"paintedMarkers\":" << paint.size() << ",\"abortReason\":" << state.abortReason
      << ",\"sourceError\":" << state.sourceError << ",\"elapsedMs\":" << elapsedMs
      << ",\"expectedClientPid\":" << clientPid << ",\"injectionCallWall\":"; WriteDistribution(out, calls);
  out << ",\"sourceToOwnedWindowKeydown\":"; WriteDistribution(out, delivery);
  out << ",\"sourceToPaintSubmission\":"; WriteDistribution(out, paint);
  out << ",\"physicalTypingMeasured\":false,\"physicalDisplayLatencyMeasured\":false,"
      "\"userInputRecorded\":false,\"globalHookInstalledByProbe\":false,\"samples\":[";
  bool first = true;
  for (unsigned i = 0; i < pairs; ++i) {
    const auto start = state.sent[i].load(); if (!start) continue;
    if (!first) out << ','; first = false;
    out << "{\"sequence\":" << i + 1 << ",\"sourceElapsedMs\":" << Ms(start - state.started, state)
        << ",\"deliveryMs\":";
    if (state.received[i] >= start) out << Ms(state.received[i] - start, state); else out << "null";
    out << ",\"paintSubmissionMs\":";
    if (state.painted[i] >= start) out << Ms(state.painted[i] - start, state); else out << "null";
    out << ",\"injectionCallMs\":";
    const auto returned = state.returned[i].load();
    if (returned >= start) out << Ms(returned - start, state); else out << "null";
    out << '}';
  }
  out << "]}\n"; out.close();
  if (!out.good()) throw std::runtime_error("Report write was not confirmed");
  std::cout << "INPUT DELIVERY " << (complete ? "complete" : "incomplete") << ": "
      << delivery.size() << '/' << pairs << " owned-window events; no physical-input verdict\n";
  return complete ? 0 : 2;
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 3 || argc > 4) throw std::runtime_error("Usage: probe new-report.json pairs [expected-client-pid]");
    const auto pairs = std::stoul(argv[2]);
    if (pairs < 20 || pairs > kMaximumPairs) throw std::runtime_error("pairs must be 20..600");
    return Run(argv[1], static_cast<unsigned>(pairs), argc == 4 ? std::stoul(argv[3]) : 0);
  } catch (const std::exception& error) {
    std::cerr << "FAILED input delivery: " << error.what() << '\n'; return 1;
  }
}
