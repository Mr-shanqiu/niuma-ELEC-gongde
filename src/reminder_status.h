#pragma once

#include <cstdint>

namespace niuma::reminder {

enum class RuntimeStatus : std::uint8_t {
  StorageUnavailable,
  StorageFault,
  ClockGuarded,
  ListenerUnavailable,
  Ready,
};

inline RuntimeStatus ClassifyRuntimeStatus(bool storeAvailable,
                                          bool storageFault,
                                          bool clockGuarded,
                                          bool listenerHealthy) {
  if (!storeAvailable) return RuntimeStatus::StorageUnavailable;
  if (storageFault) return RuntimeStatus::StorageFault;
  if (clockGuarded) return RuntimeStatus::ClockGuarded;
  if (!listenerHealthy) return RuntimeStatus::ListenerUnavailable;
  return RuntimeStatus::Ready;
}

}  // namespace niuma::reminder
