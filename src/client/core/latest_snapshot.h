#pragma once

#include <array>
#include <atomic>
#include <type_traits>

namespace niuma::client::core {

// Exactly one publisher and one consumer. A slot is owned by the publisher,
// consumer, or atomic exchange point, never by two of them simultaneously.
// Publishing replaces an unread snapshot; it never waits for the consumer.
// Keep authoritative cumulative state outside this presentation channel.
template <typename T>
class LatestSnapshot {
  static_assert(std::is_trivially_copyable<T>::value,
                "Snapshots must not own mutable pointers or heap storage");
  static_assert(std::atomic<unsigned>::is_always_lock_free,
                "The input publisher needs a lock-free slot exchange");

 public:
  LatestSnapshot() = default;
  LatestSnapshot(const LatestSnapshot&) = delete;
  LatestSnapshot& operator=(const LatestSnapshot&) = delete;

  void Publish(const T& value) noexcept {
    slots_[back_] = value;
    // Acquiring the former reader slot also observes completion of its read.
    back_ = middle_.exchange(back_ | kDirty, std::memory_order_acq_rel) & kIndex;
  }

  // Always returns the last complete snapshot in value. The return value says
  // whether a new snapshot was acquired. Only this method may run on reader.
  bool Read(T& value) noexcept {
    const bool changed = (middle_.load(std::memory_order_acquire) & kDirty) != 0;
    if (changed) {
      front_ = middle_.exchange(front_, std::memory_order_acq_rel) & kIndex;
    }
    value = slots_[front_];
    return changed;
  }

 private:
  static constexpr unsigned kDirty = 4;
  static constexpr unsigned kIndex = 3;
  std::array<T, 3> slots_{};
  alignas(64) std::atomic<unsigned> middle_{2};
  unsigned back_ = 1;   // Publisher-owned.
  unsigned front_ = 0;  // Consumer-owned.
};

// Optional UI notification coalescing. Publisher: Publish, then RequestWake,
// then post an OS message only if true. Consumer: BeginConsume BEFORE Read.
// A publication racing that clear is either included in Read or posts a new
// wake; clearing after Read would instead risk losing the last notification.
class LatestSnapshotWake {
 public:
  bool RequestWake() noexcept {
    return !pending_.exchange(true, std::memory_order_acq_rel);
  }
  void BeginConsume() noexcept { pending_.store(false, std::memory_order_release); }
  // Publisher only, immediately after its OS message post failed. The snapshot
  // remains available. The adapter must report/retry the failed delivery.
  void PostFailed() noexcept { pending_.store(false, std::memory_order_release); }

 private:
  std::atomic<bool> pending_{false};
};

}  // namespace niuma::client::core
