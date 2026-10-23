// Real Windows hooks and an owned visible window; no app entry point, settings,
// user records or physical-key content. Diagnostic-only options admit tagged
// injection, a deliberately unavailable mouse hook and a seeded reminder request.
#include "../src/windows/runtime/input_service.h"

#if !defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
#error This isolated contract test requires NIUMA_INPUT_SERVICE_DIAGNOSTICS.
#endif

#include <array>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace niuma::windows::runtime;
using niuma::client::core::InputFault;
constexpr ULONG_PTR tag = 0x4e530000;
constexpr ULONG_PTR tagMask = ~static_cast<ULONG_PTR>(0xffff);
constexpr UINT wakeMessage = WM_APP + 70;
constexpr wchar_t className[] = L"NiuMaIsolatedInputContract";
#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

struct Fixture {
  InputService service;
  HWND window = nullptr;
  InputServiceSnapshot latest;
  std::uint64_t nextId = 1;

  Fixture() {
    window = CreateWindowExW(0, className, L"NiuMa isolated input contract",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        80, 80, 520, 220, nullptr, nullptr, GetModuleHandleW(nullptr), this);
    CHECK(window != nullptr);
  }
  ~Fixture() {
    service.Stop();
    if (window) DestroyWindow(window);
  }
  void Pump(DWORD wait = 1) {
    MSG message{};
    for (unsigned n = 0; n < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++n) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
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
  void Until(ULONGLONG when) { while (GetTickCount64() < when) Pump(1); }
  void Start(bool noMouse = false, bool reminder = false) {
    ShowWindow(window, SW_SHOW);
    SetForegroundWindow(window);
    Await([&] { return GetForegroundWindow() == window; });
    RECT bounds{};
    CHECK(GetClientRect(window, &bounds));
    POINT center{bounds.right / 2, bounds.bottom / 2};
    CHECK(ClientToScreen(window, &center));
    CHECK(SetCursorPos(center.x, center.y));
    InputServiceOptions options;
    options.total = 100;
    options.date = InputService::CaptureLocalDate();
    options.daily = {{options.date, 10}};
    options.notificationWindow = window;
    options.notificationMessage = wakeMessage;
    options.diagnostic.tagMask = tagMask;
    options.diagnostic.tagValue = tag;
    options.diagnostic.maximumSequence = 32;
    options.diagnostic.forceMouseUnavailable = noMouse;
    options.diagnostic.allowTaggedMouse = true;
    options.diagnostic.seedReminderOpportunity = reminder;
    const auto start = service.Start(options);
    CHECK(start.started && start.error == ERROR_SUCCESS && start.keyboardError == ERROR_SUCCESS);
    CHECK(noMouse ? start.mouseError == ERROR_ACCESS_DENIED : start.mouseError == ERROR_SUCCESS);
    Await([&] { return latest.running && latest.input.epoch == 1; });
  }
  InputCommand Command(InputCommandKind kind) {
    InputCommand command;
    command.kind = kind;
    command.id = nextId++;
    command.expectedEpoch = latest.input.epoch;
    return command;
  }
  void Send(const InputCommand& command) {
    CHECK(service.PostCommand(command));
    Await([&] { return latest.lastCommandId == command.id; });
  }
  void Keys(unsigned pairs, unsigned firstSequence = 1) {
    CHECK(GetForegroundWindow() == window);
    for (unsigned n = 0; n < pairs; ++n) {
      INPUT pair[2]{};
      for (auto& input : pair) {
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = VK_F24;
        input.ki.dwExtraInfo = tag | (firstSequence + n);
      }
      pair[1].ki.dwFlags = KEYEVENTF_KEYUP;
      CHECK(SendInput(2, pair, sizeof(INPUT)) == 2);
    }
  }
  void Scroll(unsigned pulses) {
    CHECK(GetForegroundWindow() == window);
    std::array<INPUT, 4> input{};
    CHECK(pulses <= input.size());
    for (unsigned n = 0; n < pulses; ++n) {
      input[n].type = INPUT_MOUSE;
      input[n].mi.dwFlags = MOUSEEVENTF_WHEEL;
      input[n].mi.mouseData = WHEEL_DELTA;
      input[n].mi.dwExtraInfo = tag | (n + 1);
    }
    CHECK(SendInput(pulses, input.data(), sizeof(INPUT)) == pulses);
  }
  void Click() {
    CHECK(GetForegroundWindow() == window);
    INPUT pair[2]{};
    for (auto& input : pair) { input.type = INPUT_MOUSE; input.mi.dwExtraInfo = tag | 1; }
    pair[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    pair[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    CHECK(SendInput(2, pair, sizeof(INPUT)) == 2);
  }
  void Stop() {
    const auto& final = service.Stop();
    CHECK(final.stopped && !final.cleanupError && !service.running());
    CHECK(final.snapshot.input.fault == InputFault::None);
  }
};

LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lp);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  auto* fixture = reinterpret_cast<Fixture*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == wakeMessage && fixture) {
    fixture->service.ReadLatest(fixture->latest);
    return 0;
  }
  if (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_MOUSEWHEEL ||
      message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) return 0;
  return DefWindowProcW(window, message, wp, lp);
}

