#include "../src/client/core/ledger_snapshot.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
std::atomic<bool> failNextAllocation{false};
}

void* operator new(std::size_t size) {
  if (failNextAllocation.exchange(false, std::memory_order_relaxed)) throw std::bad_alloc();
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
constexpr LocalDate day = 20261024;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

void Count(InputCore& core, std::uint64_t when, LocalDate date = day) {
  CHECK(core.Observe({InputKind::KeyDown, true, when, date}) == ObserveResult::Counted);
}

std::uint64_t Find(const LedgerSnapshotResult& result, LocalDate date) {
  for (const auto& entry : result.daily) if (entry.date == date) return entry.total;
  throw std::runtime_error("Expected date is missing from complete ledger");
}

void CompleteVersionedLedger() {
  InputCore core(8);
  LedgerSnapshotChannel channel(8);
  const DailyTotal initial[] = {{day - 1, 7}, {day, 11}};
  CHECK(core.Initialize(18, day, initial, 2));
  Count(core, 100);
  Count(core, 101, day + 1);
  Count(core, 102, day - 1);
  CHECK(channel.Request({17, 1}) == LedgerRequestResult::Accepted);
  CHECK(channel.ProduceIfRequested(core));
  const auto captured = core.snapshot();
  // Input may continue while the consumer is slow. Ready owns a full copy.
  Count(core, 103, day + 1);
  Count(core, 104);
  CHECK(!channel.ProduceIfRequested(core));
  LedgerSnapshotResult first;
  CHECK(channel.TryConsume(first));
  CHECK(first.header.status == LedgerResultStatus::Complete);
  CHECK(first.header.request.id == 17 && first.header.request.expectedEpoch == 1);
  CHECK(first.header.input.version == captured.version);
  CHECK(first.header.input.total == 21 && first.header.input.today == 8);
  CHECK(first.header.dailyCount == 3 && first.daily.size() == 3);
  CHECK(Find(first, day - 1) == 8 && Find(first, day) == 12 && Find(first, day + 1) == 1);
  CHECK(channel.Request({18, 1}) == LedgerRequestResult::Accepted);
  CHECK(channel.ProduceIfRequested(core));
  LedgerSnapshotResult second;
  CHECK(channel.TryConsume(second));
  CHECK(second.header.input.version == core.snapshot().version);
  CHECK(second.header.input.version > first.header.input.version);
  CHECK(second.header.input.total == 23 && Find(second, day) == 13 && Find(second, day + 1) == 2);
  CHECK(Find(first, day) == 12);  // Consumer result also owns its copy.
}

void BusyNeverOverwrites() {
  InputCore core(4);
  CHECK(core.Initialize(0, day, nullptr, 0));
  LedgerSnapshotChannel channel(4);
  CHECK(channel.Request({0, 1}) == LedgerRequestResult::Invalid);
  CHECK(channel.Request({1, 0}) == LedgerRequestResult::Invalid);
  CHECK(channel.Request({1, 1}) == LedgerRequestResult::Accepted);
  CHECK(channel.Request({2, 1}) == LedgerRequestResult::Busy);
  CHECK(channel.ProduceIfRequested(core));
  CHECK(channel.Request({3, 1}) == LedgerRequestResult::Busy);
  LedgerSnapshotResult result;
  CHECK(channel.TryConsume(result));
  CHECK(result.header.request.id == 1 && result.header.input.total == 0);
  CHECK(!channel.TryConsume(result));
  CHECK(channel.Request({4, 1}) == LedgerRequestResult::Accepted);
}

void EpochMismatchIsExplicit() {
  InputCore core(4);
  CHECK(core.Initialize(0, day, nullptr, 0));
  LedgerSnapshotChannel channel(4);
  CHECK(channel.Request({1, 1}) == LedgerRequestResult::Accepted);
  core.RestartListeners();
  Count(core, 1);
  CHECK(channel.ProduceIfRequested(core));
  LedgerSnapshotResult result;
  result.daily.push_back({day, 999});
  CHECK(channel.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::EpochMismatch);
  CHECK(result.header.request.expectedEpoch == 1 && result.header.input.epoch == 2);
  CHECK(result.header.dailyCount == 0 && result.daily.empty());
  CHECK(channel.Request({2, 2}) == LedgerRequestResult::Accepted);
  CHECK(channel.ProduceIfRequested(core));
  CHECK(channel.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::Complete && Find(result, day) == 1);
}

void CapacityAndUnavailableAreExplicit() {
  InputCore core(4);
  const DailyTotal initial[] = {{day, 4}, {day + 1, 7}};
  CHECK(core.Initialize(11, day, initial, 2));
  LedgerSnapshotChannel shortChannel(1);
  CHECK(shortChannel.Request({1, 1}) == LedgerRequestResult::Accepted);
  CHECK(shortChannel.ProduceIfRequested(core));
  LedgerSnapshotResult result;
  CHECK(shortChannel.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::CapacityMismatch);
  CHECK(result.daily.empty() && result.header.dailyCount == 0 && result.header.input.total == 11);
  InputCore unavailable(4);
  LedgerSnapshotChannel channel(4);
  CHECK(channel.Request({2, 1}) == LedgerRequestResult::Accepted);
  CHECK(channel.ProduceIfRequested(unavailable));
  CHECK(channel.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::CoreUnavailable && result.daily.empty());
}

void ClosePreservesReadyAndTerminatesPending() {
  InputCore core(4);
  CHECK(core.Initialize(0, day, nullptr, 0));
  Count(core, 1);
  LedgerSnapshotChannel ready(4);
  CHECK(ready.Request({1, 1}) == LedgerRequestResult::Accepted);
  CHECK(ready.ProduceIfRequested(core));
  Count(core, 2);
  ready.Close(core.snapshot());
  LedgerSnapshotResult result;
  CHECK(ready.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::Complete && result.header.input.total == 1);
  CHECK(Find(result, day) == 1 && ready.state() == LedgerSlotState::Closed);
  CHECK(ready.Request({2, 1}) == LedgerRequestResult::Stopped);
  LedgerSnapshotChannel pending(4);
  CHECK(pending.Request({3, 1}) == LedgerRequestResult::Accepted);
  pending.Close(core.snapshot());
  CHECK(pending.TryConsume(result));
  CHECK(result.header.status == LedgerResultStatus::Stopped && result.header.request.id == 3);
  CHECK(result.header.input.total == 2 && result.daily.empty());
  CHECK(pending.Request({4, 1}) == LedgerRequestResult::Stopped);
  LedgerSnapshotChannel unused(4);
  unused.Close(core.snapshot());
  CHECK(unused.Request({5, 1}) == LedgerRequestResult::Stopped);
  CHECK(!unused.TryConsume(result));
}

void FailedConsumerCanRetrySameSnapshot() {
  InputCore core(4);
  CHECK(core.Initialize(0, day, nullptr, 0));
  Count(core, 1);
  LedgerSnapshotChannel channel(4);
  CHECK(channel.Request({1, 1}) == LedgerRequestResult::Accepted);
  CHECK(channel.ProduceIfRequested(core));
  LedgerSnapshotResult result;
  result.header.request.id = 99;
  bool allocationFailed = false;
  failNextAllocation.store(true, std::memory_order_relaxed);
  try { channel.TryConsume(result); } catch (const std::bad_alloc&) { allocationFailed = true; }
  CHECK(allocationFailed && !failNextAllocation.load(std::memory_order_relaxed));
  CHECK(channel.state() == LedgerSlotState::Ready && result.header.request.id == 99);
  CHECK(channel.Request({2, 1}) == LedgerRequestResult::Busy);
  Count(core, 2);
  CHECK(!channel.ProduceIfRequested(core));
  CHECK(channel.TryConsume(result));
  CHECK(result.header.request.id == 1 && result.header.input.total == 1 && Find(result, day) == 1);
}

template <typename Predicate>
void Await(Predicate predicate) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!predicate()) {
    CHECK(std::chrono::steady_clock::now() < end);
    std::this_thread::yield();
  }
}

