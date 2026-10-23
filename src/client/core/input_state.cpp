#include "input_state.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace niuma::client::core {
namespace {

std::size_t TableSize(std::size_t capacity) {
  if (capacity == 0 || capacity > InputCore::kMaximumDayCapacity)
    throw std::invalid_argument("InputCore day capacity is outside its supported range");
  std::size_t result = 2;
  while (result < capacity * 2) result *= 2;
  return result;
}

std::size_t DateHash(LocalDate date) noexcept {
  std::uint32_t value = date;
  value ^= value >> 16;
  value *= 0x7feb352dU;
  value ^= value >> 15;
  value *= 0x846ca68bU;
  value ^= value >> 16;
  return value;
}

void Increment(std::uint64_t& value) noexcept {
  if (value != std::numeric_limits<std::uint64_t>::max()) ++value;
}

}  // namespace

InputCore::InputCore(std::size_t dayCapacity)
    : dayCapacity_(dayCapacity), days_(TableSize(dayCapacity)) {}

bool InputCore::ValidDate(LocalDate date) noexcept {
  const unsigned year = date / 10000;
  const unsigned month = (date / 100) % 100;
  const unsigned day = date % 100;
  if (year == 0 || year > 9999 || month == 0 || month > 12 || day == 0) return false;
  constexpr unsigned lengths[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  unsigned length = lengths[month - 1];
  if (month == 2 && (year % 400 == 0 || (year % 4 == 0 && year % 100 != 0))) ++length;
  return day <= length;
}

std::size_t InputCore::FindDate(LocalDate date) const noexcept {
  const std::size_t start = DateHash(date);
  const std::size_t mask = days_.size() - 1;
  for (std::size_t probe = 0; probe < std::min(kMaximumProbes, days_.size()); ++probe) {
    const std::size_t index = (start + probe) & mask;
    if (days_[index].date == date) return index;
    if (days_[index].date == 0) return kMissing;
  }
  return kMissing;
}

std::size_t InputCore::EnsureDate(LocalDate date) noexcept {
  if (currentDaySlot_ != kMissing && days_[currentDaySlot_].date == date)
    return currentDaySlot_;
  const std::size_t start = DateHash(date);
  const std::size_t mask = days_.size() - 1;
  for (std::size_t probe = 0; probe < std::min(kMaximumProbes, days_.size()); ++probe) {
    const std::size_t index = (start + probe) & mask;
    if (days_[index].date == date) return index;
    if (days_[index].date == 0) {
      if (dayCount_ == dayCapacity_) return kMissing;
      days_[index] = {date, 0};
      ++dayCount_;
      return index;
    }
  }
  return kMissing;
}

bool InputCore::Initialize(std::uint64_t total, LocalDate currentDate,
                           const DailyTotal* daily, std::size_t dailyCount,
                           bool reminderSegmentConsumed) noexcept {
  std::fill(days_.begin(), days_.end(), DailyTotal{});
  dayCount_ = 0;
  currentDaySlot_ = kMissing;
  view_ = {};
  view_.fault = InputFault::InvalidInitialState;
  reminder_ = {};
  lastObservedMs_ = 0;
  hasObservedTime_ = hasCountTime_ = hasScrollTime_ = false;
  if (!ValidDate(currentDate) || dailyCount > dayCapacity_ || (dailyCount && !daily))
    return false;
  for (std::size_t i = 0; i < dailyCount; ++i) {
    if (!ValidDate(daily[i].date) || FindDate(daily[i].date) != kMissing) return false;
    const auto index = EnsureDate(daily[i].date);
    if (index == kMissing) return false;
    days_[index].total = daily[i].total;
  }
  currentDaySlot_ = EnsureDate(currentDate);
  if (currentDaySlot_ == kMissing) return false;
  view_.date = currentDate;
  view_.total = total;
  view_.today = days_[currentDaySlot_].total;
  view_.ready = true;
  view_.fault = InputFault::None;
  view_.version = view_.epoch = 1;
  reminder_.RestoreSegmentConsumed(reminderSegmentConsumed);
  RefreshReminderView();
  return true;
}

void InputCore::Changed() noexcept { Increment(view_.version); }

void InputCore::Fail(InputFault fault) noexcept {
  if (view_.fault == InputFault::None) view_.fault = fault;
  Changed();
}

bool InputCore::CheckTime(std::uint64_t monotonicMs) noexcept {
  if (hasObservedTime_ && monotonicMs < lastObservedMs_) {
    Fail(InputFault::MonotonicRegression);
    return false;
  }
  hasObservedTime_ = true;
  lastObservedMs_ = monotonicMs;
  return true;
}

bool InputCore::UpdateDate(LocalDate date) noexcept {
  if (!view_.ready || view_.fault != InputFault::None) return false;
  if (!ValidDate(date)) {
    Fail(InputFault::InvalidDate);
    return false;
  }
  const auto index = EnsureDate(date);
  if (index == kMissing) {
    Fail(InputFault::DayCapacity);
    return false;
  }
  if (view_.date != date) {
    currentDaySlot_ = index;
    view_.date = date;
    view_.today = days_[index].total;
    Changed();
  }
  return true;
}

ObserveResult InputCore::Count(std::uint64_t monotonicMs, LocalDate date) noexcept {
  if (!UpdateDate(date)) {
    Increment(view_.unaccountedOperations);
    return ObserveResult::AccountingUnavailable;
  }
  constexpr auto limit = std::numeric_limits<std::uint64_t>::max();
  if (view_.total == limit || view_.today == limit) {
    Fail(InputFault::CounterExhausted);
    Increment(view_.unaccountedOperations);
    return ObserveResult::AccountingUnavailable;
  }
  int duration = kDefaultStrikeMs;
  if (hasCountTime_) {
    const auto interval = monotonicMs - view_.lastInputMs;
    if (interval <= kTempoResetGapMs) {
      view_.intervalEmaMs = view_.intervalEmaMs * 0.65 + static_cast<double>(interval) * 0.35;
      duration = std::clamp(static_cast<int>(std::lround(view_.intervalEmaMs * kTempoFactor)),
                            kMinStrikeMs, kMaxStrikeMs);
    } else {
      view_.intervalEmaMs = static_cast<double>(kDefaultStrikeMs);
    }
  }
  hasCountTime_ = true;
  view_.lastInputMs = monotonicMs;
  view_.suggestedDurationMs = duration;
  ++view_.total;
  ++view_.today;
  ++days_[currentDaySlot_].total;
  Increment(view_.countedOperations);
  // Exactly one current action. Further inputs update counts/tempo but never
  // append animations or restart the currently visible strike.
  if (!view_.striking) {
    view_.striking = true;
    view_.strikeStartedMs = monotonicMs;
    view_.strikeDurationMs = duration;
    Increment(view_.actionSerial);
  }
  return ObserveResult::Counted;
}

ObserveResult InputCore::Observe(const InputEvent& event) noexcept {
  Increment(view_.observedEvents);
  Changed();
  const bool validTime = CheckTime(event.monotonicMs);
  if (!view_.ready || !validTime) {
    if (event.kind != InputKind::KeyUp) Increment(view_.unaccountedOperations);
    return ObserveResult::AccountingUnavailable;
  }
  if (!event.injected) {
    using Activity = niuma::reminder::ActivitySampler;
    Activity::Event activity = Activity::Event::KeyDown;
    switch (event.kind) {
      case InputKind::KeyDown: activity = Activity::Event::KeyDown; break;
      case InputKind::KeyUp: activity = Activity::Event::KeyUp; break;
      case InputKind::Click: activity = Activity::Event::Click; break;
      case InputKind::Scroll: activity = Activity::Event::ScrollPulse; break;
    }
    reminder_.Observe(activity, event.monotonicMs);
  }
  if (event.kind == InputKind::KeyUp) return ObserveResult::Ignored;
  if (event.kind == InputKind::Scroll) {
    const bool startsGesture = !hasScrollTime_ ||
        event.monotonicMs - view_.lastScrollMs > kScrollGestureGapMs;
    hasScrollTime_ = true;
    view_.lastScrollMs = event.monotonicMs;
    if (!startsGesture) return ObserveResult::Ignored;
  }
  return Count(event.monotonicMs, event.date);
}

void InputCore::AdvanceAnimation(std::uint64_t monotonicMs) noexcept {
  if (!view_.ready || !CheckTime(monotonicMs)) return;
  if (view_.striking && monotonicMs - view_.strikeStartedMs >=
                            static_cast<std::uint64_t>(view_.strikeDurationMs)) {
    view_.striking = false;
    Changed();
  }
}

void InputCore::RestartListeners() noexcept {
  Increment(view_.epoch);
  view_.keyboardAvailable = view_.mouseAvailable = false;
  reminder_.ResetForListenerRestart();
  RefreshReminderView();
  Changed();
}

void InputCore::SetListenerHealth(bool keyboard, bool mouse) noexcept {
  if (view_.keyboardAvailable == keyboard && view_.mouseAvailable == mouse) return;
  view_.keyboardAvailable = keyboard;
  view_.mouseAvailable = mouse;
  Changed();
}

void InputCore::RefreshReminderView() noexcept {
  view_.reminderSegmentConsumed = reminder_.segment_consumed();
  view_.reminderSuspended = reminder_.suspended();
}

niuma::reminder::ActivitySampler::Trigger InputCore::EvaluateReminder(
    std::uint64_t monotonicMs, bool listenerHealthy) noexcept {
  using Trigger = niuma::reminder::ActivitySampler::Trigger;
  if (!view_.ready || !CheckTime(monotonicMs)) return Trigger::None;
  const auto result = reminder_.Evaluate(monotonicMs,
      listenerHealthy && view_.fault == InputFault::None);
  const bool consumed = view_.reminderSegmentConsumed;
  RefreshReminderView();
  if (consumed != view_.reminderSegmentConsumed) Changed();
  return result;
}

void InputCore::ResetReminderObservation() noexcept {
  reminder_.ResetForListenerRestart();
  RefreshReminderView();
  Changed();
}

void InputCore::BeginSuspend(std::uint64_t monotonicMs) noexcept {
  if (!view_.ready || !CheckTime(monotonicMs)) return;
  reminder_.BeginSuspend(monotonicMs);
  RefreshReminderView();
  Changed();
}

bool InputCore::ResumeFromSuspend(std::uint64_t monotonicMs, bool pairedSignal,
                                   bool durationTrusted,
                                   std::uint64_t inactiveDurationMs) noexcept {
  if (!view_.ready || !CheckTime(monotonicMs)) return false;
  const bool unlocked = reminder_.ResumeFromSuspend(
      monotonicMs, pairedSignal, durationTrusted, inactiveDurationMs);
  RefreshReminderView();
  Changed();
  return unlocked;
}

void InputCore::RestoreReminderSegmentConsumed(bool consumed) noexcept {
  reminder_.RestoreSegmentConsumed(consumed);
  RefreshReminderView();
  Changed();
}

bool InputCore::GetDailyTotal(LocalDate date, std::uint64_t& value) const noexcept {
  if (!ValidDate(date)) return false;
  const auto index = FindDate(date);
  if (index == kMissing) return false;
  value = days_[index].total;
  return true;
}

std::size_t InputCore::CopyDailyTotals(DailyTotal* output, std::size_t capacity) const noexcept {
  if (!output || capacity < dayCount_) return dayCount_;
  std::size_t index = 0;
  for (const auto& day : days_) {
    if (day.date) output[index++] = day;
  }
  return dayCount_;
}

}  // namespace niuma::client::core