void LocalFallbackUsesOwnerAndCapturedDate() {
  Fixture fixture;
  fixture.Start(true);
  auto click = fixture.Command(InputCommandKind::LocalFallbackClick);
  click.capturedMs = GetTickCount64();
  click.capturedDate = 20261023;  // Delayed delivery must not reassign this date.
  fixture.Send(click);
  CHECK(fixture.latest.commandError == ERROR_SUCCESS && fixture.latest.input.total == 101);
  CHECK(!fixture.latest.observedGlobalCount && !fixture.latest.input.reminderSegmentConsumed);
  fixture.Keys(1);
  fixture.Await([&] { return fixture.latest.input.total == 102; });
  CHECK(fixture.latest.observedGlobalCount);
  auto stale = fixture.Command(InputCommandKind::LocalFallbackClick);
  stale.expectedEpoch = 9;
  stale.capturedMs = GetTickCount64();
  stale.capturedDate = 20261023;
  fixture.Send(stale);
  CHECK(fixture.latest.commandError == ERROR_REVISION_MISMATCH && fixture.latest.input.total == 102);
  fixture.Stop();
  const auto& final = fixture.service.Stop();
  bool found = false;
  for (const auto& entry : final.daily) if (entry.date == 20261023) {
    // If run on this exact date it also contains the initial 10 and tagged key.
    const bool current = InputService::CaptureLocalDate() == 20261023;
    CHECK(entry.total == (current ? 12u : 1u));
    found = true;
  }
  CHECK(found);
}

void InstalledMousePreventsDuplicateFallback() {
  Fixture fixture;
  fixture.Start();
  auto click = fixture.Command(InputCommandKind::LocalFallbackClick);
  click.capturedMs = GetTickCount64();
  click.capturedDate = InputService::CaptureLocalDate();
  fixture.Send(click);
  CHECK(fixture.latest.commandError == ERROR_SUCCESS && fixture.latest.input.total == 100);
  fixture.Click();
  fixture.Await([&] { return fixture.latest.input.total == 101; });
  CHECK(fixture.latest.observedGlobalCount);
  fixture.Stop();
}

void FixedSelfCheckAggregatesCapturedEvents() {
  Fixture fixture;
  fixture.Start();
  auto begin = fixture.Command(InputCommandKind::BeginSelfCheck);
  begin.capturedMs = GetTickCount64();
  begin.selfCheckGeneration = 41;
  fixture.Send(begin);
  CHECK(fixture.latest.selfCheck.generation == 41 && fixture.latest.selfCheck.active);
  CHECK(fixture.latest.selfCheck.startsMs == begin.capturedMs + 2000);
  CHECK(fixture.latest.selfCheck.endsMs == begin.capturedMs + 12000);
  fixture.Keys(1);
  fixture.Await([&] { return fixture.latest.input.total == 101; });
  CHECK(fixture.latest.selfCheck.keys == 0);
  fixture.Until(fixture.latest.selfCheck.startsMs + 100);
  fixture.Keys(3, 2);
  fixture.Click();
  fixture.Scroll(2);
  fixture.Await([&] { return fixture.latest.selfCheck.handled == 6; });
  fixture.Until(GetTickCount64() + 220);
  fixture.Scroll(1);
  fixture.Await([&] { return fixture.latest.selfCheck.handled == 7; });
  CHECK(fixture.latest.selfCheck.keys == 3 && fixture.latest.selfCheck.clicks == 1);
  CHECK(fixture.latest.selfCheck.scrolls == 3 && fixture.latest.selfCheck.expected == 6);
  CHECK(fixture.latest.selfCheck.counted == 6 && fixture.latest.input.total == 107);
  CHECK(fixture.latest.selfCheck.lastRelativeMs >= 100 && fixture.latest.selfCheck.lastRelativeMs < 10000);
  fixture.Await([&] { return !fixture.latest.selfCheck.active; }, 12000);
  CHECK(!fixture.latest.selfCheck.cancelled);
  fixture.Keys(1, 5);
  fixture.Await([&] { return fixture.latest.input.total == 108; });
  CHECK(fixture.latest.selfCheck.keys == 3 && fixture.latest.selfCheck.counted == 6);

  auto second = fixture.Command(InputCommandKind::BeginSelfCheck);
  second.capturedMs = GetTickCount64();
  second.selfCheckGeneration = 42;
  fixture.Send(second);
  auto restart = fixture.Command(InputCommandKind::RestartListeners);
  fixture.Send(restart);
  CHECK(fixture.latest.input.epoch == 2 && !fixture.latest.selfCheck.active);
  CHECK(fixture.latest.selfCheck.cancelled && !fixture.latest.observedGlobalCount);
  auto late = fixture.Command(InputCommandKind::BeginSelfCheck);
  late.capturedMs = GetTickCount64() - 3000;
  late.selfCheckGeneration = 43;
  fixture.Send(late);
  CHECK(fixture.latest.selfCheck.error == ERROR_TIMEOUT && fixture.latest.selfCheck.cancelled);
  fixture.Stop();
}

