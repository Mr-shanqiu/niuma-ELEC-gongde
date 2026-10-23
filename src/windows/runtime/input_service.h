#pragma once

#include "../../client/core/input_state.h"
#include "../../client/core/ledger_snapshot.h"

#include <windows.h>

#include <cstdint>
#include <memory>
#include <vector>

namespace niuma::windows::runtime {

#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
// This admission filter and tagged timing observer exist only in the isolated
// probe target. They never observe untagged input or store actual key contents.
struct InputDiagnosticOptions {
  ULONG_PTR tagMask = 0;
  ULONG_PTR tagValue = 0;
  unsigned maximumSequence = 0;
  void* context = nullptr;
  void (*onCountedKey)(void*, unsigned, LONGLONG, LONGLONG) noexcept = nullptr;
};
#endif

struct InputServiceOptions {
  std::uint64_t total = 0;
  client::core::LocalDate date = 0;
  std::vector<client::core::DailyTotal> daily;
  bool reminderSegmentConsumed = false;
  HWND notificationWindow = nullptr;
  UINT notificationMessage = WM_APP + 70;
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
  InputDiagnosticOptions diagnostic;
#endif
};

struct InputServiceStart {
  bool started = false;
  DWORD error = ERROR_SUCCESS;
  DWORD keyboardError = ERROR_SUCCESS;
  DWORD mouseError = ERROR_SUCCESS;
};

enum class InputCommandKind : std::uint8_t {
  RestartListeners,
  ResetReminderObservation,
  BeginSuspend,
  ResumeFromSuspend,
  SetClockGuard,
  RestoreReminderSegmentConsumed,
  ClearReminderOpportunity,
};

// One UI/control producer. A full bounded mailbox returns false; the caller
// must report/retry the command, not assume that a setting was applied.
struct InputCommand {
  InputCommandKind kind = InputCommandKind::ResetReminderObservation;
  std::uint64_t id = 0;
  std::uint64_t expectedEpoch = 0;  // 0 for lifecycle commands; otherwise checked.
  std::uint64_t opportunityId = 0;
  std::uint64_t inactiveDurationMs = 0;
  bool enabled = false;
  bool pairedSignal = false;
  bool durationTrusted = false;
};

struct InputServiceSnapshot {
  client::core::InputSnapshot input;
  std::uint64_t lastCommandId = 0;
  std::uint64_t pendingReminderId = 0;
  std::uint64_t pendingReminderEpoch = 0;
  niuma::reminder::ActivitySampler::Trigger pendingReminder =
      niuma::reminder::ActivitySampler::Trigger::None;
  DWORD keyboardError = ERROR_SUCCESS;
  DWORD mouseError = ERROR_SUCCESS;
  DWORD notificationError = ERROR_SUCCESS;
  DWORD commandError = ERROR_SUCCESS;
  bool running = false;
};

struct InputServiceStop {
  bool stopped = false;
  DWORD cleanupError = ERROR_SUCCESS;
  InputServiceSnapshot snapshot;
  std::vector<client::core::DailyTotal> daily;
};

// One start per instance; restart hooks through the command mailbox. Start,
// commands, ReadLatest, ledger requests/consumption and Stop belong to one UI
// owner. The notification HWND
// must remain alive until Stop has joined the input thread. No input callback
// waits for this owner, reads/writes files, or calls a window synchronously.
class InputService {
 public:
  explicit InputService(std::size_t dayCapacity = client::core::InputCore::kDefaultDayCapacity);
  ~InputService();
  InputService(const InputService&) = delete;
  InputService& operator=(const InputService&) = delete;

  InputServiceStart Start(const InputServiceOptions& options);
  bool PostCommand(const InputCommand& command) noexcept;
  bool ReadLatest(InputServiceSnapshot& snapshot) noexcept;
  // A full, versioned daily ledger, separate from the latest UI view. Only one
  // request/result may be outstanding; consume before requesting another.
  // EpochMismatch requires a new request using the newly observed epoch.
  // Test for a result on every notification, even if input.version is unchanged.
  // A failed result allocation leaves Ready intact for the same consumer retry.
  client::core::LedgerRequestResult RequestLedger(client::core::LedgerRequest request) noexcept;
  bool TryConsumeLedger(client::core::LedgerSnapshotResult& result);
  const InputServiceStop& Stop() noexcept;
  bool running() const noexcept;
  static client::core::LocalDate CaptureLocalDate() noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// A pendingReminder is only a reservation request. This P1 service neither
// commits reminder storage nor authorizes a popup. The later UI/storage adapter
// must preserve reserve/consume semantics, validate epoch/id on the async
// confirmation, and only then show a reminder. No product persistence is used
// by this service or its probe.

}  // namespace niuma::windows::runtime
