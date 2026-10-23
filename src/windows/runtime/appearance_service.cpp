#include "appearance_service.h"

#include <objbase.h>

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <mutex>
#include <new>
#include <optional>
#include <thread>
#include <utility>

namespace niuma::windows::runtime {
namespace {
bool SameSource(const niuma::AppearanceResourceRequest& a,
                const niuma::AppearanceResourceRequest& b) noexcept {
  return a.sourcePath == b.sourcePath && a.id == b.id &&
      a.contentFingerprint == b.contentFingerprint;
}
bool ValidRequest(const AppearanceLoadRequest& request) noexcept {
  return request.id && request.generation && !request.source.sourcePath.empty() &&
      request.source.sourcePath.size() <= 32767 && !request.source.id.empty() &&
      request.source.id.size() <= 256 && !request.source.contentFingerprint.empty() &&
      request.source.contentFingerprint.size() <= 256 &&
      (request.kind == AppearanceLoadKind::Current || request.kind == AppearanceLoadKind::Thumbnail) &&
      std::isfinite(request.animationOptions.pixelDensity) && request.animationOptions.pixelDensity > 0 &&
      request.animationOptions.byteLimit > 0;
}
DWORD PreparationError(niuma::AppearancePreparationStatus status) noexcept {
  switch (status) {
    case niuma::AppearancePreparationStatus::Ready: return ERROR_SUCCESS;
    case niuma::AppearancePreparationStatus::Changed: return ERROR_FILE_INVALID;
    case niuma::AppearancePreparationStatus::BudgetExceeded: return ERROR_NOT_ENOUGH_MEMORY;
    default: return ERROR_INVALID_DATA;
  }
}
void Prepare(const AppearanceLoadRequest& request, AppearanceLoadResult& output) {
  if (request.kind == AppearanceLoadKind::Current) {
    output.status = niuma::PrepareAppearanceAnimation(request.source, request.animationOptions,
        &output.animation, &output.memory, &output.detail);
  } else {
    output.status = niuma::PrepareAppearanceThumbnail(request.source, &output.thumbnail, &output.detail);
    if (output.thumbnail) output.memory = output.thumbnail->memory;
  }
}
bool ValidResource(const AppearanceLoadRequest& request, const AppearanceLoadResult& result) noexcept {
  if (request.kind == AppearanceLoadKind::Current)
    return result.animation && !result.thumbnail && result.animation->id == request.source.id &&
        result.animation->contentFingerprint == request.source.contentFingerprint;
  return result.thumbnail && !result.animation && SameSource(result.thumbnail->source, request.source);
}
}  // namespace

bool AppearanceLoadResult::Matches(const AppearanceLoadRequest& expected) const noexcept {
  return request && request->id == expected.id && request->generation == expected.generation &&
      request->kind == expected.kind && SameSource(request->source, expected.source) &&
      request->animationOptions.pixelDensity == expected.animationOptions.pixelDensity &&
      request->animationOptions.byteLimit == expected.animationOptions.byteLimit &&
      request->animationOptions.retainSourcePixels == expected.animationOptions.retainSourcePixels;
}
bool AppearanceLoadResult::ready() const noexcept {
  return request && status == niuma::AppearancePreparationStatus::Ready && error == ERROR_SUCCESS &&
      ValidResource(*request, *this);
}

struct AppearanceService::Impl {
  AppearanceServiceOptions options;
  mutable std::mutex mutex;
  std::condition_variable wake;
  std::thread worker;
  bool attempted = false, started = false, stopping = false, stopped = false;
  std::shared_ptr<const AppearanceLoadRequest> pending, active;
  std::optional<AppearanceLoadResult> result;
  std::uint64_t lastId = 0, completed = 0, replaced = 0, discardedPendingId = 0;
  DWORD workerThreadId = 0;

