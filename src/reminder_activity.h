#pragma once

#include <array>
#include <cstdint>

namespace niuma::reminder {

class WallClockGuard {
 public:
  enum class Transition : std::uint8_t { None, Guarded, Recovered };
  static constexpr std::uint64_t kToleranceMs = 120'000;
  static constexpr std::uint64_t kStableRecoveryMs = 300'000;

  void Start(std::int64_t wallUtcSeconds, std::uint64_t monotonicMs,
             bool persistedGuard) {
    lastWallUtcSeconds_ = wallUtcSeconds;
    lastMonotonicMs_ = monotonicMs;
    stableSinceMonotonicMs_ = monotonicMs;
    initialized_ = true;
    guarded_ = persistedGuard;
  }

  Transition NotifyClockChange(std::int64_t wallUtcSeconds,
                              std::uint64_t monotonicMs) {
    const Transition transition = Observe(wallUtcSeconds, monotonicMs);
    if (guarded_ && transition != Transition::Guarded)
      stableSinceMonotonicMs_ = monotonicMs;
    return transition;
  }

  Transition Observe(std::int64_t wallUtcSeconds, std::uint64_t monotonicMs) {
    if (!initialized_) {
      Start(wallUtcSeconds, monotonicMs, guarded_);
      return Transition::None;
    }

    bool discontinuity = monotonicMs < lastMonotonicMs_;
    if (!discontinuity) {
      const long double wallElapsedMs =
          (static_cast<long double>(wallUtcSeconds) -
           static_cast<long double>(lastWallUtcSeconds_)) * 1000.0L;
      const long double monotonicElapsedMs =
          static_cast<long double>(monotonicMs - lastMonotonicMs_);
      long double difference = wallElapsedMs - monotonicElapsedMs;
      if (difference < 0) difference = -difference;
      discontinuity = difference > static_cast<long double>(kToleranceMs);
    }

    const bool wasGuarded = guarded_;
    if (discontinuity) {
      guarded_ = true;
      stableSinceMonotonicMs_ = monotonicMs;
    } else if (guarded_ && monotonicMs >= stableSinceMonotonicMs_ &&
               monotonicMs - stableSinceMonotonicMs_ >= kStableRecoveryMs) {
      guarded_ = false;
    }

    lastWallUtcSeconds_ = wallUtcSeconds;
    lastMonotonicMs_ = monotonicMs;
    if (!wasGuarded && guarded_) return Transition::Guarded;
    if (wasGuarded && !guarded_) return Transition::Recovered;
    return Transition::None;
  }

  bool guarded() const { return guarded_; }

  void RestoreGuard() {
    guarded_ = true;
    stableSinceMonotonicMs_ = lastMonotonicMs_;
  }

 private:
  std::int64_t lastWallUtcSeconds_ = 0;
  std::uint64_t lastMonotonicMs_ = 0;
  std::uint64_t stableSinceMonotonicMs_ = 0;
  bool initialized_ = false;
  bool guarded_ = false;
};

inline bool EstimateSleepDurationMs(std::uint64_t systemElapsedMs,
                                   std::uint64_t unbiasedAwakeElapsed100ns,
                                   bool countersTrusted,
                                   std::uint64_t* sleepDurationMs) {
  if (!countersTrusted || sleepDurationMs == nullptr) return false;
  const std::uint64_t awakeElapsedMs = unbiasedAwakeElapsed100ns / 10'000;
  if (systemElapsedMs < awakeElapsedMs) return false;
  *sleepDurationMs = systemElapsedMs - awakeElapsedMs;
  return true;
}

// A fixed-memory, single-writer activity sampler. Callers must serialize
// Observe/Evaluate on their existing input/UI thread. It stores only aggregate
// counts and monotonic timestamps; event identity and payload never enter here.
class ActivitySampler {
 public:
  enum class Event : std::uint8_t { KeyDown, KeyUp, Click, ScrollPulse };
  enum class Trigger : std::uint8_t { None, LongBusy, HighIntensity };

  static constexpr std::uint64_t kBucketMs = 10'000;
  static constexpr std::size_t kBucketCount = 180;
  static constexpr std::uint64_t kObservationGapMs = 30'000;

  void ResetForListenerRestart() {
    ClearBuckets();
    keyGateOpen_ = true;
    lastEvaluationMs_ = 0;
    lastEventMs_ = 0;
    segmentStartMs_ = 0;
    hasSegment_ = false;
    // A restart cannot grant a second opportunity within a previously locked
    // segment. The caller can retain the sampler across listener recreation.
  }

  void BeginSuspend(std::uint64_t monotonicMs) {
    if (suspended_) return;
    suspended_ = true;
    suspendStartMs_ = monotonicMs;
    ClearBuckets();
    hasSegment_ = false;
    segmentStartMs_ = 0;
    lastEventMs_ = 0;
    lastEvaluationMs_ = monotonicMs;
  }

