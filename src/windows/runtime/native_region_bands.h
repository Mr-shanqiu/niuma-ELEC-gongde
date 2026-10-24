#pragma once
#include "alpha_region.h"
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace niuma::runtime {
struct NativeRegionBandStats {
    double lookupMs = 0, serializeMs = 0, createMs = 0, combineMs = 0;
    std::size_t created = 0, reused = 0, combined = 0;
};
// UI-owned exact native assembly only; never caches alpha/weak decisions.
// Retained handles never transfer to USER. Every result is a fresh union handle.
// Large surfaces/contours use the caller's original whole-region path.
class NativeRegionBands final {
public:
    static constexpr int kBandHeight = 64;
    static constexpr std::size_t kMaximumBands = 64;
    static constexpr std::size_t kByteLimit = 2 * 1024 * 1024;
    NativeRegionBands() = default;
    ~NativeRegionBands() { Clear(); }
    NativeRegionBands(const NativeRegionBands&) = delete;
    NativeRegionBands& operator=(const NativeRegionBands&) = delete;
    // False means no result; caller may use its unchanged whole-region path.
    bool TryBuild(const AlphaRegionResult& raster, HRGN& output, NativeRegionBandStats& stats);
    void Clear() noexcept;
    std::size_t RetainedBytes() const noexcept { return bytes_; }
    std::size_t RetainedHandles() const noexcept;
private:
    struct Band { bool valid = false; HRGN handle = nullptr; std::vector<AlphaRegionRect> rectangles; };
    std::array<Band, kMaximumBands> bands_{};
    int width_ = 0, height_ = 0;
    std::size_t bytes_ = 0;
};
} // namespace niuma::runtime
#endif
