#include "../src/client/core/input_state.h"
#include "../src/client/core/latest_snapshot.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
std::atomic<bool> watchAllocations{false};
std::atomic<unsigned> watchedAllocations{0};
}

void* operator new(std::size_t size) {
  if (watchAllocations.load(std::memory_order_relaxed)) ++watchedAllocations;
  if (void* value = std::malloc(size ? size : 1)) return value;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

namespace {
using namespace niuma::client::core;
using Trigger = niuma::reminder::ActivitySampler::Trigger;
constexpr LocalDate day = 20261024;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

InputEvent Event(InputKind kind, std::uint64_t when, LocalDate date = day,
                 bool injected = false) {
  return {kind, injected, when, date};
}

void AccountingAndDates() {
  InputCore core;
  const DailyTotal previous[] = {{20261023, 20}, {day, 30}};
  CHECK(core.Initialize(1000, 20261023, previous, 2));
  CHECK(core.Observe(Event(InputKind::KeyDown, 1000, 20261023)) == ObserveResult::Counted);
  CHECK(core.Observe(Event(InputKind::KeyUp, 1001, 20261023)) == ObserveResult::Ignored);
  CHECK(core.Observe(Event(InputKind::Click, 1002, day)) == ObserveResult::Counted);
  CHECK(core.snapshot().date == day && core.snapshot().today == 31);
  // A wall-clock/date change does not change monotonic order or erase a day.
  CHECK(core.Observe(Event(InputKind::KeyDown, 1003, 20261023)) == ObserveResult::Counted);
  CHECK(core.snapshot().total == 1003 && core.snapshot().today == 22);
  CHECK(core.snapshot().countedOperations == 3);
  std::uint64_t actual = 0;
  CHECK(core.GetDailyTotal(day, actual) && actual == 31);
  CHECK(core.GetDailyTotal(20261023, actual) && actual == 22);
  DailyTotal tooSmall{20000101, 123};
  CHECK(core.CopyDailyTotals(&tooSmall, 1) == 2);
  CHECK(tooSmall.date == 20000101 && tooSmall.total == 123);
  DailyTotal copy[2]{};
  CHECK(core.CopyDailyTotals(copy, 2) == 2);
  CHECK(copy[0].total + copy[1].total == 53);
  CHECK(core.UpdateDate(20261025));
  CHECK(core.snapshot().today == 0 && core.snapshot().total == 1003);
}

void ScrollBoundary() {
  InputCore core;
  CHECK(core.Initialize(0, day, nullptr, 0));
  CHECK(core.Observe(Event(InputKind::Scroll, 1000)) == ObserveResult::Counted);
  CHECK(core.Observe(Event(InputKind::Scroll, 1180)) == ObserveResult::Ignored);
  CHECK(core.Observe(Event(InputKind::Scroll, 1360)) == ObserveResult::Ignored);
  CHECK(core.Observe(Event(InputKind::Scroll, 1541)) == ObserveResult::Counted);
  CHECK(core.Observe(Event(InputKind::Click, 1542)) == ObserveResult::Counted);
  CHECK(core.Observe(Event(InputKind::Scroll, 1721)) == ObserveResult::Ignored);
  CHECK(core.Observe(Event(InputKind::Scroll, 1902)) == ObserveResult::Counted);
  CHECK(core.snapshot().total == 4 && core.snapshot().lastScrollMs == 1902);
  // A valid clock beginning at zero must not act as an unset sentinel.
  InputCore zero;
  CHECK(zero.Initialize(0, day, nullptr, 0));
  CHECK(zero.Observe(Event(InputKind::Scroll, 0)) == ObserveResult::Counted);
  CHECK(zero.Observe(Event(InputKind::Scroll, 1)) == ObserveResult::Ignored);
}

void GoldenTempoAndNoQueue() {
  InputCore core;
  CHECK(core.Initialize(0, day, nullptr, 0));
  core.Observe(Event(InputKind::KeyDown, 1000));
  CHECK(core.snapshot().strikeDurationMs == 220 && core.snapshot().actionSerial == 1);
  core.Observe(Event(InputKind::KeyDown, 1100));
  CHECK(core.snapshot().suggestedDurationMs == 187);
  CHECK(core.snapshot().strikeDurationMs == 220 && core.snapshot().strikeStartedMs == 1000);
  core.Observe(Event(InputKind::KeyDown, 1200));
  CHECK(core.snapshot().suggestedDurationMs == 158);
  core.AdvanceAnimation(1219);
  CHECK(core.snapshot().striking);
  core.AdvanceAnimation(1220);
  CHECK(!core.snapshot().striking);
  core.Observe(Event(InputKind::KeyDown, 1300));
  CHECK(core.snapshot().strikeDurationMs == 140 && core.snapshot().actionSerial == 2);
  core.AdvanceAnimation(1440);
  core.Observe(Event(InputKind::KeyDown, 1900));
  CHECK(core.snapshot().strikeDurationMs == 240);  // Exactly 600 ms retains EMA.
  core.AdvanceAnimation(2140);
  core.Observe(Event(InputKind::KeyDown, 2501));
  CHECK(core.snapshot().strikeDurationMs == 220);  // 601 ms resets the tempo.
  for (unsigned i = 0; i < 5000; ++i) core.Observe(Event(InputKind::KeyDown, 2502));
  CHECK(core.snapshot().total == 5006);
  CHECK(core.snapshot().suggestedDurationMs == 120);
  CHECK(core.snapshot().actionSerial == 4);  // Counts cannot build a playback queue.
  core.AdvanceAnimation(10000);
  CHECK(!core.snapshot().striking && core.snapshot().actionSerial == 4);
}

void ReminderInjectionAndLifecycle() {
  InputCore real, synthetic;
  CHECK(real.Initialize(0, day, nullptr, 0));
  CHECK(synthetic.Initialize(0, day, nullptr, 0));
  unsigned realTriggers = 0;
  unsigned injectedTriggers = 0;
  for (std::uint64_t tick = 100; tick <= 300100; tick += 500) {
    real.Observe(Event(InputKind::KeyDown, tick));
    real.Observe(Event(InputKind::KeyUp, tick + 1));
    synthetic.Observe(Event(InputKind::KeyDown, tick, day, true));
    synthetic.Observe(Event(InputKind::KeyUp, tick + 1, day, true));
    if (real.EvaluateReminder(tick + 2) != Trigger::None) ++realTriggers;
    if (synthetic.EvaluateReminder(tick + 2) != Trigger::None) ++injectedTriggers;
  }
  CHECK(real.snapshot().total == 601 && synthetic.snapshot().total == 601);
  CHECK(realTriggers == 1 && injectedTriggers == 0);
  CHECK(real.snapshot().reminderSegmentConsumed);
  const auto before = real.snapshot();
  real.RestartListeners();
  CHECK(real.snapshot().epoch == before.epoch + 1);
  CHECK(real.snapshot().total == before.total && real.snapshot().reminderSegmentConsumed);
  real.BeginSuspend(301000);
  CHECK(real.snapshot().reminderSuspended);
  real.Observe(Event(InputKind::Click, 302000));
  CHECK(real.snapshot().total == 602);  // Existing merit rule is independent of reminder pause.
  CHECK(!real.ResumeFromSuspend(303000, true, true, 2000));
  CHECK(real.snapshot().reminderSegmentConsumed);
  real.BeginSuspend(304000);
  CHECK(real.ResumeFromSuspend(604000, true, true, 300000));
  CHECK(!real.snapshot().reminderSegmentConsumed && !real.snapshot().reminderSuspended);
  real.RestoreReminderSegmentConsumed(true);
  real.ResetReminderObservation();
  CHECK(real.snapshot().reminderSegmentConsumed);
}

void CapacityFaultPreservesData() {
  InputCore core(1);
  const DailyTotal initial[] = {{day, 10}};
  CHECK(core.Initialize(100, day, initial, 1));
  CHECK(core.Observe(Event(InputKind::Click, 1000)) == ObserveResult::Counted);
  CHECK(core.Observe(Event(InputKind::Click, 1001, 20261025)) == ObserveResult::AccountingUnavailable);
  CHECK(core.snapshot().fault == InputFault::DayCapacity);
  CHECK(core.snapshot().total == 101 && core.snapshot().today == 11);
  CHECK(core.snapshot().unaccountedOperations == 1);
  CHECK(core.Observe(Event(InputKind::Click, 1002)) == ObserveResult::AccountingUnavailable);
  CHECK(core.snapshot().unaccountedOperations == 2 && core.snapshot().total == 101);
  std::uint64_t value = 0;
  CHECK(core.GetDailyTotal(day, value) && value == 11);
  CHECK(!core.GetDailyTotal(20261025, value));
  core.RestartListeners();
  CHECK(core.snapshot().fault == InputFault::DayCapacity);  // Retry must not hide a data fault.
}

void IntegerLimits() {
  constexpr auto max = std::numeric_limits<std::uint64_t>::max();
  InputCore core;
  const DailyTotal daily[] = {{day, 10}};
  CHECK(core.Initialize(max - 1, day, daily, 1));
  CHECK(core.Observe(Event(InputKind::KeyDown, 1000)) == ObserveResult::Counted);
  CHECK(core.snapshot().total == max && core.snapshot().today == 11);
  CHECK(core.Observe(Event(InputKind::KeyDown, 1001)) == ObserveResult::AccountingUnavailable);
  CHECK(core.snapshot().fault == InputFault::CounterExhausted);
  CHECK(core.snapshot().total == max && core.snapshot().today == 11);
}

void InvalidStateAndTime() {
  InputCore core;
  CHECK(!core.Initialize(0, 20260229, nullptr, 0));
  CHECK(!core.snapshot().ready && core.snapshot().fault == InputFault::InvalidInitialState);
  CHECK(InputCore::ValidDate(20240229) && !InputCore::ValidDate(21000229));
  const DailyTotal duplicate[] = {{day, 1}, {day, 2}};
  CHECK(!core.Initialize(3, day, duplicate, 2));
  CHECK(core.Initialize(0, day, nullptr, 0));
  core.Observe(Event(InputKind::KeyDown, 1000));
  CHECK(core.Observe(Event(InputKind::KeyDown, 999)) == ObserveResult::AccountingUnavailable);
  CHECK(core.snapshot().fault == InputFault::MonotonicRegression);
  CHECK(core.snapshot().total == 1);
  core.Observe(Event(InputKind::KeyDown, 1001));
  CHECK(core.snapshot().total == 1 && core.snapshot().unaccountedOperations == 2);
  InputCore invalidDate;
  CHECK(invalidDate.Initialize(0, day, nullptr, 0));
  invalidDate.Observe(Event(InputKind::KeyDown, 1, 20261301));
  CHECK(invalidDate.snapshot().fault == InputFault::InvalidDate);
  CHECK(invalidDate.snapshot().total == 0 && invalidDate.snapshot().unaccountedOperations == 1);
}

void CallbackDoesNotAllocate() {
  InputCore core;
  CHECK(core.Initialize(0, day, nullptr, 0));
  watchedAllocations = 0;
  watchAllocations = true;
  for (std::uint64_t i = 0; i < 10000; ++i) {
    const auto date = i < 5000 ? day : 20261025;
    core.Observe(Event(InputKind::KeyDown, i * 10, date));
    core.Observe(Event(InputKind::KeyUp, i * 10 + 1, date));
    if (i % 100 == 0) core.EvaluateReminder(i * 10 + 2);
    core.AdvanceAnimation(i * 10 + 3);
  }
  watchAllocations = false;
  CHECK(watchedAllocations == 0);
  CHECK(core.snapshot().total == 10000 && core.snapshot().today == 5000);
}

void DelayedConsumerKeepsCumulativeState() {
  InputCore core;
  LatestSnapshot<InputSnapshot> snapshots;
  LatestSnapshotWake wake;
  CHECK(core.Initialize(0, day, nullptr, 0));
  unsigned messages = 0;
  for (std::uint64_t i = 1; i <= 100000; ++i) {
    core.Observe(Event(InputKind::KeyDown, i));
    snapshots.Publish(core.snapshot());
    if (wake.RequestWake()) ++messages;
  }
  CHECK(messages == 1);
  wake.BeginConsume();
  InputSnapshot value;
  CHECK(snapshots.Read(value));
  CHECK(value.total == 100000 && value.today == 100000);
  CHECK(value.version == core.snapshot().version);
  CHECK(!snapshots.Read(value) && value.total == 100000);
  core.Observe(Event(InputKind::Click, 100001));
  snapshots.Publish(core.snapshot());
  CHECK(wake.RequestWake());
  wake.PostFailed();
  CHECK(wake.RequestWake());  // A failed post does not permanently suppress wakes.
}

struct CoherentPacket {
  std::uint64_t sequence = 0;
  std::uint64_t values[16]{};
};

CoherentPacket Packet(std::uint64_t sequence) {
  CoherentPacket value;
  value.sequence = sequence;
  for (unsigned i = 0; i < 16; ++i) value.values[i] = sequence * 31 + i;
  return value;
}

void ConcurrentSnapshotCoherence() {
  constexpr std::uint64_t iterations = 300000;
  LatestSnapshot<CoherentPacket> snapshots;
  std::atomic<bool> failed{false};
  std::atomic<bool> done{false};
  std::uint64_t finalRead = 0;
  std::thread reader([&] {
    std::uint64_t previous = 0;
    // Intentionally stall only the consumer while publisher remains free.
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline) {
      CoherentPacket value;
      if (snapshots.Read(value)) {
        if (value.sequence < previous) failed = true;
        for (unsigned i = 0; i < 16; ++i)
          if (value.values[i] != value.sequence * 31 + i) failed = true;
        previous = value.sequence;
      }
      if (done.load(std::memory_order_acquire) && previous == iterations) break;
      std::this_thread::yield();
    }
    finalRead = previous;
  });
  for (std::uint64_t i = 1; i <= iterations; ++i) snapshots.Publish(Packet(i));
  done.store(true, std::memory_order_release);
  reader.join();
  CHECK(!failed && finalRead == iterations);
}

void ConcurrentWakeHasNoLostTail() {
  constexpr std::uint64_t iterations = 100000;
  LatestSnapshot<CoherentPacket> snapshots;
  LatestSnapshotWake wake;
  std::atomic<unsigned> messages{0};
  std::atomic<bool> failed{false};
  std::atomic<bool> done{false};
  std::uint64_t finalRead = 0;
  std::thread reader([&] {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline) {
      const auto pending = messages.exchange(0, std::memory_order_acq_rel);
      if (pending > 1) failed = true;
      if (pending) {
        wake.BeginConsume();
        CoherentPacket value;
        snapshots.Read(value);
        if (value.sequence < finalRead) failed = true;
        finalRead = value.sequence;
      }
      if (done.load(std::memory_order_acquire) && finalRead == iterations) break;
      std::this_thread::yield();
    }
  });
  for (std::uint64_t i = 1; i <= iterations; ++i) {
    snapshots.Publish(Packet(i));
    if (wake.RequestWake()) messages.fetch_add(1, std::memory_order_release);
  }
  done.store(true, std::memory_order_release);
  reader.join();
  CHECK(!failed && finalRead == iterations);
}

}  // namespace

