#pragma once

#include "../../reminder_activity.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace niuma::client::core {

using LocalDate = std::uint32_t;  // YYYYMMDD, supplied at capture by the platform.

enum class InputKind : std::uint8_t { KeyDown, KeyUp, Click, Scroll };

struct InputEvent {
  InputKind kind = InputKind::KeyDown;
  bool injected = false;
  std::uint64_t monotonicMs = 0;
  LocalDate date = 0;
};

struct DailyTotal {
  LocalDate date = 0;
  std::uint64_t total = 0;
};

enum class InputFault : std::uint8_t {
  None,
  NotInitialized,
  InvalidInitialState,
  InvalidDate,
  MonotonicRegression,
  DayCapacity,
  CounterExhausted,
};

enum class ObserveResult : std::uint8_t { Ignored, Counted, AccountingUnavailable };

// Fixed-size view only. Daily persistence uses CopyDailyTotals on the owner
// outside callbacks; a latest-view snapshot is not a replacement for a ledger.
struct InputSnapshot {
  std::uint64_t version = 0;
  std::uint64_t epoch = 0;
  std::uint64_t total = 0;
  std::uint64_t today = 0;
  std::uint64_t lastInputMs = 0;
  std::uint64_t lastScrollMs = 0;
  std::uint64_t actionSerial = 0;
  std::uint64_t strikeStartedMs = 0;
  std::uint64_t observedEvents = 0;
  std::uint64_t countedOperations = 0;
  std::uint64_t unaccountedOperations = 0;
  LocalDate date = 0;
  int strikeDurationMs = 220;
  int suggestedDurationMs = 220;
  double intervalEmaMs = 220.0;
  InputFault fault = InputFault::NotInitialized;
  bool ready = false;
  bool striking = false;
  bool keyboardAvailable = false;
  bool mouseAvailable = false;
  bool reminderSegmentConsumed = false;
  bool reminderSuspended = false;
};

// Single-owner core. Initialize and CopyDailyTotals run outside input callbacks.
// Observe allocates nothing, never calls a platform API, and never waits.
// Dates use a preallocated index with bounded probes. Capacity failure latches
// an explicit accounting fault, preserves the ledger, and reports unaccounted
// operations. The platform must surface it; it must not claim healthy counting.
// There is no promise to store infinitely many dates after prolonged failures.
class InputCore {
 public:
  static constexpr std::size_t kDefaultDayCapacity = 4096;
  static constexpr std::size_t kMaximumDayCapacity = 65536;
  static constexpr std::uint64_t kScrollGestureGapMs = 180;
  static constexpr std::uint64_t kTempoResetGapMs = 600;
  static constexpr int kDefaultStrikeMs = 220;
  static constexpr int kMinStrikeMs = 120;
  static constexpr int kMaxStrikeMs = 240;
  static constexpr double kTempoFactor = 1.05;

  explicit InputCore(std::size_t dayCapacity = kDefaultDayCapacity);
  InputCore(const InputCore&) = delete;
  InputCore& operator=(const InputCore&) = delete;

  bool Initialize(std::uint64_t total, LocalDate currentDate,
                  const DailyTotal* daily, std::size_t dailyCount,
                  bool reminderSegmentConsumed = false) noexcept;
  ObserveResult Observe(const InputEvent& event) noexcept;
  bool UpdateDate(LocalDate date) noexcept;
  void AdvanceAnimation(std::uint64_t monotonicMs) noexcept;
  void RestartListeners() noexcept;
  void SetListenerHealth(bool keyboard, bool mouse) noexcept;

  niuma::reminder::ActivitySampler::Trigger EvaluateReminder(
      std::uint64_t monotonicMs, bool listenerHealthy = true) noexcept;
  void ResetReminderObservation() noexcept;
  void BeginSuspend(std::uint64_t monotonicMs) noexcept;
  bool ResumeFromSuspend(std::uint64_t monotonicMs, bool pairedSignal,
                         bool durationTrusted,
                         std::uint64_t inactiveDurationMs) noexcept;
  void RestoreReminderSegmentConsumed(bool consumed) noexcept;

  const InputSnapshot& snapshot() const noexcept { return view_; }
  std::size_t daily_size() const noexcept { return dayCount_; }
  std::size_t daily_capacity() const noexcept { return dayCapacity_; }
  bool GetDailyTotal(LocalDate date, std::uint64_t& value) const noexcept;
  // Returns required size. If capacity is insufficient, writes nothing.
  // Output order is unspecified. Only call on the owner, outside callbacks.
  std::size_t CopyDailyTotals(DailyTotal* output, std::size_t capacity) const noexcept;
  static bool ValidDate(LocalDate date) noexcept;

 private:
  static constexpr std::size_t kMaximumProbes = 64;
  static constexpr std::size_t kMissing = static_cast<std::size_t>(-1);
  std::size_t FindDate(LocalDate date) const noexcept;
  std::size_t EnsureDate(LocalDate date) noexcept;
  bool CheckTime(std::uint64_t monotonicMs) noexcept;
  void Fail(InputFault fault) noexcept;
  void Changed() noexcept;
  void RefreshReminderView() noexcept;
  ObserveResult Count(std::uint64_t monotonicMs, LocalDate date) noexcept;

  std::size_t dayCapacity_;
  std::vector<DailyTotal> days_;
  std::size_t dayCount_ = 0;
  std::size_t currentDaySlot_ = kMissing;
  InputSnapshot view_{};
  niuma::reminder::ActivitySampler reminder_;
  std::uint64_t lastObservedMs_ = 0;
  bool hasObservedTime_ = false;
  bool hasCountTime_ = false;
  bool hasScrollTime_ = false;
};

}  // namespace niuma::client::core
