#include "input_service.h"
#include "../../client/core/latest_snapshot.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <limits>
#include <thread>

namespace niuma::windows::runtime {
using client::core::InputCore;
using client::core::InputEvent;
using client::core::InputKind;
using client::core::ObserveResult;
using Trigger = niuma::reminder::ActivitySampler::Trigger;

struct InputService::Impl {
  explicit Impl(std::size_t capacity) : core(capacity), ledger(capacity) {}

  static thread_local Impl* owner;
  static constexpr std::size_t kCommandCapacity = 32;
  static constexpr ULONGLONG kViewIntervalMs = 16;

  InputCore core;
  client::core::LedgerSnapshotChannel ledger;
  InputServiceOptions options;
  client::core::LatestSnapshot<InputServiceSnapshot> snapshots;
  client::core::LatestSnapshotWake wake;
  InputServiceSnapshot view;
  InputServiceStop final;
  std::thread worker;
  HANDLE readyEvent = nullptr;
  HANDLE stopEvent = nullptr;
  HANDLE commandEvent = nullptr;
  HHOOK keyboard = nullptr;
  HHOOK mouse = nullptr;
  std::atomic<bool> live{false};
  std::atomic<bool> startupPublished{false};
  std::atomic<DWORD> startupKeyboardError{0};
  std::atomic<DWORD> startupMouseError{0};
  std::array<InputCommand, kCommandCapacity> commands{};
  std::atomic<std::uint64_t> commandWrite{0};
  std::atomic<std::uint64_t> commandRead{0};
  bool started = false;
  bool accepting = false;  // Input-owner only; callbacks forward during teardown.
  bool shutdownRequested = false;
  bool clockGuard = false;
  bool notifyDirty = false;
  bool viewDirty = false;  // Single input owner; flushed outside hook callbacks.
  ULONGLONG nextNotify = 0;
  ULONGLONG nextReminder = 0;
  std::uint64_t nextOpportunityId = 0;

  void CloseEvents() noexcept {
    if (readyEvent) CloseHandle(readyEvent);
    if (stopEvent) CloseHandle(stopEvent);
    if (commandEvent) CloseHandle(commandEvent);
    readyEvent = stopEvent = commandEvent = nullptr;
  }

  void TryNotify(ULONGLONG now) noexcept {
    if (!notifyDirty || now < nextNotify || !options.notificationWindow) return;
    if (wake.RequestWake()) {
      if (!PostMessageW(options.notificationWindow, options.notificationMessage, 0, 0)) {
        view.notificationError = GetLastError();
        wake.PostFailed();
        nextNotify = now + 250;  // A failed recipient must not create a tight retry loop.
        snapshots.Publish(view);
        return;
      }
    }
    notifyDirty = false;
    nextNotify = now + kViewIntervalMs;
  }

  void Publish(ULONGLONG now) noexcept {
    viewDirty = false;
    view.input = core.snapshot();
    snapshots.Publish(view);
    notifyDirty = true;
    TryNotify(now);
  }

  void ClearOpportunity() noexcept {
    view.pendingReminder = Trigger::None;
    view.pendingReminderId = 0;
    view.pendingReminderEpoch = 0;
  }

  bool Uninstall() noexcept {
    accepting = false;
    if (keyboard) {
      if (UnhookWindowsHookEx(keyboard)) keyboard = nullptr;
      else if (!final.cleanupError) {
        const auto error = GetLastError();
        final.cleanupError = error ? error : ERROR_INVALID_HOOK_HANDLE;
      }
    }
    if (mouse) {
      if (UnhookWindowsHookEx(mouse)) mouse = nullptr;
      else if (!final.cleanupError) {
        const auto error = GetLastError();
        final.cleanupError = error ? error : ERROR_INVALID_HOOK_HANDLE;
      }
    }
    core.SetListenerHealth(false, false);
    return keyboard == nullptr && mouse == nullptr;
  }

