#pragma once

#include "ledger_snapshot.h"

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <string>

namespace niuma::client::core {

// The existing data.ini key groups. Reminder reservations/consumption live in
// ReminderStore and are deliberately absent: a generic file snapshot must never
// replace or acknowledge those transactions.
enum class StorageDomain : std::size_t {
  Counts, Window, Appearance, Autostart, Guide, OffworkSettings, OffworkDays, Visibility, Count
};
using StorageVersions = std::array<std::uint64_t, static_cast<std::size_t>(StorageDomain::Count)>;

struct StorageCounts {
  std::uint64_t total = 0;                     // [state] total
  std::map<LocalDate, std::uint64_t> daily;     // [daily] YYYY-MM-DD = count
};
struct StorageWindow {
  bool present = false;                      // Missing x/y retains first-run placement.
  std::int32_t x = 0, y = 0;                 // [state] x, y
};
struct StorageAppearance {
  int selectedScene = 0;                     // [state] selected_scene
  std::string selectedPackId;                // [state] selected_pack_id (ASCII)
};
struct StorageAutostart {
  bool configured = false, enabled = true;   // [state] autostart_configured, autostart_enabled
};
struct StorageGuide {
  bool privacyShown = false, basicGuideShown = false;  // Existing [state] flags.
};
struct StorageOffworkSettings {
  bool enabled = false;                     // [offwork] enabled, hour, minute
  int hour = 18, minute = 0;
};
struct StorageOffworkDay {
  // present=false is an explicit deletion, never a recorded zero. Keep the
  // tombstone in the merged model so a failed/in-flight write cannot revive it.
  bool present = false;
  int seconds = 0, targetMinutes = 18 * 60;
  std::int64_t updatedAt = 0;                // seconds,targetMinutes,updatedAt
};
struct StorageFileState {
  StorageCounts counts;
  StorageWindow window;
  StorageAppearance appearance;
  StorageAutostart autostart;
  StorageGuide guide;
  StorageOffworkSettings offwork;
  bool autoHideFullscreen = true;  // [state] auto_hide_fullscreen; manual hide is session-only.
  std::map<LocalDate, StorageOffworkDay> offworkDays;
};

struct StorageWrite {
  std::uint64_t id = 0;
  StorageVersions versions{};
  StorageFileState state;
};
enum class StorageUpdate : std::uint8_t { Changed, Unchanged, Stale, Invalid, CapacityExceeded };

// One control/UI owner only. This is the coalescing model, not a file writer or
// a synchronized queue: never call it from an input hook. It retains the latest
// complete state (one pending item) and at most one immutable in-flight copy.
// An IO worker gets only the immutable StorageWrite and returns its id/result.
// CompleteWrite must run back on the same control owner.
//
// File adapter requirements: preload every valid historical date before use;
// preserve the original document's unknown keys/sections and encoding; update
// these known keys without treating omitted/unknown keys as deletions. A full
// atomic file write, validation and durable replacement must ALL succeed before
// passing success=true. Do not mix the adapter with Win32 profile writes.
class StorageState {
 public:
  static constexpr std::uint64_t kCountIdleMs = 500;
  static constexpr std::uint64_t kCountMaximumDelayMs = 5000;
  static constexpr std::uint64_t kOffworkHistoryDelayMs = 60000;
  static constexpr std::uint64_t kMaximumRetryDelayMs = 30000;

  explicit StorageState(StorageFileState initial,
                        std::size_t dateCapacity = InputCore::kMaximumDayCapacity);

  StorageUpdate UpdateCounts(const LedgerSnapshotResult& ledger, std::uint64_t nowMs);
  StorageUpdate UpdateWindow(StorageWindow value, std::uint64_t nowMs);
  StorageUpdate UpdateAppearance(StorageAppearance value, std::uint64_t nowMs);
  StorageUpdate UpdateAutostart(StorageAutostart value, std::uint64_t nowMs);
  StorageUpdate UpdateGuide(StorageGuide value, std::uint64_t nowMs);
  StorageUpdate UpdateAutoHideFullscreen(bool value, std::uint64_t nowMs);
  StorageUpdate UpdateOffworkSettings(StorageOffworkSettings value, std::uint64_t nowMs);
  StorageUpdate UpdateOffworkDay(LocalDate date, StorageOffworkDay value, std::uint64_t nowMs);

  // Returns null when clean, busy, or not yet due. Force is for explicit flush /
  // orderly shutdown; it never starts a second in-flight write. A thrown memory
  // allocation leaves the pending data and dirty versions intact.
  std::shared_ptr<const StorageWrite> BeginWrite(std::uint64_t nowMs, bool force = false);
  // Unknown/duplicate/stale ids do nothing. Failure retains the latest merged
  // data for retry. Even a successful old write confirms only its own versions.
  // Completion means this IO attempt has STOPPED touching the file. A timeout
  // alone is not completion: retain in-flight until the worker finishes, or a
  // late old writer could overwrite a newer retry. Exit may report unsaved data.
  bool CompleteWrite(std::uint64_t id, bool success, std::uint64_t nowMs) noexcept;

  const StorageFileState& current() const noexcept { return current_; }
  const StorageVersions& versions() const noexcept { return versions_; }
  const StorageVersions& saved_versions() const noexcept { return saved_; }
  bool dirty(StorageDomain domain) const noexcept;
  bool dirty() const noexcept;
  bool has_pending() const noexcept;
  bool in_flight() const noexcept { return static_cast<bool>(inFlight_); }
  bool save_failed() const noexcept { return failures_ != 0; }
  unsigned consecutive_failures() const noexcept { return failures_; }
  // Returns UINT64_MAX when clean or waiting for an in-flight completion.
  std::uint64_t NextWriteDue() const noexcept;
  InputFault accounting_fault() const noexcept { return accountingFault_; }
  std::uint64_t unaccounted_operations() const noexcept { return unaccountedOperations_; }

 private:
  static std::size_t Index(StorageDomain domain) noexcept { return static_cast<std::size_t>(domain); }
  bool CanChange(StorageDomain domain) const noexcept;
  void Changed(StorageDomain domain, std::uint64_t nowMs) noexcept;

  StorageFileState current_;
  StorageVersions versions_{};
  StorageVersions saved_{};
  StorageVersions firstDirtyMs_{};
  std::shared_ptr<const StorageWrite> inFlight_;
  std::size_t dateCapacity_;
  std::uint64_t nextWriteId_ = 1;
  std::uint64_t sourceEpoch_ = 0, sourceVersion_ = 0, lastCountInputMs_ = 0;
  std::uint64_t retryAtMs_ = 0;
  unsigned failures_ = 0;
  InputFault accountingFault_ = InputFault::None;
  std::uint64_t unaccountedOperations_ = 0;
};

}  // namespace niuma::client::core