  void Run() noexcept {
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::unique_lock<std::mutex> lock(mutex);
    workerThreadId = GetCurrentThreadId();
    for (;;) {
      wake.wait(lock, [&] { return stopping || (pending && !result); });
      if (stopping) break;
      active = std::move(pending);
      const auto request = active;
      lock.unlock();
      AppearanceLoadResult output;
      try {
        if (FAILED(com)) {
          output.error = static_cast<DWORD>(com);
          output.detail = L"Appearance worker COM initialization failed.";
        } else {
#ifdef NIUMA_APPEARANCE_SERVICE_DIAGNOSTICS
          if (options.loader) options.loader(*request, output);
          else
#endif
          Prepare(*request, output);
          if (output.status == niuma::AppearancePreparationStatus::Ready && !ValidResource(*request, output)) {
            output.status = niuma::AppearancePreparationStatus::Invalid;
            output.detail = L"Prepared appearance identity or resource kind did not match the request.";
          }
          if (!output.error) output.error = PreparationError(output.status);
        }
      } catch (const std::bad_alloc&) {
        output.status = niuma::AppearancePreparationStatus::BudgetExceeded;
        output.error = ERROR_NOT_ENOUGH_MEMORY;
      } catch (...) {
        output.status = niuma::AppearancePreparationStatus::Invalid;
        output.error = ERROR_GEN_FAILURE;
      }
      output.request = request;
      if (output.error || output.status != niuma::AppearancePreparationStatus::Ready) {
        output.animation.reset(); output.thumbnail.reset(); output.memory = {};
      }
      lock.lock();
      active.reset();
      result.emplace(std::move(output));
      ++completed;
      if (options.notificationWindow && !PostMessageW(options.notificationWindow,
          options.notificationMessage, 0, 0)) result->notificationError = GetLastError();
      wake.notify_all();
    }
    lock.unlock();
    if (SUCCEEDED(com)) CoUninitialize();
    lock.lock();
    started = false; stopped = true; wake.notify_all();
  }
};

AppearanceService::AppearanceService() : impl_(std::make_unique<Impl>()) {}
AppearanceService::~AppearanceService() {
  Stop(0);
  if (impl_->worker.joinable()) impl_->worker.join();
}

AppearanceServiceStart AppearanceService::Start(const AppearanceServiceOptions& options) {
  auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  if (self.attempted || self.stopping) return {false, ERROR_ALREADY_INITIALIZED};
  self.attempted = true;
  if ((options.notificationWindow && options.notificationMessage < WM_APP) ||
      (!options.notificationWindow && options.notificationMessage)) return {false, ERROR_INVALID_PARAMETER};
  try {
    self.options = options;
    self.started = true;
    self.worker = std::thread([&self] { self.Run(); });
  } catch (...) {
    self.started = false; self.stopped = true;
    return {false, ERROR_NOT_ENOUGH_MEMORY};
  }
  return {true, ERROR_SUCCESS};
}

AppearanceSubmitResult AppearanceService::TrySubmit(const AppearanceLoadRequest& request) noexcept {
  auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  if (self.stopping) return {AppearanceSubmit::Stopping};
  if (!self.started) return {AppearanceSubmit::NotStarted};
  if (!ValidRequest(request)) return {AppearanceSubmit::Invalid};
  if (request.id <= self.lastId) return {AppearanceSubmit::Stale};
  if (self.pending && self.pending->kind == AppearanceLoadKind::Current &&
      request.kind == AppearanceLoadKind::Thumbnail) return {AppearanceSubmit::LowerPriority};
  try {
    auto frozen = std::make_shared<const AppearanceLoadRequest>(request);
    const auto replacedId = self.pending ? self.pending->id : 0;
    self.pending = std::move(frozen);
    self.lastId = request.id;
    if (replacedId) ++self.replaced;
    self.wake.notify_one();
    return {replacedId ? AppearanceSubmit::Replaced : AppearanceSubmit::Queued, replacedId};
  } catch (const std::bad_alloc&) { return {AppearanceSubmit::NoMemory}; }
    catch (...) { return {AppearanceSubmit::Invalid}; }
}

bool AppearanceService::TryConsumeResult(AppearanceLoadResult& result) noexcept {
  auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  if (!self.result) return false;
  result = std::move(*self.result);
  self.result.reset();
  self.wake.notify_one();
  return true;
}

AppearanceServiceSnapshot AppearanceService::Snapshot() const noexcept {
  const auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  AppearanceServiceSnapshot output;
  output.running = self.started && !self.stopping;
  output.stopping = self.stopping; output.stopped = self.stopped;
  output.activeId = self.active ? self.active->id : 0;
  output.pendingId = self.pending ? self.pending->id : 0;
  output.readyId = self.result && self.result->request ? self.result->request->id : 0;
  output.completed = self.completed; output.replaced = self.replaced;
  output.discardedPendingId = self.discardedPendingId;
  output.workerThreadId = self.workerThreadId;
  output.readyResourceBytes = self.result ? self.result->memory.residentBytes() : 0;
  return output;
}

AppearanceServiceStop AppearanceService::Stop(DWORD timeoutMs) noexcept {
  auto& self = *impl_;
  std::unique_lock<std::mutex> lock(self.mutex);
  self.stopping = true;
  if (self.pending) { self.discardedPendingId = self.pending->id; self.pending.reset(); }
  self.wake.notify_all();
  if (!self.worker.joinable()) self.stopped = true;
  if (!self.stopped && timeoutMs && timeoutMs != INFINITE)
    self.wake.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return self.stopped; });
  AppearanceServiceStop output;
  output.stopped = self.stopped;
  output.activeId = self.active ? self.active->id : 0;
  output.discardedPendingId = self.discardedPendingId;
  output.hasResult = self.result.has_value();
  lock.unlock();
  if (output.stopped && self.worker.joinable()) self.worker.join();
  return output;
}

}  // namespace niuma::windows::runtime