  void Install() noexcept {
    // Never install a second generation while removal of the first is unsure.
    if (keyboard || mouse) return;
    const HINSTANCE module = GetModuleHandleW(nullptr);
    keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Keyboard, module, 0);
    view.keyboardError = keyboard ? ERROR_SUCCESS : GetLastError();
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
    if (options.diagnostic.forceMouseUnavailable) {
      mouse = nullptr;
      view.mouseError = ERROR_ACCESS_DENIED;
    } else
#endif
    {
      mouse = SetWindowsHookExW(WH_MOUSE_LL, Mouse, module, 0);
      view.mouseError = mouse ? ERROR_SUCCESS : GetLastError();
    }
    core.SetListenerHealth(keyboard != nullptr, mouse != nullptr);
    accepting = keyboard != nullptr || mouse != nullptr;
  }

  ObserveResult Observe(InputKind kind, bool injected, ULONGLONG now,
                        client::core::LocalDate date, bool global = true) noexcept {
    auto& check = view.selfCheck;
    const bool observing = global && kind != InputKind::KeyUp && check.active &&
        now >= check.startsMs && now < check.endsMs;
    const bool expected = kind != InputKind::Scroll || core.StartsScrollGesture(now);
    // Finish an elapsed action before considering this input; no historical
    // frame or UI message needs to be replayed for the core to make progress.
    core.AdvanceAnimation(now);
    const auto result = core.Observe(InputEvent{kind, injected, now, date});
    if (global && result == ObserveResult::Counted) view.observedGlobalCount = true;
    if (observing) {
      if (kind == InputKind::KeyDown) ++check.keys;
      else if (kind == InputKind::Click) ++check.clicks;
      else ++check.scrolls;
      ++check.handled;
      if (expected) ++check.expected;
      if (result == ObserveResult::Counted) ++check.counted;
      check.lastRelativeMs = now - check.startsMs;
    }
    // Return to Windows before snapshot exchange or UI wake/message work.
    // Counts and reminder state remain authoritative on this same owner; the
    // message loop publishes only the latest cumulative state after its drain.
    viewDirty = true;
    return result;
  }