void ConfirmationSurvivesSnapshotCoalescing() {
  Fixture fixture;
  fixture.Start(false, true);
  CHECK(fixture.latest.pendingReminderId != 0 && fixture.latest.input.reminderSegmentConsumed);
  auto confirm = fixture.Command(InputCommandKind::ConfirmReminder);
  confirm.opportunityId = fixture.latest.pendingReminderId;
  // Queue later ordinary commands without consuming the confirmation's wake.
  CHECK(fixture.service.PostCommand(confirm));
  std::uint64_t finalCommand = confirm.id;
  for (unsigned i = 0; i < 16; ++i) {
    auto ordinary = fixture.Command(InputCommandKind::SetClockGuard);
    ordinary.enabled = false;
    CHECK(fixture.service.PostCommand(ordinary));
    finalCommand = ordinary.id;
  }
  fixture.Await([&] { return fixture.latest.lastCommandId == finalCommand; });
  const auto result = fixture.latest.reminderConfirmation;
  CHECK(result.confirmed && result.error == ERROR_SUCCESS && result.commandId == confirm.id);
  CHECK(result.epoch == confirm.expectedEpoch && result.opportunityId == confirm.opportunityId);
  CHECK(fixture.latest.pendingReminderId == 0);
  fixture.Send(confirm);  // Accepted duplicate cannot overwrite success with a false rejection.
  CHECK(fixture.latest.reminderConfirmation.confirmed);
  auto restart = fixture.Command(InputCommandKind::RestartListeners);
  fixture.Send(restart);
  CHECK(fixture.latest.input.epoch != result.epoch);
  CHECK(fixture.latest.reminderConfirmation.commandId == confirm.id);
  auto stale = fixture.Command(InputCommandKind::ConfirmReminder);
  stale.expectedEpoch = result.epoch;
  stale.opportunityId = result.opportunityId;
  fixture.Send(stale);
  CHECK(!fixture.latest.reminderConfirmation.confirmed);
  CHECK(fixture.latest.reminderConfirmation.error == ERROR_REVISION_MISMATCH);
  auto ordinary = fixture.Command(InputCommandKind::ResetReminderObservation);
  fixture.Send(ordinary);
  CHECK(fixture.latest.reminderConfirmation.commandId == stale.id);
  CHECK(!fixture.latest.reminderConfirmation.confirmed);
  fixture.Stop();
}

void CancelledOpportunityCannotConfirm() {
  Fixture fixture;
  fixture.Start(false, true);
  const auto opportunity = fixture.latest.pendingReminderId;
  auto pause = fixture.Command(InputCommandKind::BeginSuspend);
  fixture.Send(pause);
  auto confirm = fixture.Command(InputCommandKind::ConfirmReminder);
  confirm.opportunityId = opportunity;
  fixture.Send(confirm);
  CHECK(!fixture.latest.reminderConfirmation.confirmed && fixture.latest.pendingReminderId == 0);
  CHECK(fixture.latest.input.reminderSegmentConsumed);  // No reservation replay/unconsume.
  fixture.Stop();
}
}  // namespace

int main() {
  WNDCLASSW windowClass{};
  windowClass.lpfnWndProc = Procedure;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  windowClass.lpszClassName = className;
  if (!RegisterClassW(&windowClass)) return 2;
  struct Test { const char* name; void (*run)(); };
  const Test tests[] = {
    {"local_fallback_owner_date", LocalFallbackUsesOwnerAndCapturedDate},
    {"no_duplicate_mouse_fallback", InstalledMousePreventsDuplicateFallback},
    {"fixed_self_check_window", FixedSelfCheckAggregatesCapturedEvents},
    {"retained_reminder_confirmation", ConfirmationSurvivesSnapshotCoalescing},
    {"cancelled_reminder_confirmation", CancelledOpportunityCannotConfirm},
  };
  unsigned passed = 0;
  for (const auto& test : tests) {
    try { test.run(); ++passed; std::cout << "PASS " << test.name << '\n'; }
    catch (const std::exception& error) {
      std::cerr << "FAIL " << test.name << ": " << error.what() << '\n';
      return 1;
    }
  }
  std::cout << passed << "/5 passed; isolated tagged input, no product persistence tested\n";
  return 0;
}
