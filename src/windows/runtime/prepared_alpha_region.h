#pragma once

#include "alpha_region.h"
#include "weak_alpha_override.h"
#include <limits>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace niuma::runtime {

struct PreparedAlphaMask {
    bool success = false;
    std::string error;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    // Integer coordinates are twice source texel coordinates. Each nonzero
    // alpha texel (i,j) contributes [i-.5,i+1.5] x [j-.5,j+1.5], clipped to
    // the texture domain. These bands preserve transparent holes.
    std::vector<AlphaRegionRect> supportRectangles;
    std::vector<AlphaRegionRect> strongSupportRectangles;
    // Optional load-time contours for effective alpha during fades. Thresholds
    // 4/8/16/32/64/128; index 6 denotes an empty threshold-256 support.
    std::array<std::vector<AlphaRegionRect>, 7> opacitySupportRectangles;
    bool opacityBandsPrepared = false;
    // Alpha only, retained for sparse weak-coverage sampling; no color decode.
    std::vector<std::uint8_t> sourceAlpha;
    std::uint64_t sourcePixels = 0;
    std::uint64_t nonzeroSourcePixels = 0;
    std::uint64_t storageBytes = 0;
    double preparationMs = 0;

};

PreparedAlphaMask PrepareAlphaMask(const AlphaRegionImageView& image,
    bool prepareOpacityBands = false,
    std::size_t storageByteLimit = std::numeric_limits<std::size_t>::max());

struct PreparedAlphaQuad {
    const PreparedAlphaMask* mask = nullptr;
    std::array<AlphaRegionPoint, 4> positions{};
    std::array<AlphaRegionPoint, 4> uv{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
    float opacity = 1;
    std::optional<AlphaRegionScissor> scissor;
};

// x' = xx*x + yx*y + tx; y' = xy*x + yy*y + ty.
struct PreparedAlphaAffine {
    double xx = 0, xy = 0, yx = 0, yy = 0, tx = 0, ty = 0;
};

// Pure calculation for the supported P0 domain: affine positions and an
// axis-aligned, nonempty UV rectangle within [0,1]. Rotation, shear and flipped
// UVs are supported. Perspective/non-affine quads and wrapping UVs explicitly
// fail; callers may report unsupported, never silently use a bounding box.
bool ResolvePreparedAlphaTransform(const PreparedAlphaQuad& quad,
                                   PreparedAlphaAffine& transform,
                                   std::string& error);

// Main coverage follows prepared boundaries. Only weak-only fragments (source
// alpha <= 1) are sampled. Their per-draw quantized alpha is shared with the GPU
// so hardware filter rounding cannot create invisible input traps.
AlphaRegionResult TransformPreparedAlphaRegion(
    int width, int height, const std::vector<PreparedAlphaQuad>& quads,
    WeakAlphaOverrides* weakOverrides = nullptr);

#ifdef _WIN32
struct Quad;
PreparedAlphaQuad FromRendererPreparedQuad(const Quad& quad, const PreparedAlphaMask& mask);

struct PreparedAlphaRegionStats {
    double transformMs = 0;  // Includes span transform/clip/union and native serialization.
    double mathMs = 0, serializeMs = 0, nativeCreateMs = 0, reuseComparisonMs = 0;
    bool nativeRegionReused = false;
    double supportAllMs = 0, supportStrongMs = 0, weakResolveMs = 0;
    std::uint64_t coveredPixels = 0;
    std::uint64_t conservativePixels = 0;  // Reserved: span tolerance is included in coverage.
    std::size_t rectangleCount = 0;
    std::size_t transformedMasks = 0;
};

struct PreparedAlphaRegionResult {
    bool success = false;
    std::string error;
    HRGN region = nullptr;
    // Same native region in band form for diagnostics; no output pixel scan.
    AlphaRegionResult raster;
    WeakAlphaOverrides weakOverrides;
    PreparedAlphaRegionStats stats;

    PreparedAlphaRegionResult() = default;
    ~PreparedAlphaRegionResult();
    PreparedAlphaRegionResult(PreparedAlphaRegionResult&&) noexcept;
    PreparedAlphaRegionResult& operator=(PreparedAlphaRegionResult&&) noexcept;
    PreparedAlphaRegionResult(const PreparedAlphaRegionResult&) = delete;
    PreparedAlphaRegionResult& operator=(const PreparedAlphaRegionResult&) = delete;
    // Call only after SetWindowRgn succeeds: USER now owns the handle.
    HRGN ReleaseRegion() noexcept;
};

// No full-surface CPU pixel loop and no GPU readback. Prepared contours are
// transformed as subpixel spans; only weak-alpha fragments use sparse sampling.
// The returned weakOverrides must accompany the same quads in Draw. Regions
// are serialized once for USER. An installedRaster may be supplied only while
// that exact region remains installed on the same window/surface. Exact band
// equality returns success with stats.nativeRegionReused and a null HRGN;
// weakOverrides are still recomputed from the current quads. SetWindowRgn stays caller-owned
// and its time must be added by the caller when reporting total region cost.
PreparedAlphaRegionResult BuildPreparedAlphaRegion(
    int width, int height, const std::vector<PreparedAlphaQuad>& quads,
    const AlphaRegionResult* installedRaster = nullptr);
#endif

}  // namespace niuma::runtime