  static LRESULT CALLBACK Keyboard(int code, WPARAM message, LPARAM data) noexcept {
    Impl* self = owner;
    if (self && self->accepting && code == HC_ACTION && data &&
        (message == WM_KEYDOWN || message == WM_SYSKEYDOWN ||
         message == WM_KEYUP || message == WM_SYSKEYUP)) {
      const auto* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
      const auto& diagnostic = self->options.diagnostic;
      const unsigned sequence = static_cast<unsigned>(event->dwExtraInfo & 0xffff);
      if (diagnostic.tagMask && (event->vkCode != VK_F24 ||
          (event->dwExtraInfo & diagnostic.tagMask) != diagnostic.tagValue ||
          sequence == 0 || sequence > diagnostic.maximumSequence))
        return CallNextHookEx(nullptr, code, message, data);
      LARGE_INTEGER entered{};
      QueryPerformanceCounter(&entered);
#endif
      const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      const bool injected = (event->flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED)) != 0;
      const auto now = GetTickCount64();
      const auto result = self->Observe(down ? InputKind::KeyDown : InputKind::KeyUp, injected, now,
                                       InputService::CaptureLocalDate());
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
      if (down && result == ObserveResult::Counted && diagnostic.onCountedKey) {
        LARGE_INTEGER counted{};
        QueryPerformanceCounter(&counted);
        diagnostic.onCountedKey(diagnostic.context, sequence - 1,
                                entered.QuadPart, counted.QuadPart);
      }
#else
      (void)result;
#endif
    }
    return CallNextHookEx(nullptr, code, message, data);
  }

  static LRESULT CALLBACK Mouse(int code, WPARAM message, LPARAM data) noexcept {
    Impl* self = owner;
    if (self && self->accepting && code == HC_ACTION && data) {
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
      const auto& diagnostic = self->options.diagnostic;
      if (diagnostic.tagMask) {
        const auto* tagged = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
        const unsigned sequence = static_cast<unsigned>(tagged->dwExtraInfo & 0xffff);
        if (!diagnostic.allowTaggedMouse ||
            (tagged->dwExtraInfo & diagnostic.tagMask) != diagnostic.tagValue ||
            sequence == 0 || sequence > diagnostic.maximumSequence)
          return CallNextHookEx(nullptr, code, message, data);
      }
#endif
      InputKind kind;
      switch (message) {
        case WM_LBUTTONDOWN:
        case WM_RBUTTONDOWN:
        case WM_MBUTTONDOWN:
        case WM_XBUTTONDOWN: kind = InputKind::Click; break;
        case WM_MOUSEWHEEL:
        case WM_MOUSEHWHEEL: kind = InputKind::Scroll; break;
        default: return CallNextHookEx(nullptr, code, message, data);
      }
      const auto* event = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
      const bool injected = (event->flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0;
      self->Observe(kind, injected, GetTickCount64(), InputService::CaptureLocalDate());
    }
    return CallNextHookEx(nullptr, code, message, data);
  }

  void Apply(const InputCommand& command, ULONGLONG now) noexcept {
    view.lastCommandId = command.id;
    view.commandError = ERROR_SUCCESS;
    if (command.kind == InputCommandKind::ConfirmReminder) {
      auto& result = view.reminderConfirmation;
      if (!command.id) {
        view.commandError = ERROR_INVALID_PARAMETER;
        Publish(now);
        return;
      }
      // Repeated or late commands cannot replace a newer retained result.
      if (command.id && command.id <= result.commandId) {
        if (command.id != result.commandId || command.expectedEpoch != result.epoch ||
            command.opportunityId != result.opportunityId)
          view.commandError = ERROR_REVISION_MISMATCH;
        else
          view.commandError = result.error;
        Publish(now);
        return;
      }
      result = {};
      result.commandId = command.id;
      result.epoch = command.expectedEpoch;
      result.opportunityId = command.opportunityId;
      const bool matches = command.id && command.expectedEpoch && command.opportunityId &&
          command.expectedEpoch == core.snapshot().epoch &&
          command.expectedEpoch == view.pendingReminderEpoch &&
          command.opportunityId == view.pendingReminderId &&
          view.pendingReminder != Trigger::None;
      const bool available = keyboard && mouse && !clockGuard &&
          !core.snapshot().reminderSuspended && core.snapshot().reminderSegmentConsumed;
      result.confirmed = matches && available;
      result.error = result.confirmed ? ERROR_SUCCESS : ERROR_REVISION_MISMATCH;
      view.commandError = result.error;
      if (result.confirmed) ClearOpportunity();
      Publish(now);
      return;
    }
    if (command.expectedEpoch && command.expectedEpoch != core.snapshot().epoch) {
      view.commandError = ERROR_REVISION_MISMATCH;
      if (command.kind == InputCommandKind::BeginSelfCheck) {
        view.selfCheck = {};
        view.selfCheck.generation = command.selfCheckGeneration;
        view.selfCheck.epoch = command.expectedEpoch;
        view.selfCheck.cancelled = true;
        view.selfCheck.error = view.commandError;
      }
      Publish(now);
      return;
    }
    switch (command.kind) {
      case InputCommandKind::RestartListeners:
        ClearOpportunity();
        view.observedGlobalCount = false;
        view.selfCheck.active = false;
        view.selfCheck.cancelled = view.selfCheck.generation != 0;
        if (!Uninstall()) {
          view.commandError = final.cleanupError;
          // The owning thread exits, letting Windows finish removing any
          // uncertain hook. Do not turn cleanup failure into duplicate hooks.
          shutdownRequested = true;
          SetEvent(stopEvent);
          break;
        }
        core.RestartListeners();
        Install();
        break;
      case InputCommandKind::ResetReminderObservation:
        core.ResetReminderObservation();
        ClearOpportunity();
        break;
      case InputCommandKind::BeginSuspend:
        core.BeginSuspend(now);
        ClearOpportunity();
        break;
      case InputCommandKind::ResumeFromSuspend:
        core.ResumeFromSuspend(now, command.pairedSignal, command.durationTrusted,
                               command.inactiveDurationMs);
        ClearOpportunity();
        break;
      case InputCommandKind::SetClockGuard:
        clockGuard = command.enabled;
        if (clockGuard) {
          core.ResetReminderObservation();
          ClearOpportunity();
        }
        break;
      case InputCommandKind::RestoreReminderSegmentConsumed:
        if (!command.expectedEpoch)
          view.commandError = ERROR_REVISION_MISMATCH;
        else {
          core.RestoreReminderSegmentConsumed(command.enabled);
          if (!command.enabled) ClearOpportunity();
        }
        break;
      case InputCommandKind::ClearReminderOpportunity:
        if (!command.expectedEpoch || command.opportunityId != view.pendingReminderId)
          view.commandError = ERROR_REVISION_MISMATCH;
        else
          ClearOpportunity();
        break;
      case InputCommandKind::LocalFallbackClick:
        if (!command.expectedEpoch || command.capturedMs > now ||
            !InputCore::ValidDate(command.capturedDate))
          view.commandError = ERROR_INVALID_PARAMETER;
        else if (!mouse) {
          // The UI captured the accounting date. Animation uses dispatch time
          // so an asynchronously delivered click cannot regress the hook clock.
          // injected=true excludes this local fallback from reminder activity.
          Observe(InputKind::Click, true, now, command.capturedDate, false);
        }
        break;
      case InputCommandKind::BeginSelfCheck: {
        auto& check = view.selfCheck;
        check = {};
        check.generation = command.selfCheckGeneration;
        check.epoch = command.expectedEpoch;
        if (!command.expectedEpoch || !command.selfCheckGeneration || command.capturedMs > now ||
            command.capturedMs > std::numeric_limits<ULONGLONG>::max() - 12000) {
          check.error = ERROR_INVALID_PARAMETER;
        } else {
          check.startsMs = command.capturedMs + 2000;
          check.endsMs = check.startsMs + 10000;
          check.error = now >= check.startsMs ? ERROR_TIMEOUT : ERROR_SUCCESS;
        }
        check.active = check.error == ERROR_SUCCESS;
        check.cancelled = !check.active;
        view.commandError = check.error;
        break;
      }
      default: view.commandError = ERROR_INVALID_PARAMETER; break;
    }
    Publish(now);
  }

  void Deferred(ULONGLONG now) noexcept {
    // Commands and periodic evaluation run outside hook callbacks. Bound each
    // drain so UI command traffic cannot starve the Windows input message pump.
    for (std::size_t count = 0; count < kCommandCapacity; ++count) {
      const auto read = commandRead.load(std::memory_order_relaxed);
      if (read == commandWrite.load(std::memory_order_acquire)) break;
      const InputCommand command = commands[read % kCommandCapacity];
      commandRead.store(read + 1, std::memory_order_release);
      Apply(command, GetTickCount64());
      if (shutdownRequested) return;
    }
    now = GetTickCount64();
    if (view.selfCheck.active && now >= view.selfCheck.endsMs) {
      view.selfCheck.active = false;
      Publish(now);
    }
    const auto oldVersion = core.snapshot().version;
    core.AdvanceAnimation(now);
    if (now >= nextReminder) {
      core.UpdateDate(InputService::CaptureLocalDate());
      const bool wasConsumed = core.snapshot().reminderSegmentConsumed;
      const auto trigger = core.EvaluateReminder(now, keyboard && mouse && !clockGuard);
      if (wasConsumed && !core.snapshot().reminderSegmentConsumed) ClearOpportunity();
      if (trigger != Trigger::None) {
        if (nextOpportunityId != std::numeric_limits<std::uint64_t>::max()) ++nextOpportunityId;
        view.pendingReminder = trigger;
        view.pendingReminderId = nextOpportunityId;
        view.pendingReminderEpoch = core.snapshot().epoch;
      }
      nextReminder = now + 1000;
    }
    if (viewDirty || oldVersion != core.snapshot().version) Publish(now);
    // A requested ledger copy is bounded by constructor capacity and happens
    // outside callbacks. Ready belongs to the slow consumer until it releases.
    if (ledger.ProduceIfRequested(core)) Publish(now);
    TryNotify(now);
  }

  DWORD WaitDuration(ULONGLONG now) const noexcept {
    ULONGLONG due = nextReminder;
    const auto& state = core.snapshot();
    if (state.striking)
      due = std::min(due, state.strikeStartedMs + static_cast<ULONGLONG>(state.strikeDurationMs));
    if (view.selfCheck.active) due = std::min(due, view.selfCheck.endsMs);
    if (notifyDirty && options.notificationWindow) due = std::min(due, nextNotify);
    return due <= now ? 0 : static_cast<DWORD>(std::min<ULONGLONG>(due - now, 1000));
  }

  void Run() noexcept {
    owner = this;
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    Install();
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
    // Isolated contract-test admission only; production builds cannot seed an
    // opportunity or bypass the activity sampler and durable UI reservation.
    if (options.diagnostic.seedReminderOpportunity) {
      core.RestoreReminderSegmentConsumed(true);
      view.pendingReminder = Trigger::LongBusy;
      view.pendingReminderId = ++nextOpportunityId;
      view.pendingReminderEpoch = core.snapshot().epoch;
    }
#endif
    live.store(true, std::memory_order_release);
    view.running = true;
    const auto now = GetTickCount64();
    nextReminder = now + 1000;
    Publish(now);
    startupKeyboardError.store(view.keyboardError, std::memory_order_relaxed);
    startupMouseError.store(view.mouseError, std::memory_order_relaxed);
    startupPublished.store(true, std::memory_order_release);
    SetEvent(readyEvent);

    const HANDLE waits[] = {stopEvent, commandEvent};
    bool stopping = false;
    while (!stopping && !shutdownRequested) {
      const DWORD result = MsgWaitForMultipleObjectsEx(2, waits,
          WaitDuration(GetTickCount64()), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
      if (result == WAIT_OBJECT_0) break;
      if (result == WAIT_FAILED) {
        final.cleanupError = GetLastError();
        break;
      }
      for (unsigned count = 0; count < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++count) {
        if (message.message == WM_QUIT) {
          stopping = true;
          break;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
      if (WaitForSingleObject(stopEvent, 0) == WAIT_OBJECT_0) break;
      Deferred(GetTickCount64());
    }
    Uninstall();
    ledger.Close(core.snapshot());
    if (view.selfCheck.active) {
      view.selfCheck.active = false;
      view.selfCheck.cancelled = GetTickCount64() < view.selfCheck.endsMs;
    }
    view.running = false;
    ClearOpportunity();
    // No loop remains to retry a throttled terminal notification. Preserve the
    // one-pending-wake protocol but attempt this final publication immediately.
    nextNotify = 0;
    Publish(GetTickCount64());
    final.snapshot = view;
    const auto count = core.CopyDailyTotals(final.daily.data(), final.daily.size());
    final.daily.resize(count);  // Preallocated before installing hooks.
    final.stopped = true;
    live.store(false, std::memory_order_release);
    owner = nullptr;
  }
};

thread_local InputService::Impl* InputService::Impl::owner = nullptr;

InputService::InputService(std::size_t dayCapacity) : impl_(std::make_unique<Impl>(dayCapacity)) {}
InputService::~InputService() { Stop(); }

client::core::LocalDate InputService::CaptureLocalDate() noexcept {
  SYSTEMTIME now{};
  GetLocalTime(&now);
  return static_cast<client::core::LocalDate>(now.wYear) * 10000 +
      static_cast<client::core::LocalDate>(now.wMonth) * 100 + now.wDay;
}

InputServiceStart InputService::Start(const InputServiceOptions& options) {
  InputServiceStart result;
  auto& self = *impl_;
  if (self.started) {
    result.error = ERROR_ALREADY_INITIALIZED;
    return result;
  }
  if (options.notificationWindow && (options.notificationMessage < WM_APP ||
      options.notificationMessage > 0xbfff || !IsWindow(options.notificationWindow))) {
    result.error = ERROR_INVALID_PARAMETER;
    return result;
  }
  try {
    self.options = options;
    self.final.daily.resize(self.core.daily_capacity());
  } catch (...) {
    result.error = ERROR_NOT_ENOUGH_MEMORY;
    return result;
  }
  if (!self.core.Initialize(options.total, options.date, options.daily.data(),
                           options.daily.size(), options.reminderSegmentConsumed)) {
    result.error = ERROR_INVALID_DATA;
    return result;
  }
  self.readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  self.stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  self.commandEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!self.readyEvent || !self.stopEvent || !self.commandEvent) {
    result.error = GetLastError();
    self.CloseEvents();
    return result;
  }
  try {
    self.worker = std::thread([&self] { self.Run(); });
    self.started = true;
  } catch (...) {
    result.error = ERROR_NOT_ENOUGH_MEMORY;
    self.CloseEvents();
    return result;
  }
  const DWORD ready = WaitForSingleObject(self.readyEvent, 5000);
  if (ready != WAIT_OBJECT_0 || !self.startupPublished.load(std::memory_order_acquire)) {
    result.error = ready == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
    Stop();
    return result;
  }
  result.started = true;
  result.keyboardError = self.startupKeyboardError.load(std::memory_order_relaxed);
  result.mouseError = self.startupMouseError.load(std::memory_order_relaxed);
  return result;
}

bool InputService::PostCommand(const InputCommand& command) noexcept {
  auto& self = *impl_;
  if (!self.live.load(std::memory_order_acquire)) {
    SetLastError(ERROR_INVALID_STATE);
    return false;
  }
  const auto write = self.commandWrite.load(std::memory_order_relaxed);
  if (write - self.commandRead.load(std::memory_order_acquire) >= Impl::kCommandCapacity) {
    SetLastError(ERROR_NOT_ENOUGH_QUOTA);
    return false;
  }
  self.commands[write % Impl::kCommandCapacity] = command;
  self.commandWrite.store(write + 1, std::memory_order_release);
  // A committed command remains queued if signaling unexpectedly fails. The
  // owner drains at its next periodic wake; do not ask callers to replay it.
  SetEvent(self.commandEvent);
  return true;
}

bool InputService::ReadLatest(InputServiceSnapshot& snapshot) noexcept {
  impl_->wake.BeginConsume();
  return impl_->snapshots.Read(snapshot);
}

client::core::LedgerRequestResult InputService::RequestLedger(
    client::core::LedgerRequest request) noexcept {
  auto& self = *impl_;
  if (!self.live.load(std::memory_order_acquire)) return client::core::LedgerRequestResult::Stopped;
  const auto result = self.ledger.Request(request);
  if (result == client::core::LedgerRequestResult::Accepted) SetEvent(self.commandEvent);
  return result;
}

bool InputService::TryConsumeLedger(client::core::LedgerSnapshotResult& result) {
  return impl_->ledger.TryConsume(result);
}

const InputServiceStop& InputService::Stop() noexcept {
  auto& self = *impl_;
  if (self.worker.joinable()) {
    SetEvent(self.stopEvent);
    self.worker.join();
  }
  self.CloseEvents();
  return self.final;
}

bool InputService::running() const noexcept { return impl_->live.load(std::memory_order_acquire); }

}  // namespace niuma::windows::runtime
