#include "../src/client/core/storage_state.h"

#include <cstdlib>
#include <iostream>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>

namespace {
bool failNextAllocation = false;  // The coordinator and these tests have one owner.
}
void* operator new(std::size_t size) {
  if (failNextAllocation) { failNextAllocation = false; throw std::bad_alloc(); }
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
constexpr auto never = std::numeric_limits<std::uint64_t>::max();
#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

LedgerSnapshotResult Ledger(std::uint64_t version, std::uint64_t total,
                            std::initializer_list<DailyTotal> daily,
                            std::uint64_t lastInputMs = 100) {
  LedgerSnapshotResult result;
  result.daily = daily;
  result.header.request = {version, 1};
  result.header.status = LedgerResultStatus::Complete;
  result.header.dailyCount = result.daily.size();
  auto& input = result.header.input;
  input.ready = true;
  input.fault = InputFault::None;
  input.epoch = 1;
  input.version = version;
  input.total = total;
  input.date = result.daily.back().date;
  input.today = result.daily.back().total;
  input.lastInputMs = lastInputMs;
  return result;
}

StorageFileState Initial() {
  StorageFileState initial;
  initial.counts.total = 100;
  initial.counts.daily = {{day - 1, 30}, {day, 70}};
  initial.window = {true, -300, 25};
  initial.appearance = {0, "official.old"};
  initial.autostart = {true, false};
  initial.guide = {true, true};
  initial.offwork = {true, 18, 30};
  initial.offworkDays[day - 1] = {true, 600, 1110, 1792760000};
  return initial;
}

void OldAckCannotClearNewCountDirty() {
  StorageState storage(Initial());
  CHECK(!storage.dirty() && !storage.has_pending() && storage.NextWriteDue() == never);
  CHECK(storage.UpdateCounts(Ledger(1, 101, {{day - 1, 30}, {day, 71}}), 100) == StorageUpdate::Changed);
  auto first = storage.BeginWrite(600);
  CHECK(first && storage.in_flight() && !storage.has_pending());
  CHECK(storage.UpdateCounts(Ledger(2, 102, {{day - 1, 30}, {day, 71}, {day + 1, 1}}, 700), 700)
        == StorageUpdate::Changed);
  CHECK(storage.has_pending() && !storage.BeginWrite(20000, true));
  CHECK(first->state.counts.total == 101 && first->state.counts.daily.size() == 2);
  CHECK(storage.CompleteWrite(first->id, true, 1000));
  CHECK(storage.dirty(StorageDomain::Counts) && storage.has_pending());
  auto second = storage.BeginWrite(1200);
  CHECK(second && second->id != first->id);
  CHECK(second->state.counts.total == 102 && second->state.counts.daily.size() == 3);
  CHECK(second->state.counts.daily.at(day - 1) == 30 && second->state.counts.daily.at(day + 1) == 1);
  CHECK(!storage.CompleteWrite(first->id, true, 1201));
  CHECK(storage.in_flight() && storage.dirty());
  CHECK(storage.CompleteWrite(second->id, true, 1202));
  CHECK(!storage.dirty() && !storage.has_pending());
}

void DomainsMergeWithoutRevertingUi() {
  StorageState storage(Initial());
  CHECK(storage.UpdateAppearance({0, "official.new"}, 100) == StorageUpdate::Changed);
  auto first = storage.BeginWrite(100);
  CHECK(first && first->state.appearance.selectedPackId == "official.new");
  CHECK(storage.UpdateWindow({true, 200, -80}, 101) == StorageUpdate::Changed);
  CHECK(storage.UpdateAutostart({true, true}, 102) == StorageUpdate::Changed);
  CHECK(storage.UpdateGuide({true, false}, 103) == StorageUpdate::Changed);
  CHECK(storage.UpdateOffworkSettings({false, 19, 15}, 104) == StorageUpdate::Changed);
  CHECK(storage.UpdateCounts(Ledger(1, 101, {{day - 1, 31}, {day, 70}}), 105) == StorageUpdate::Changed);
  CHECK(storage.CompleteWrite(first->id, true, 106));
  CHECK(!storage.dirty(StorageDomain::Appearance));
  CHECK(storage.dirty(StorageDomain::Window) && storage.dirty(StorageDomain::Counts));
  CHECK(storage.dirty(StorageDomain::Autostart) && storage.dirty(StorageDomain::Guide));
  auto second = storage.BeginWrite(106);
  CHECK(second && second->state.appearance.selectedPackId == "official.new");
  CHECK(second->state.window.x == 200 && second->state.window.y == -80);
  CHECK(second->state.autostart.enabled && !second->state.guide.basicGuideShown);
  CHECK(!second->state.offwork.enabled && second->state.offwork.hour == 19 && second->state.offwork.minute == 15);
  CHECK(second->state.counts.total == 101 && second->state.offworkDays.at(day - 1).seconds == 600);
  CHECK(storage.CompleteWrite(second->id, true, 107));
  CHECK(!storage.dirty());
}

void SlowWriterKeepsOneMergedPending() {
  StorageState storage(Initial());
  CHECK(storage.UpdateWindow({true, 1, 2}, 1) == StorageUpdate::Changed);
  auto first = storage.BeginWrite(1);
  CHECK(first);
  for (std::uint64_t n = 1; n <= 1000; ++n) {
    CHECK(storage.UpdateCounts(Ledger(n, 100 + n, {{day - 1, 30}, {day, 70 + n}}, n), n)
          == StorageUpdate::Changed);
    CHECK(!storage.BeginWrite(n, true));
  }
  CHECK(storage.current().counts.total == 1100 && first->state.counts.total == 100);
  CHECK(storage.CompleteWrite(first->id, false, 1001));
  CHECK(storage.save_failed() && storage.has_pending());
  CHECK(!storage.BeginWrite(2000));
  auto retry = storage.BeginWrite(2001);
  CHECK(retry && retry->id == first->id + 1);  // No 1000-task backlog.
  CHECK(retry->state.counts.total == 1100 && retry->state.counts.daily.at(day - 1) == 30);
  CHECK(retry->state.window.x == 1 && retry->state.window.y == 2);
  CHECK(storage.CompleteWrite(retry->id, true, 2002));
  CHECK(!storage.dirty() && !storage.save_failed());
}

void FullLedgerValidationPreservesKnownDays() {
  StorageState storage(Initial(), 3);
  CHECK(storage.UpdateCounts(Ledger(1, 100, {{day - 1, 30}, {day, 70}}), 100) == StorageUpdate::Unchanged);
  CHECK(storage.UpdateCounts(Ledger(2, 101, {{day, 71}}), 100) == StorageUpdate::Invalid);
  CHECK(storage.UpdateCounts(Ledger(2, 101, {{day - 1, 29}, {day, 72}}), 100) == StorageUpdate::Invalid);
  CHECK(storage.UpdateCounts(Ledger(2, 99, {{day - 1, 30}, {day, 70}}), 100) == StorageUpdate::Invalid);
  CHECK(storage.UpdateCounts(Ledger(2, 101, {{day - 1, 30}, {day, 71}, {day, 71}}), 100) == StorageUpdate::Invalid);
  CHECK(storage.UpdateCounts(Ledger(2, 103, {{day - 1, 30}, {day, 71}, {day + 1, 1}, {day + 2, 1}}), 100)
        == StorageUpdate::CapacityExceeded);
  auto bad = Ledger(2, 101, {{day - 1, 30}, {day, 71}});
  bad.header.input.today = 70;
  CHECK(storage.UpdateCounts(bad, 100) == StorageUpdate::Invalid);
  bad = Ledger(2, 101, {{day - 1, 30}, {day, 71}});
  bad.header.status = LedgerResultStatus::EpochMismatch;
  CHECK(storage.UpdateCounts(bad, 100) == StorageUpdate::Invalid);
  CHECK(!storage.dirty() && storage.current().counts.total == 100 && storage.current().counts.daily.size() == 2);
  CHECK(storage.UpdateCounts(Ledger(2, 102, {{day - 1, 31}, {day, 70}, {day + 1, 1}}), 100)
        == StorageUpdate::Changed);
}

void OldSourceDoesNotOverwriteAndFaultIsVisible() {
  StorageState storage(Initial());
  auto newest = Ledger(4, 102, {{day - 1, 30}, {day, 72}});
  CHECK(storage.UpdateCounts(newest, 100) == StorageUpdate::Changed);
  CHECK(storage.UpdateCounts(Ledger(3, 101, {{day - 1, 30}, {day, 71}}), 100) == StorageUpdate::Stale);
  CHECK(storage.UpdateCounts(Ledger(4, 103, {{day - 1, 30}, {day, 73}}), 100) == StorageUpdate::Invalid);
  newest.header.input.epoch = 2;
  newest.header.input.version = 5;
  newest.header.input.fault = InputFault::DayCapacity;
  newest.header.input.unaccountedOperations = 8;
  CHECK(storage.UpdateCounts(newest, 100) == StorageUpdate::Unchanged);
  CHECK(storage.accounting_fault() == InputFault::DayCapacity && storage.unaccounted_operations() == 8);
  CHECK(storage.UpdateCounts(Ledger(100, 102, {{day - 1, 30}, {day, 72}}), 100) == StorageUpdate::Stale);
  CHECK(storage.current().counts.total == 102 && storage.accounting_fault() == InputFault::DayCapacity);
}

void RetryIsBoundedAndNewDataDoesNotBypassBackoff() {
  StorageState storage(Initial());
  CHECK(storage.UpdateWindow({true, 1, 1}, 0) == StorageUpdate::Changed);
  const std::uint64_t expected[] = {1000, 2000, 4000, 8000, 16000, 30000, 30000};
  std::uint64_t now = 0;
  for (unsigned n = 0; n < 7; ++n) {
    auto write = storage.BeginWrite(now);
    CHECK(write);
    CHECK(storage.CompleteWrite(write->id, false, now));
    CHECK(storage.consecutive_failures() == n + 1 && storage.dirty());
    CHECK(storage.NextWriteDue() == now + expected[n]);
    CHECK(storage.UpdateWindow({true, static_cast<std::int32_t>(n + 2), 1}, now + 1) == StorageUpdate::Changed);
    CHECK(!storage.BeginWrite(now + expected[n] - 1));
    now += expected[n];
  }
  auto success = storage.BeginWrite(now);
  CHECK(success && success->state.window.x == 8);
  CHECK(storage.CompleteWrite(success->id, true, now));
  CHECK(!storage.save_failed() && !storage.dirty());
}

void OffworkDeletionSurvivesOldAckAndFailure() {
  StorageState storage(Initial());
  CHECK(storage.UpdateOffworkDay(day - 1, {true, 601, 1110, 1792760001}, 100) == StorageUpdate::Changed);
  CHECK(storage.NextWriteDue() == 60100 && !storage.BeginWrite(60099));
  auto first = storage.BeginWrite(60100);
  CHECK(first && first->state.offworkDays.at(day - 1).present);
  CHECK(storage.UpdateOffworkDay(day - 1, {}, 60101) == StorageUpdate::Changed);
  CHECK(storage.UpdateOffworkDay(day, {true, 15, 1110, 1792846400}, 60102) == StorageUpdate::Changed);
  CHECK(storage.CompleteWrite(first->id, true, 60103));
  CHECK(storage.dirty(StorageDomain::OffworkDays));
  auto deletion = storage.BeginWrite(60103, true);
  CHECK(deletion && !deletion->state.offworkDays.at(day - 1).present);
  CHECK(deletion->state.offworkDays.at(day).seconds == 15);
  CHECK(storage.CompleteWrite(deletion->id, false, 60104));
  auto retry = storage.BeginWrite(61104);
  CHECK(retry && !retry->state.offworkDays.at(day - 1).present);
  CHECK(retry->state.offworkDays.at(day).present);
  CHECK(storage.CompleteWrite(retry->id, true, 61105));
  CHECK(!storage.dirty());
}

void CountDebounceHasMaximumDelay() {
  StorageState storage(Initial());
  CHECK(storage.UpdateCounts(Ledger(1, 101, {{day - 1, 30}, {day, 71}}, 1000), 1000) == StorageUpdate::Changed);
  CHECK(storage.NextWriteDue() == 1500 && !storage.BeginWrite(1499));
  CHECK(storage.UpdateCounts(Ledger(2, 102, {{day - 1, 30}, {day, 72}}, 1400), 1400) == StorageUpdate::Changed);
  CHECK(storage.NextWriteDue() == 1900 && !storage.BeginWrite(1500));
  CHECK(storage.UpdateCounts(Ledger(3, 103, {{day - 1, 30}, {day, 73}}, 5900), 5900) == StorageUpdate::Changed);
  CHECK(storage.NextWriteDue() == 6000 && !storage.BeginWrite(5999));
  auto write = storage.BeginWrite(6000);
  CHECK(write && write->state.counts.total == 103);
  CHECK(storage.CompleteWrite(write->id, true, 6001));
  CHECK(storage.UpdateCounts(Ledger(4, 104, {{day - 1, 30}, {day, 74}}, 7000), 7000) == StorageUpdate::Changed);
  CHECK(storage.NextWriteDue() == 7500);  // Successful save starts a new dirty period.
  auto forced = storage.BeginWrite(7001, true);
  CHECK(forced && !storage.BeginWrite(7002, true));
}

void InvalidValuesDoNotReplaceStoredMeaning() {
  StorageState storage(Initial(), 2);
  CHECK(storage.UpdateOffworkDay(day, {true, 0, 1080, 1}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateOffworkDay(day, {true, 172801, 1080, 1}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateOffworkSettings({true, 24, 0}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateAppearance({4, "valid"}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateAppearance({0, "new\nkey=value"}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateWindow({}, 1) == StorageUpdate::Invalid);
  CHECK(storage.UpdateOffworkDay(day, {true, 1, 1080, 1}, 1) == StorageUpdate::Changed);
  CHECK(storage.UpdateOffworkDay(day + 1, {true, 2, 1080, 1}, 2) == StorageUpdate::CapacityExceeded);
  CHECK(storage.current().offworkDays.size() == 2 && storage.current().offworkDays.at(day - 1).seconds == 600);
  CHECK(storage.current().offwork.hour == 18 && storage.current().appearance.selectedPackId == "official.old");
}

void FailedSnapshotAllocationKeepsPending() {
  StorageState storage(Initial());
  CHECK(storage.UpdateGuide({false, false}, 1) == StorageUpdate::Changed);
  failNextAllocation = true;
  bool failed = false;
  try { storage.BeginWrite(1); } catch (const std::bad_alloc&) { failed = true; }
  CHECK(failed && !failNextAllocation && storage.dirty() && !storage.in_flight());
  auto retry = storage.BeginWrite(1);
  CHECK(retry && retry->id == 1 && !retry->state.guide.basicGuideShown);
  CHECK(!storage.CompleteWrite(retry->id + 1, true, 2));
  CHECK(storage.in_flight() && storage.dirty());
  CHECK(storage.CompleteWrite(retry->id, true, 2));
  CHECK(!storage.dirty());
}
}  // namespace

int main() {
  struct Test { const char* name; void (*run)(); };
  const Test tests[] = {
    {"old_ack_keeps_new_dirty", OldAckCannotClearNewCountDirty},
    {"domain_merge_keeps_ui", DomainsMergeWithoutRevertingUi},
    {"one_merged_pending", SlowWriterKeepsOneMergedPending},
    {"complete_ledger_validation", FullLedgerValidationPreservesKnownDays},
    {"stale_source_and_visible_fault", OldSourceDoesNotOverwriteAndFaultIsVisible},
    {"bounded_retry", RetryIsBoundedAndNewDataDoesNotBypassBackoff},
    {"offwork_tombstone", OffworkDeletionSurvivesOldAckAndFailure},
    {"count_save_deadline", CountDebounceHasMaximumDelay},
    {"existing_value_semantics", InvalidValuesDoNotReplaceStoredMeaning},
    {"allocation_keeps_pending", FailedSnapshotAllocationKeepsPending},
  };
  unsigned passed = 0;
  for (const auto& test : tests) {
    try { test.run(); ++passed; std::cout << "PASS " << test.name << '\n'; }
    catch (const std::exception& error) {
      std::cerr << "FAIL " << test.name << ": " << error.what() << '\n';
      return 1;
    }
  }
  std::cout << passed << "/" << (sizeof(tests) / sizeof(tests[0])) << " passed\n";
  return 0;
}