void ValidateStream(const LedgerSnapshotResult& result, std::uint64_t requestId) {
  CHECK(result.header.status == LedgerResultStatus::Complete);
  CHECK(result.header.request.id == requestId && result.header.input.epoch == 1);
  const auto n = result.header.input.total;
  CHECK(n > 0 && result.daily.size() == 3 && result.header.dailyCount == 3);
  CHECK(result.header.input.countedOperations == n);
  CHECK(result.header.input.version == n * 2);  // One Observe and each subsequent date change.
  CHECK(Find(result, day) == (n + 2) / 3);
  CHECK(Find(result, day + 1) == (n + 1) / 3);
  CHECK(Find(result, day + 2) == n / 3);
  CHECK(Find(result, result.header.input.date) == result.header.input.today);
}

void ConcurrentSlowConsumerDoesNotBlockOwner() {
  LedgerSnapshotChannel channel(8);
  std::atomic<bool> stop{false};
  std::atomic<bool> failed{false};
  std::atomic<std::uint64_t> progress{0};
  std::thread owner([&] {
    InputCore core(8);
    const DailyTotal initial[] = {{day, 0}, {day + 1, 0}, {day + 2, 0}};
    if (!core.Initialize(0, day, initial, 3)) { failed = true; return; }
    std::uint64_t n = 0;
    while (!stop.load(std::memory_order_acquire)) {
      const auto date = day + static_cast<LocalDate>(n % 3);
      ++n;
      if (core.Observe({InputKind::KeyDown, true, n, date}) != ObserveResult::Counted) {
        failed = true;
        break;
      }
      channel.ProduceIfRequested(core);
      progress.store(n, std::memory_order_release);
    }
    channel.Close(core.snapshot());
  });
  struct Join {
    std::atomic<bool>& stop;
    std::thread& thread;
    ~Join() { stop.store(true, std::memory_order_release); thread.join(); }
  } join{stop, owner};
  CHECK(channel.Request({1, 1}) == LedgerRequestResult::Accepted);
  Await([&] { return channel.state() == LedgerSlotState::Ready; });
  const auto before = progress.load(std::memory_order_acquire);
  // The input owner keeps counting while a completed ledger waits for storage.
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  const auto after = progress.load(std::memory_order_acquire);
  CHECK(after > before);
  LedgerSnapshotResult result;
  CHECK(channel.TryConsume(result));
  ValidateStream(result, 1);
  CHECK(result.header.input.total <= before + 1 && result.header.input.total < after);
  std::uint64_t previousVersion = result.header.input.version;
  for (std::uint64_t requestId = 2; requestId <= 1001; ++requestId) {
    CHECK(channel.Request({requestId, 1}) == LedgerRequestResult::Accepted);
    Await([&] { return channel.TryConsume(result); });
    ValidateStream(result, requestId);
    CHECK(result.header.input.version >= previousVersion);
    previousVersion = result.header.input.version;
  }
  CHECK(!failed.load(std::memory_order_acquire));
}

