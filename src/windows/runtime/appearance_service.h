#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "../appearance_pack.h"
#include "appearance_scene.h"

#include <cstdint>
#include <memory>
#ifdef NIUMA_APPEARANCE_SERVICE_DIAGNOSTICS
#include <functional>
#endif

namespace niuma::windows::runtime {

enum class AppearanceLoadKind : std::uint8_t { Current, Thumbnail, GpuCurrent, Woodfish };

struct AppearanceLoadRequest {
  std::uint64_t id = 0;          // Increasing across this service's submissions.
  std::uint64_t generation = 0;  // UI selection/catalog generation; echoed, never inferred.
  AppearanceLoadKind kind = AppearanceLoadKind::Current;
  niuma::AppearanceResourceRequest source;
  niuma::AppearanceAnimationOptions animationOptions;
};

struct AppearanceLoadResult {
  // This is an immutable copy; neither the loader nor UI owns a mutable alias.
  std::shared_ptr<const AppearanceLoadRequest> request;
  niuma::AppearancePreparationStatus status = niuma::AppearancePreparationStatus::Invalid;
  DWORD error = ERROR_SUCCESS;
  DWORD notificationError = ERROR_SUCCESS;
  std::wstring detail;
  std::unique_ptr<niuma::AppearancePack> animation;
  std::unique_ptr<niuma::AppearanceThumbnail> thumbnail;
  std::unique_ptr<PreparedAppearanceScene> scene;
  niuma::AppearanceResourceMemory memory;
  bool Matches(const AppearanceLoadRequest& expected) const noexcept;
  bool ready() const noexcept;
};

struct AppearanceServiceOptions {
  HWND notificationWindow = nullptr;
  UINT notificationMessage = 0;
#ifdef NIUMA_APPEARANCE_SERVICE_DIAGNOSTICS
  // Queue/lifetime tests only. Production always uses PrepareAppearance*.
  std::function<void(const AppearanceLoadRequest&, AppearanceLoadResult&)> loader;
#endif
};

struct AppearanceServiceStart { bool started = false; DWORD error = ERROR_SUCCESS; };
enum class AppearanceSubmit : std::uint8_t {
  Queued, Replaced, LowerPriority, Stale, Invalid, Stopping, NotStarted, NoMemory
};
struct AppearanceSubmitResult {
  AppearanceSubmit status = AppearanceSubmit::Invalid;
  std::uint64_t replacedId = 0;
  bool accepted() const noexcept {
    return status == AppearanceSubmit::Queued || status == AppearanceSubmit::Replaced;
  }
};
struct AppearanceServiceSnapshot {
  bool running = false, stopping = false, stopped = false;
  std::uint64_t activeId = 0, pendingId = 0, readyId = 0;
  std::uint64_t completed = 0, replaced = 0, discardedPendingId = 0;
  DWORD workerThreadId = 0;
  std::size_t readyResourceBytes = 0;
};
struct AppearanceServiceStop {
  bool stopped = false;
  std::uint64_t activeId = 0, discardedPendingId = 0;
  bool hasResult = false;  // Consume separately; stopping never drops a completed resource.
};

// One UI/control owner. Exactly one active preparation and at most one pending
// request. An unconsumed result blocks the next load, bounding retained results.
// New current requests replace any pending request; thumbnails cannot replace a
// pending current request. Loading/PNG decode is exclusively on the worker.
// The caller keeps GDI+ initialized and the notification HWND alive until Stop
// reports stopped. On completion, compare Matches(currentExpected) before using
// the exclusively owned resource; stale results are simply destroyed by the UI.
class AppearanceService final {
 public:
  AppearanceService();
  ~AppearanceService();
  AppearanceService(const AppearanceService&) = delete;
  AppearanceService& operator=(const AppearanceService&) = delete;

  AppearanceServiceStart Start(const AppearanceServiceOptions& options = {});
  AppearanceSubmitResult TrySubmit(const AppearanceLoadRequest& request) noexcept;
  bool TryConsumeResult(AppearanceLoadResult& result) noexcept;
  AppearanceServiceSnapshot Snapshot() const noexcept;
  // Discards only work that has not started, reporting its id. Active IO is
  // never claimed cancelled. Stop(0) just requests shutdown and polls; no detach.
  // INFINITE is treated as a zero wait. After stopped, consume any final result.
  // The destructor joins as a misuse-safety fallback, never as the UI exit path.
  AppearanceServiceStop Stop(DWORD timeoutMs = 0) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace niuma::windows::runtime
