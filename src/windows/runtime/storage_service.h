#pragma once

#include "../../client/core/storage_state.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <cstdint>
#include <memory>
#include <string>

namespace niuma::windows::runtime {

enum class StorageFileStage : std::uint8_t {
  None, Open, Read, Parse, Backup, Prepare, Validate, Flush, Replace, Verify, Worker
};

struct StorageServiceOptions {
  std::wstring path;  // Existing absolute data.ini path; parent directory must exist.
  HWND notificationWindow = nullptr;
  UINT notificationMessage = 0;
};
struct StorageServiceStart {
  bool started = false;
  bool existed = false;
  DWORD error = ERROR_SUCCESS;
  StorageFileStage stage = StorageFileStage::None;
  client::core::StorageFileState initial;
};
struct StorageFileResult {
  std::uint64_t id = 0;
  bool success = false;
  // A replacement may already be visible when its final flush/read fails.
  // This remains an unsuccessful, stopped attempt; retry the latest snapshot.
  bool replacementOccurred = false;
  DWORD error = ERROR_SUCCESS;
  DWORD notificationError = ERROR_SUCCESS;
  StorageFileStage stage = StorageFileStage::None;
};
enum class StorageSubmit : std::uint8_t { Accepted, Busy, Stopping, NotStarted, Invalid, Stale };
struct StorageServiceStop {
  bool stopped = false;
  std::uint64_t pendingId = 0;
  bool hasResult = false;
  StorageFileResult result;
};

// Start/submit/consume/stop have one UI/control owner. Start performs one full
// preload on the worker before returning; subsequent file IO is worker-only.
// All data.ini writers (including guide/autostart/offwork settings) must use
// this service. Never mix it with profile writes to the live path. ReminderStore
// remains independent. The application retains its existing single-instance lock.
//
// One immutable request/result slot: an unconsumed completion still occupies
// the slot. No growing work queue and no cancellation-based overlapping retry.
class StorageService {
 public:
  StorageService();
  ~StorageService();
  StorageService(const StorageService&) = delete;
  StorageService& operator=(const StorageService&) = delete;

  StorageServiceStart Start(const StorageServiceOptions& options);
  StorageSubmit TrySubmit(std::shared_ptr<const client::core::StorageWrite> write) noexcept;
  bool TryConsumeResult(StorageFileResult& result) noexcept;
  // Requests orderly shutdown and waits at most timeoutMs (INFINITE prohibited).
  // Pending is NOT a cancelled/failed write. Keep the object and notification
  // HWND alive, then consume/poll again. Only stopped permits their destruction.
  // A stopped return consumes any remaining result into hasResult/result.
  // Destructor joins as a misuse-safety fallback; normal UI exit must never
  // rely on destruction to wait for blocked IO.
  StorageServiceStop Stop(DWORD timeoutMs = 5000) noexcept;
  bool running() const noexcept;
  // Planned backup path, stable after Start. The file is created only when an
  // existing data.ini is first replaced; its original bytes are never rewritten.
  const std::wstring& backup_path() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace niuma::windows::runtime
