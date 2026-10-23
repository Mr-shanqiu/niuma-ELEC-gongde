#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace niuma::runtime {

// A CPU-owned decision for a sparse weak-alpha destination pixel. The key is
// y * surfaceWidth + x; alphaByte is exactly 0 or 1. Each quad's list must be
// strictly increasing, with no duplicate keys. No full-surface mask is used.
struct WeakAlphaPixel {
    std::uint32_t pixelKey = 0;
    std::uint32_t alphaByte = 0;
};

using WeakAlphaOverrides = std::vector<std::vector<WeakAlphaPixel>>;
inline constexpr std::size_t kMaxWeakAlphaEntries = 1024 * 1024;

}  // namespace niuma::runtime