int main() {
  struct Test { const char* name; void (*run)(); };
  const Test tests[] = {
      {"preloaded history and capture-date accounting", AccountingAndDates},
      {"scroll 180 ms boundary", ScrollBoundary},
      {"golden tempo trajectory and no animation queue", GoldenTempoAndNoQueue},
      {"injected merit/reminder split and reminder lifecycle", ReminderInjectionAndLifecycle},
      {"explicit day-capacity fault preserves existing ledger", CapacityFaultPreservesData},
      {"integer limits never wrap", IntegerLimits},
      {"invalid initial state, dates and monotonic regression", InvalidStateAndTime},
      {"input callbacks and day transitions allocate nothing", CallbackDoesNotAllocate},
      {"delayed consumer sees all cumulative counts with one wake", DelayedConsumerKeepsCumulativeState},
      {"concurrent snapshots stay coherent without writer waiting", ConcurrentSnapshotCoherence},
      {"concurrent notification clear cannot lose final publication", ConcurrentWakeHasNoLostTail},
  };
  unsigned passed = 0;
  try {
    for (const auto& test : tests) {
      test.run();
      ++passed;
      std::cout << "PASS " << test.name << '\n';
    }
  } catch (const std::exception& error) {
    watchAllocations = false;
    std::cerr << "FAIL after " << passed << " groups: " << error.what() << '\n';
    return 1;
  }
  std::cout << passed << "/" << std::size(tests) << " input-core groups passed\n";
  return 0;
}
