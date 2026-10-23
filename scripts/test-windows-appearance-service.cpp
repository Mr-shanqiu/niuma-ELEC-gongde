#include "../src/windows/runtime/appearance_service.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <new>
#include <stdexcept>
#include <vector>

#ifndef NIUMA_APPEARANCE_SERVICE_DIAGNOSTICS
#error This queue/lifetime test requires the diagnostic loader injection.
#endif

namespace {
using namespace niuma;
using namespace niuma::windows::runtime;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

// No image bytes are decoded in this suite. The counted COM stream gives the
// real PackImage destructor an owned resource to release after UI handoff.
class TrackedStream final : public IStream {
 public:
  explicit TrackedStream(std::atomic<unsigned>& released) : released_(released) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** out) override {
    if (out) *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining = --references_;
    if (!remaining) { ++released_; delete this; }
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE Read(void*, ULONG, ULONG*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Write(const void*, ULONG, ULONG*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER, DWORD, ULARGE_INTEGER*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Revert() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG*, DWORD) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Clone(IStream**) override { return E_NOTIMPL; }
 private:
  std::atomic<ULONG> references_{1};
  std::atomic<unsigned>& released_;
};

AppearanceLoadRequest Request(std::uint64_t id, AppearanceLoadKind kind = AppearanceLoadKind::Current) {
  AppearanceLoadRequest request;
  request.id = id; request.generation = 10 + id; request.kind = kind;
  request.source = {L"C:\\isolated-fixture\\appearance.niugong", "official.test", std::string(64, 'a')};
  return request;
}
void Prepared(const AppearanceLoadRequest& request, AppearanceLoadResult& result,
              std::atomic<unsigned>& released) {
  result.status = AppearancePreparationStatus::Ready;
  if (request.kind == AppearanceLoadKind::Current) {
    result.animation = std::make_unique<AppearancePack>();
    result.animation->id = request.source.id;
    result.animation->contentFingerprint = request.source.contentFingerprint;
    result.animation->preview.stream = new TrackedStream(released);
    result.memory.sourceRgbaBytes = 4;
  } else {
    result.thumbnail = std::make_unique<AppearanceThumbnail>();
    result.thumbnail->source = request.source;
    result.thumbnail->image.stream = new TrackedStream(released);
    result.thumbnail->memory.thumbnailBytes = 4;
    result.memory = result.thumbnail->memory;
  }
}
struct Gate {
  std::mutex mutex;
  std::condition_variable wake;
  bool open = false;
  std::vector<std::uint64_t> entered;
  void Enter(std::uint64_t id) {
    std::unique_lock<std::mutex> lock(mutex);
    entered.push_back(id); wake.notify_all();
    wake.wait(lock, [&] { return open; });
  }
  void Open() { std::lock_guard<std::mutex> lock(mutex); open = true; wake.notify_all(); }
  void Await(std::uint64_t id) {
    std::unique_lock<std::mutex> lock(mutex);
    CHECK(wake.wait_for(lock, std::chrono::seconds(5), [&] { return !entered.empty() && entered.back() == id; }));
  }
  std::vector<std::uint64_t> Calls() { std::lock_guard<std::mutex> lock(mutex); return entered; }
};
struct Unblock { Gate& gate; ~Unblock() { gate.Open(); } };

void AwaitReady(AppearanceService& service, std::uint64_t id) {
  const auto deadline = GetTickCount64() + 5000;
  while (service.Snapshot().readyId != id) { CHECK(GetTickCount64() < deadline); Sleep(1); }
}
AppearanceLoadResult Consume(AppearanceService& service, std::uint64_t id) {
  AwaitReady(service, id);
  AppearanceLoadResult result;
  CHECK(service.TryConsumeResult(result));
  CHECK(result.request && result.request->id == id);
  return result;
}
void Stop(AppearanceService& service) {
  const auto deadline = GetTickCount64() + 5000;
  while (!service.Stop(0).stopped) { CHECK(GetTickCount64() < deadline); Sleep(1); }
}

void BoundedLatestPriorityAndImmutableRequest() {
  std::atomic<unsigned> released{0};
  Gate gate;
  AppearanceService service;
  Unblock unblock{gate};
  AppearanceServiceOptions options;
  options.loader = [&](const AppearanceLoadRequest& request, AppearanceLoadResult& output) {
    gate.Enter(request.id); Prepared(request, output, released);
  };
  CHECK(service.Start(options).started);
  auto first = Request(1, AppearanceLoadKind::Thumbnail);
  const auto original = first;
  CHECK(service.TrySubmit(first).accepted());
  first.source.id = "mutated-after-submit";
  first.source.contentFingerprint = "different";
  gate.Await(1);
  CHECK(service.Snapshot().workerThreadId != GetCurrentThreadId());
  CHECK(service.TrySubmit(Request(2, AppearanceLoadKind::Thumbnail)).status == AppearanceSubmit::Queued);
  auto replacement = service.TrySubmit(Request(3, AppearanceLoadKind::Thumbnail));
  CHECK(replacement.status == AppearanceSubmit::Replaced && replacement.replacedId == 2);
  replacement = service.TrySubmit(Request(4));
  CHECK(replacement.status == AppearanceSubmit::Replaced && replacement.replacedId == 3);
  CHECK(service.TrySubmit(Request(5, AppearanceLoadKind::Thumbnail)).status == AppearanceSubmit::LowerPriority);
  const auto latest = Request(6);
  replacement = service.TrySubmit(latest);
  CHECK(replacement.status == AppearanceSubmit::Replaced && replacement.replacedId == 4);
  CHECK(service.TrySubmit(Request(4)).status == AppearanceSubmit::Stale);
  const auto busy = service.Snapshot();
  CHECK(busy.activeId == 1 && busy.pendingId == 6 && busy.readyId == 0 && busy.replaced == 3);
  gate.Open();
  AwaitReady(service, 1);
  Sleep(20);
  CHECK(gate.Calls() == std::vector<std::uint64_t>{1});
  CHECK(service.Snapshot().pendingId == 6 && service.Snapshot().activeId == 0);
  auto stale = Consume(service, 1);
  CHECK(stale.ready() && stale.Matches(original) && !stale.Matches(first) && !stale.Matches(latest));
  CHECK(released == 0);
  stale = {}; // The UI rejects the stale generation and releases its resource.
  CHECK(released == 1);
  auto current = Consume(service, 6);
  CHECK(current.ready() && current.Matches(latest));
  auto changed = latest; ++changed.generation;
  CHECK(!current.Matches(changed));
  changed = latest; changed.source.contentFingerprint[0] = 'b';
  CHECK(!current.Matches(changed));
  changed = latest; changed.animationOptions.retainSourcePixels = !latest.animationOptions.retainSourcePixels;
  CHECK(!current.Matches(changed));
  CHECK(gate.Calls() == (std::vector<std::uint64_t>{1, 6}));
  current = {}; CHECK(released == 2);
  Stop(service);
}

void StopDoesNotCancelOrDetachActiveLoad() {
  std::atomic<unsigned> released{0};
  Gate gate;
  AppearanceService service;
  Unblock unblock{gate};
  AppearanceServiceOptions options;
  options.loader = [&](const AppearanceLoadRequest& request, AppearanceLoadResult& output) {
    gate.Enter(request.id); Prepared(request, output, released);
  };
  CHECK(service.Start(options).started);
  const auto active = Request(11);
  CHECK(service.TrySubmit(active).accepted());
  gate.Await(11);
  CHECK(service.TrySubmit(Request(12)).accepted());
  const auto before = GetTickCount64();
  const auto stopping = service.Stop(0);
  CHECK(GetTickCount64() - before < 250);
  CHECK(!stopping.stopped && stopping.activeId == 11 && stopping.discardedPendingId == 12);
  CHECK(service.Snapshot().pendingId == 0 && service.Snapshot().completed == 0);
  CHECK(service.TrySubmit(Request(13)).status == AppearanceSubmit::Stopping);
  gate.Open();
  Stop(service);
  const auto stopped = service.Stop(0);
  CHECK(stopped.stopped && stopped.hasResult && stopped.activeId == 0);
  CHECK(gate.Calls() == std::vector<std::uint64_t>{11});
  CHECK(released == 0);
  auto result = Consume(service, 11);
  CHECK(result.ready() && result.Matches(active));
  result = {}; CHECK(released == 1);
  CHECK(!service.Stop(0).hasResult);
}

void WorkerFailuresAndWrongResourcesStayErrors() {
  std::atomic<unsigned> released{0};
  AppearanceService service;
  AppearanceServiceOptions options;
  options.loader = [&](const AppearanceLoadRequest& request, AppearanceLoadResult& output) {
    if (request.id == 1) throw std::runtime_error("injected loader failure");
    if (request.id == 2) { output.status = AppearancePreparationStatus::Ready; return; }
    if (request.id == 5) throw std::bad_alloc();
    Prepared(request, output, released);
    if (request.id == 3) output.animation->contentFingerprint = "wrong-fingerprint";
  };
  CHECK(service.Start(options).started);
  for (std::uint64_t id = 1; id <= 3; ++id) {
    CHECK(service.TrySubmit(Request(id)).accepted());
    auto result = Consume(service, id);
    CHECK(!result.ready() && result.error != ERROR_SUCCESS && !result.animation && !result.thumbnail);
    CHECK(result.memory.residentBytes() == 0);
  }
  CHECK(released == 1); // The malformed prepared resource was released on the worker.
  const auto thumbnail = Request(4, AppearanceLoadKind::Thumbnail);
  CHECK(service.TrySubmit(thumbnail).accepted());
  auto good = Consume(service, 4);
  CHECK(good.ready() && good.Matches(thumbnail) && good.thumbnail && !good.animation);
  good = {}; CHECK(released == 2);
  CHECK(service.TrySubmit(Request(5)).accepted());
  auto noMemory = Consume(service, 5);
  CHECK(!noMemory.ready() && noMemory.status == AppearancePreparationStatus::BudgetExceeded &&
      noMemory.error == ERROR_NOT_ENOUGH_MEMORY);
  Stop(service);
}

void InvalidRequestsNeverReachLoader() {
  std::atomic<unsigned> calls{0};
  AppearanceService service;
  CHECK(service.TrySubmit(Request(1)).status == AppearanceSubmit::NotStarted);
  AppearanceServiceOptions options;
  options.loader = [&](const AppearanceLoadRequest&, AppearanceLoadResult&) { ++calls; };
  CHECK(service.Start(options).started);
  auto invalid = Request(1); invalid.generation = 0;
  CHECK(service.TrySubmit(invalid).status == AppearanceSubmit::Invalid);
  invalid = Request(1); invalid.source.contentFingerprint.clear();
  CHECK(service.TrySubmit(invalid).status == AppearanceSubmit::Invalid);
  invalid = Request(1); invalid.source.sourcePath.assign(32768, L'x');
  CHECK(service.TrySubmit(invalid).status == AppearanceSubmit::Invalid);
  CHECK(!service.Start(options).started);
  Stop(service);
  CHECK(calls == 0 && service.Snapshot().completed == 0);
}

}  // namespace

int main() {
  try {
    BoundedLatestPriorityAndImmutableRequest();
    StopDoesNotCancelOrDetachActiveLoad();
    WorkerFailuresAndWrongResourcesStayErrors();
    InvalidRequestsNeverReachLoader();
    std::cout << "appearance service: 4/4 passed (injected loaders; no PNG decode evidence)\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
