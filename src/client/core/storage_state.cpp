#include "storage_state.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>

namespace niuma::client::core {
namespace {
constexpr auto never = std::numeric_limits<std::uint64_t>::max();
std::uint64_t Plus(std::uint64_t value, std::uint64_t delta) noexcept {
  return value > never - delta ? never : value + delta;
}
bool Valid(const StorageAppearance& value) {
  return value.selectedScene >= 0 && value.selectedScene <= 3 &&
      std::all_of(value.selectedPackId.begin(), value.selectedPackId.end(),
                  [](unsigned char c) { return c >= 32 && c < 127; });
}
bool Valid(const StorageOffworkSettings& value) {
  return value.hour >= 0 && value.hour < 24 && value.minute >= 0 && value.minute < 60;
}
bool Valid(const StorageOffworkDay& value) {
  return !value.present || (value.seconds > 0 && value.seconds <= 172800 &&
      value.targetMinutes >= 0 && value.targetMinutes < 1440 && value.updatedAt > 0);
}
bool Same(const StorageOffworkDay& a, const StorageOffworkDay& b) {
  return a.present == b.present && (!a.present || (a.seconds == b.seconds &&
      a.targetMinutes == b.targetMinutes && a.updatedAt == b.updatedAt));
}
}  // namespace

StorageState::StorageState(StorageFileState initial, std::size_t dateCapacity)
    : current_(std::move(initial)), dateCapacity_(dateCapacity) {
  if (!dateCapacity_ || dateCapacity_ > InputCore::kMaximumDayCapacity ||
      current_.counts.daily.size() > dateCapacity_ || current_.offworkDays.size() > dateCapacity_ ||
      !Valid(current_.appearance) || !Valid(current_.offwork))
    throw std::invalid_argument("Invalid initial storage state or date capacity");
  for (const auto& entry : current_.counts.daily)
    if (!InputCore::ValidDate(entry.first)) throw std::invalid_argument("Invalid daily date");
  for (const auto& entry : current_.offworkDays)
    if (!InputCore::ValidDate(entry.first) || !Valid(entry.second))
      throw std::invalid_argument("Invalid offwork record");
}

bool StorageState::dirty(StorageDomain domain) const noexcept {
  return versions_[Index(domain)] != saved_[Index(domain)];
}
bool StorageState::dirty() const noexcept { return versions_ != saved_; }
bool StorageState::has_pending() const noexcept {
  return dirty() && (!inFlight_ || versions_ != inFlight_->versions);
}
bool StorageState::CanChange(StorageDomain domain) const noexcept {
  return versions_[Index(domain)] != never;
}
void StorageState::Changed(StorageDomain domain, std::uint64_t nowMs) noexcept {
  if (!dirty(domain)) firstDirtyMs_[Index(domain)] = nowMs;
  ++versions_[Index(domain)];
}

StorageUpdate StorageState::UpdateCounts(const LedgerSnapshotResult& ledger, std::uint64_t nowMs) {
  const auto& input = ledger.header.input;
  if (ledger.header.status != LedgerResultStatus::Complete || !input.ready ||
      !input.version || !input.epoch || ledger.header.dailyCount != ledger.daily.size() ||
      !InputCore::ValidDate(input.date) || input.lastInputMs > nowMs)
    return StorageUpdate::Invalid;
  if (input.epoch < sourceEpoch_ || (input.epoch == sourceEpoch_ && input.version < sourceVersion_))
    return StorageUpdate::Stale;
  if (ledger.daily.size() > dateCapacity_) return StorageUpdate::CapacityExceeded;
  std::map<LocalDate, std::uint64_t> daily;
  for (const auto& entry : ledger.daily) {
    if (!InputCore::ValidDate(entry.date) || !daily.emplace(entry.date, entry.total).second)
      return StorageUpdate::Invalid;
  }
  const auto today = daily.find(input.date);
  if (today == daily.end() || today->second != input.today || input.total < current_.counts.total)
    return StorageUpdate::Invalid;
  // A "full" ledger that drops an older day is rejected rather than silently
  // accepting the latest today value as a replacement for historical records.
  for (const auto& old : current_.counts.daily) {
    const auto found = daily.find(old.first);
    if (found == daily.end() || found->second < old.second) return StorageUpdate::Invalid;
  }
  const bool changed = input.total != current_.counts.total || daily != current_.counts.daily;
  if (input.epoch == sourceEpoch_ && input.version == sourceVersion_ && changed)
    return StorageUpdate::Invalid;
  if (changed && !CanChange(StorageDomain::Counts)) return StorageUpdate::CapacityExceeded;
  if (changed) {
    current_.counts.daily = std::move(daily);
    current_.counts.total = input.total;
    Changed(StorageDomain::Counts, nowMs);
  }
  sourceEpoch_ = input.epoch;
  sourceVersion_ = input.version;
  lastCountInputMs_ = input.lastInputMs;
  accountingFault_ = input.fault;
  unaccountedOperations_ = input.unaccountedOperations;
  return changed ? StorageUpdate::Changed : StorageUpdate::Unchanged;
}

StorageUpdate StorageState::UpdateWindow(StorageWindow value, std::uint64_t nowMs) {
  if (!value.present) return StorageUpdate::Invalid;  // No product action deletes placement.
  const auto& old = current_.window;
  if (old.present && value.x == old.x && value.y == old.y) return StorageUpdate::Unchanged;
  if (!CanChange(StorageDomain::Window)) return StorageUpdate::CapacityExceeded;
  current_.window = value;
  Changed(StorageDomain::Window, nowMs);
  return StorageUpdate::Changed;
}
StorageUpdate StorageState::UpdateAppearance(StorageAppearance value, std::uint64_t nowMs) {
  if (!Valid(value)) return StorageUpdate::Invalid;
  const auto& old = current_.appearance;
  if (old.selectedScene == value.selectedScene && old.selectedPackId == value.selectedPackId)
    return StorageUpdate::Unchanged;
  if (!CanChange(StorageDomain::Appearance)) return StorageUpdate::CapacityExceeded;
  current_.appearance = std::move(value);
  Changed(StorageDomain::Appearance, nowMs);
  return StorageUpdate::Changed;
}
StorageUpdate StorageState::UpdateAutostart(StorageAutostart value, std::uint64_t nowMs) {
  const auto& old = current_.autostart;
  if (old.configured == value.configured && old.enabled == value.enabled) return StorageUpdate::Unchanged;
  if (!CanChange(StorageDomain::Autostart)) return StorageUpdate::CapacityExceeded;
  current_.autostart = value;
  Changed(StorageDomain::Autostart, nowMs);
  return StorageUpdate::Changed;
}
StorageUpdate StorageState::UpdateGuide(StorageGuide value, std::uint64_t nowMs) {
  const auto& old = current_.guide;
  if (old.privacyShown == value.privacyShown && old.basicGuideShown == value.basicGuideShown)
    return StorageUpdate::Unchanged;
  if (!CanChange(StorageDomain::Guide)) return StorageUpdate::CapacityExceeded;
  current_.guide = value;
  Changed(StorageDomain::Guide, nowMs);
  return StorageUpdate::Changed;
}
StorageUpdate StorageState::UpdateOffworkSettings(StorageOffworkSettings value, std::uint64_t nowMs) {
  if (!Valid(value)) return StorageUpdate::Invalid;
  const auto& old = current_.offwork;
  if (old.enabled == value.enabled && old.hour == value.hour && old.minute == value.minute)
    return StorageUpdate::Unchanged;
  if (!CanChange(StorageDomain::OffworkSettings)) return StorageUpdate::CapacityExceeded;
  current_.offwork = value;
  Changed(StorageDomain::OffworkSettings, nowMs);
  return StorageUpdate::Changed;
}
StorageUpdate StorageState::UpdateOffworkDay(LocalDate date, StorageOffworkDay value,
                                           std::uint64_t nowMs) {
  if (!InputCore::ValidDate(date) || !Valid(value)) return StorageUpdate::Invalid;
  const auto old = current_.offworkDays.find(date);
  if (old != current_.offworkDays.end() && Same(old->second, value)) return StorageUpdate::Unchanged;
  if ((old == current_.offworkDays.end() && current_.offworkDays.size() >= dateCapacity_) ||
      !CanChange(StorageDomain::OffworkDays)) return StorageUpdate::CapacityExceeded;
  current_.offworkDays.insert_or_assign(date, value);
  Changed(StorageDomain::OffworkDays, nowMs);
  return StorageUpdate::Changed;
}

std::uint64_t StorageState::NextWriteDue() const noexcept {
  if (!dirty() || inFlight_) return never;
  auto due = never;
  for (std::size_t i = 0; i < versions_.size(); ++i) {
    if (versions_[i] == saved_[i]) continue;
    auto domainDue = firstDirtyMs_[i];
    if (i == Index(StorageDomain::Counts))
      domainDue = std::min(Plus(lastCountInputMs_, kCountIdleMs),
                           Plus(firstDirtyMs_[i], kCountMaximumDelayMs));
    else if (i == Index(StorageDomain::OffworkDays))
      domainDue = Plus(firstDirtyMs_[i], kOffworkHistoryDelayMs);
    due = std::min(due, domainDue);
  }
  return std::max(due, retryAtMs_);
}

std::shared_ptr<const StorageWrite> StorageState::BeginWrite(std::uint64_t nowMs, bool force) {
  if (!dirty() || inFlight_ || (!force && nowMs < NextWriteDue())) return {};
  if (!nextWriteId_) throw std::overflow_error("Storage write ids exhausted");
  auto write = std::make_shared<StorageWrite>();
  write->state = current_;
  write->versions = versions_;
  write->id = nextWriteId_++;
  inFlight_ = std::move(write);
  return inFlight_;
}

bool StorageState::CompleteWrite(std::uint64_t id, bool success, std::uint64_t nowMs) noexcept {
  if (!inFlight_ || inFlight_->id != id) return false;
  if (success) {
    saved_ = inFlight_->versions;
    failures_ = 0;
    retryAtMs_ = 0;
  } else {
    if (failures_ != std::numeric_limits<unsigned>::max()) ++failures_;
    const auto delay = std::min(kMaximumRetryDelayMs,
        std::uint64_t{1000} << std::min(failures_ - 1, 5u));
    retryAtMs_ = Plus(nowMs, delay);
  }
  inFlight_.reset();
  return true;
}

}  // namespace niuma::client::core