void CloseAndRequestRaceCannotStrandARequest() {
  InputCore core(2);
  CHECK(core.Initialize(0, day, nullptr, 0));
  for (unsigned iteration = 0; iteration < 100; ++iteration) {
    LedgerSnapshotChannel channel(2);
    std::atomic<bool> go{false};
    std::thread owner([&] {
      while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
      channel.Close(core.snapshot());
    });
    go.store(true, std::memory_order_release);
    const auto requested = channel.Request({iteration + 1, 1});
    owner.join();
    CHECK(requested == LedgerRequestResult::Accepted || requested == LedgerRequestResult::Stopped);
    LedgerSnapshotResult result;
    if (requested == LedgerRequestResult::Accepted) {
      CHECK(channel.TryConsume(result));
      CHECK(result.header.status == LedgerResultStatus::Stopped);
      CHECK(result.header.request.id == iteration + 1);
    } else {
      CHECK(!channel.TryConsume(result));
    }
    CHECK(channel.Request({iteration + 2, 1}) == LedgerRequestResult::Stopped);
  }
}
}  // namespace

int main() {
  struct Test { const char* name; void (*run)(); };
  const Test tests[] = {
    {"complete_versioned_ledger", CompleteVersionedLedger},
    {"busy_never_overwrites", BusyNeverOverwrites},
    {"epoch_mismatch_explicit", EpochMismatchIsExplicit},
    {"capacity_unavailable_explicit", CapacityAndUnavailableAreExplicit},
    {"close_preserves_ready", ClosePreservesReadyAndTerminatesPending},
    {"failed_consumer_retries", FailedConsumerCanRetrySameSnapshot},
    {"concurrent_slow_consumer", ConcurrentSlowConsumerDoesNotBlockOwner},
    {"close_request_race", CloseAndRequestRaceCannotStrandARequest},
  };
  unsigned passed = 0;
  for (const auto& test : tests) {
    try {
      test.run();
      ++passed;
      std::cout << "PASS " << test.name << '\n';
    } catch (const std::exception& error) {
      std::cerr << "FAIL " << test.name << ": " << error.what() << '\n';
      return 1;
    }
  }
  std::cout << passed << "/" << (sizeof(tests) / sizeof(tests[0])) << " passed\n";
  return 0;
}