  // Always starts a fresh observation window. The caller supplies duration
  // only when a matching lifecycle pair and a sleep-aware clock prove it.
  // A long, trusted pause is the only lifecycle event that unlocks a segment.
  bool ResumeFromSuspend(std::uint64_t monotonicMs, bool pairedSignal,
                         bool durationTrusted, std::uint64_t inactiveDurationMs) {
    const bool unlock = suspended_ && pairedSignal && durationTrusted &&
        inactiveDurationMs >= 300'000;
    ClearBuckets();
    hasSegment_ = false;
    segmentStartMs_ = 0;
    lastEventMs_ = 0;
    lastEvaluationMs_ = monotonicMs;
    keyGateOpen_ = true;
    suspended_ = false;
    suspendStartMs_ = 0;
    if (unlock) segmentConsumed_ = false;
    return unlock;
  }

  bool suspended() const { return suspended_; }
  std::uint64_t suspend_started_ms() const { return suspendStartMs_; }

  void Observe(Event event, std::uint64_t monotonicMs) {
    if (suspended_) return;
    RollTo(monotonicMs);
    if (event == Event::KeyUp) {
      keyGateOpen_ = true;
      return;
    }

    if (event == Event::KeyDown) {
      if (!keyGateOpen_) return;
      // Even a rate-limited keydown closes the gate, so autorepeat cannot
      // become repeated activity after a limiter boundary.
      keyGateOpen_ = false;
      if (perSecondKeys_ >= 8) return;
      ++perSecondKeys_;
    } else if (event == Event::Click) {
      if (perSecondClicks_ >= 4) return;
      ++perSecondClicks_;
    } else {
      if (perSecondScrolls_ >= 1) return;
      ++perSecondScrolls_;
    }

    Bucket* bucket = CurrentBucket(monotonicMs);
    if (bucket == nullptr) return;
    if (bucket->events == 0) bucket->firstEventMs = monotonicMs;
    bucket->lastEventMs = monotonicMs;
    ++bucket->events;
    const std::uint32_t weight = event == Event::ScrollPulse ? 1 : 4;
    bucket->scoreQuarterUnits = bucket->scoreQuarterUnits + weight > 160
        ? 160 : bucket->scoreQuarterUnits + weight;
    lastEventMs_ = monotonicMs;
  }

  Trigger Evaluate(std::uint64_t monotonicMs, bool listenerHealthy = true) {
    if (suspended_) return Trigger::None;
    if (!listenerHealthy) {
      ClearBuckets();
      lastEvaluationMs_ = monotonicMs;
      lastEventMs_ = 0;
      hasSegment_ = false;
      return Trigger::None;
    }
    if (lastEvaluationMs_ != 0 &&
        (monotonicMs < lastEvaluationMs_ ||
         monotonicMs - lastEvaluationMs_ > kObservationGapMs)) {
      ClearBuckets();
      lastEventMs_ = 0;
      hasSegment_ = false;
      lastEvaluationMs_ = monotonicMs;
      return Trigger::None;
    }
    RollTo(monotonicMs);
    lastEvaluationMs_ = monotonicMs;

    if (IsClearRest(monotonicMs)) {
      segmentConsumed_ = false;
      hasSegment_ = false;
      segmentStartMs_ = 0;
      return Trigger::None;
    }

    const std::uint64_t currentIndex = monotonicMs / kBucketMs;
    if (!hasSegment_) {
      for (std::size_t back = 1; back <= kBucketCount; ++back) {
        const Bucket* bucket = ClosedBucket(currentIndex, back);
        if (bucket == nullptr) break;
        if (IsActive(*bucket)) {
          hasSegment_ = true;
          segmentStartMs_ = bucket->index * kBucketMs;
        }
      }
    }
    if (segmentConsumed_ || !hasSegment_ || !IsFresh(monotonicMs, currentIndex))
      return Trigger::None;

    if (HasHighIntensity(currentIndex)) {
      segmentConsumed_ = true;
      return Trigger::HighIntensity;
    }
    if (monotonicMs >= segmentStartMs_ &&
        monotonicMs - segmentStartMs_ >= 28ULL * 60ULL * 1000ULL &&
        HasLongBusy(currentIndex)) {
      segmentConsumed_ = true;
      return Trigger::LongBusy;
    }
    return Trigger::None;
  }

  bool segment_consumed() const { return segmentConsumed_; }
  void RestoreSegmentConsumed(bool consumed) { segmentConsumed_ = consumed; }

 private:
  struct Bucket {
    std::uint64_t index = 0;
    std::uint32_t events = 0;
    std::uint32_t scoreQuarterUnits = 0;
    std::uint64_t firstEventMs = 0;
    std::uint64_t lastEventMs = 0;
    bool valid = false;
  };

