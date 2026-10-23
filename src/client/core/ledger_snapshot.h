#pragma once

#include "input_state.h"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace niuma::client::core {

struct LedgerRequest {
  std::uint64_t id = 0;
  std::uint64_t expectedEpoch = 0;
};

enum class LedgerRequestResult : std::uint8_t { Accepted, Busy, Invalid, Stopped };
enum class LedgerResultStatus : std::uint8_t {
  Complete,
  EpochMismatch,
  CapacityMismatch,
  CoreUnavailable,
  Stopped,
};
enum class LedgerSlotState : unsigned { Free, Requested, Ready, Closed };

struct LedgerSnapshotHeader {
  LedgerRequest request;
  InputSnapshot input;
  std::size_t dailyCount = 0;
  LedgerResultStatus status = LedgerResultStatus::CoreUnavailable;
};

struct LedgerSnapshotResult {
  LedgerSnapshotHeader header;
  std::vector<DailyTotal> daily;
};

// One input owner produces; one consumer requests, copies, and releases. The
// complete ledger slot is allocated once, before hooks start. No per-input
// ledger copy and no queue of snapshots. Request metadata is published before
// Requested; output is published before Ready. The owner never touches Ready,
// even when copying to the consumer's vector is slow or allocation fails.
class LedgerSnapshotChannel {
  static_assert(std::atomic<LedgerSlotState>::is_always_lock_free,
                "The input owner must not wait on a consumer lock");

 public:
  explicit LedgerSnapshotChannel(std::size_t capacity) : buffer_(CheckedCapacity(capacity)) {}
  LedgerSnapshotChannel(const LedgerSnapshotChannel&) = delete;
  LedgerSnapshotChannel& operator=(const LedgerSnapshotChannel&) = delete;

  // Consumer only. Accepted means exactly one committed request. Busy/Stopped
  // means no request was committed. Retrying Busy cannot overwrite older data.
  LedgerRequestResult Request(LedgerRequest request) noexcept {
    if (!request.id || !request.expectedEpoch) return LedgerRequestResult::Invalid;
    if (closed_.load(std::memory_order_acquire)) return LedgerRequestResult::Stopped;
    if (state_.load(std::memory_order_acquire) != LedgerSlotState::Free)
      return LedgerRequestResult::Busy;
    request_ = request;
    auto expected = LedgerSlotState::Free;
    // Close can claim a Free slot while request metadata is being prepared;
    // it does not read that metadata unless this publication succeeds.
    if (!state_.compare_exchange_strong(expected, LedgerSlotState::Requested,
                                        std::memory_order_acq_rel,
                                        std::memory_order_acquire))
      return expected == LedgerSlotState::Closed ? LedgerRequestResult::Stopped
                                                 : LedgerRequestResult::Busy;
    return LedgerRequestResult::Accepted;
  }

  // Owner only, OUTSIDE callbacks. The owner cannot mutate the core during
  // this call, so input.version identifies the exact complete ledger copied.
  bool ProduceIfRequested(const InputCore& core) noexcept {
    if (state_.load(std::memory_order_acquire) != LedgerSlotState::Requested) return false;
    header_ = {};
    header_.request = request_;
    header_.input = core.snapshot();
    if (!header_.input.ready) {
      header_.status = LedgerResultStatus::CoreUnavailable;
    } else if (request_.expectedEpoch != header_.input.epoch) {
      header_.status = LedgerResultStatus::EpochMismatch;
    } else if (core.daily_size() > buffer_.size()) {
      header_.status = LedgerResultStatus::CapacityMismatch;
    } else {
      header_.dailyCount = core.CopyDailyTotals(buffer_.data(), buffer_.size());
      header_.status = LedgerResultStatus::Complete;
    }
    state_.store(LedgerSlotState::Ready, std::memory_order_release);
    return true;
  }

  // Consumer only. Allocation/copy happens before release. If allocation
  // throws, Ready is retained and this same result can be consumed again.
  bool TryConsume(LedgerSnapshotResult& output) {
    if (state_.load(std::memory_order_acquire) != LedgerSlotState::Ready) return false;
    output.daily.assign(buffer_.begin(), buffer_.begin() + header_.dailyCount);
    output.header = header_;
    state_.store(closed_.load(std::memory_order_acquire) ? LedgerSlotState::Closed
                                                      : LedgerSlotState::Free,
                 std::memory_order_release);
    return true;
  }

  // Owner only, on teardown. An already Ready snapshot stays immutable until
  // consumed. An accepted but unfinished request receives an explicit terminal
  // result, never an eternal Requested state. Stop's final ledger is separate.
  void Close(const InputSnapshot& finalState) noexcept {
    closed_.store(true, std::memory_order_release);
    auto expected = LedgerSlotState::Free;
    if (state_.compare_exchange_strong(expected, LedgerSlotState::Closed,
                                       std::memory_order_acq_rel,
                                       std::memory_order_acquire)) return;
    if (expected == LedgerSlotState::Requested) {
      header_ = {};
      header_.request = request_;
      header_.input = finalState;
      header_.status = LedgerResultStatus::Stopped;
      state_.store(LedgerSlotState::Ready, std::memory_order_release);
    }
  }

  LedgerSlotState state() const noexcept { return state_.load(std::memory_order_acquire); }
  std::size_t capacity() const noexcept { return buffer_.size(); }

 private:
  static std::size_t CheckedCapacity(std::size_t capacity) {
    if (!capacity || capacity > InputCore::kMaximumDayCapacity)
      throw std::invalid_argument("Ledger snapshot capacity is outside its supported range");
    return capacity;
  }

  std::vector<DailyTotal> buffer_;
  LedgerRequest request_;
  LedgerSnapshotHeader header_;
  std::atomic<LedgerSlotState> state_{LedgerSlotState::Free};
  std::atomic<bool> closed_{false};
};

}  // namespace niuma::client::core