  void ClearBuckets() {
    buckets_ = {};
    currentBucketIndex_ = 0;
    currentBucketValid_ = false;
    perSecondIndex_ = 0;
    perSecondKeys_ = perSecondClicks_ = perSecondScrolls_ = 0;
  }

  void RollTo(std::uint64_t nowMs) {
    const std::uint64_t index = nowMs / kBucketMs;
    if (!currentBucketValid_ || index != currentBucketIndex_) {
      std::uint64_t first = currentBucketValid_ ? currentBucketIndex_ + 1 : index;
      if (index >= first && index - first >= kBucketCount)
        first = index - kBucketCount + 1;
      for (std::uint64_t next = first; next <= index; ++next) {
        Bucket& bucket = buckets_[next % kBucketCount];
        bucket = {};
        bucket.index = next;
        bucket.valid = true;
      }
      currentBucketIndex_ = index;
      currentBucketValid_ = true;
    }
    const std::uint64_t second = nowMs / 1000;
    if (second != perSecondIndex_) {
      perSecondIndex_ = second;
      perSecondKeys_ = perSecondClicks_ = perSecondScrolls_ = 0;
    }
  }

  Bucket* CurrentBucket(std::uint64_t nowMs) {
    Bucket& bucket = buckets_[(nowMs / kBucketMs) % kBucketCount];
    return bucket.valid && bucket.index == nowMs / kBucketMs ? &bucket : nullptr;
  }

  const Bucket* ClosedBucket(std::uint64_t currentIndex, std::size_t back) const {
    if (currentIndex < back) return nullptr;
    const std::uint64_t index = currentIndex - back;
    const Bucket& bucket = buckets_[index % kBucketCount];
    return bucket.valid && bucket.index == index ? &bucket : nullptr;
  }

  static bool IsActive(const Bucket& bucket) {
    return bucket.events >= 3 ||
        (bucket.events >= 2 && bucket.lastEventMs - bucket.firstEventMs >= 2000);
  }

  bool IsClearRest(std::uint64_t nowMs) const {
    if (lastEventMs_ != 0 && nowMs >= lastEventMs_ &&
        nowMs - lastEventMs_ >= 300'000) return true;
    const std::uint64_t currentIndex = nowMs / kBucketMs;
    std::uint32_t events = 0;
    for (std::size_t back = 1; back <= 30; ++back) {
      const Bucket* bucket = ClosedBucket(currentIndex, back);
      if (bucket == nullptr) return false;
      events += bucket->events;
      if (IsActive(*bucket)) return false;
    }
    return events <= 5;
  }

  bool IsFresh(std::uint64_t nowMs, std::uint64_t currentIndex) const {
    if (lastEventMs_ == 0 || nowMs < lastEventMs_ || nowMs - lastEventMs_ > 20'000)
      return false;
    std::size_t active = 0;
    for (std::size_t back = 1; back <= 6; ++back) {
      const Bucket* bucket = ClosedBucket(currentIndex, back);
      if (bucket == nullptr) return false;
      if (IsActive(*bucket)) ++active;
    }
    return active >= 3;
  }

  bool HasHighIntensity(std::uint64_t currentIndex) const {
    std::uint32_t score = 0;
    std::size_t active = 0;
    for (std::size_t back = 1; back <= 30; ++back) {
      const Bucket* bucket = ClosedBucket(currentIndex, back);
      if (bucket == nullptr) return false;
      score += bucket->scoreQuarterUnits;
      if (IsActive(*bucket)) ++active;
    }
    return score >= 2400 && active >= 21;
  }

  bool HasLongBusy(std::uint64_t currentIndex) const {
    std::size_t active = 0;
    for (std::size_t back = 1; back <= 168; ++back) {
      const Bucket* bucket = ClosedBucket(currentIndex, back);
      if (bucket == nullptr) return false;
      if (IsActive(*bucket)) ++active;
    }
    if (active < 126) return false;
    active = 0;
    for (std::size_t back = 1; back <= 30; ++back) {
      const Bucket* bucket = ClosedBucket(currentIndex, back);
      if (bucket == nullptr) return false;
      if (IsActive(*bucket)) ++active;
    }
    return active >= 18;
  }

  std::array<Bucket, kBucketCount> buckets_{};
  std::uint64_t currentBucketIndex_ = 0;
  std::uint64_t perSecondIndex_ = 0;
  std::uint64_t lastEvaluationMs_ = 0;
  std::uint64_t lastEventMs_ = 0;
  std::uint64_t segmentStartMs_ = 0;
  std::uint32_t perSecondKeys_ = 0;
  std::uint32_t perSecondClicks_ = 0;
  std::uint32_t perSecondScrolls_ = 0;
  bool currentBucketValid_ = false;
  bool keyGateOpen_ = true;
  bool hasSegment_ = false;
  bool segmentConsumed_ = false;
  bool suspended_ = false;
  std::uint64_t suspendStartMs_ = 0;
};

}  // namespace niuma::reminder
