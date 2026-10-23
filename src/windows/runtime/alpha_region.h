#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace niuma::runtime {

// Non-owning CPU pixels; they must remain alive until rasterization returns.
struct AlphaRegionImageView {
    const std::uint8_t* bgra = nullptr;
    std::size_t byteCount = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t strideBytes = 0;
};

struct AlphaRegionPoint { float x = 0; float y = 0; };
struct AlphaRegionScissor { int x = 0; int y = 0; int width = 0; int height = 0; };
struct AlphaRegionRect {
    int left = 0;
    int top = 0;
    int right = 0;
    int bottom = 0;
};

struct AlphaRegionQuad {
    AlphaRegionImageView image;
    std::array<AlphaRegionPoint, 4> positions{};
    std::array<AlphaRegionPoint, 4> uv{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
    float opacity = 1;
    std::optional<AlphaRegionScissor> scissor;
};

struct AlphaRegionStats {
    std::uint64_t testedPixels = 0;
    std::uint64_t sampledTexels = 0;
    std::uint64_t coveredPixels = 0;
    // Included only by the documented sampling/rasterization tolerance.
    std::uint64_t conservativePixels = 0;
    std::size_t rectangleCount = 0;
    double rasterMs = 0;
};

struct AlphaRegionResult {
    bool success = false;
    std::string error;
    int width = 0;
    int height = 0;
    // Non-overlapping, top-to-bottom bands, each sorted left-to-right.
    // An empty vector on success means an entirely transparent window.
    std::vector<AlphaRegionRect> rectangles;
    AlphaRegionStats stats;
};

// Pure CPU function. Matches the renderer's two triangles (012, 023), linear
// clamp sampling and source-over alpha union. It conservatively retains all
// positive alpha, including values which may quantize to zero in BGRA8.
// A small subpixel/texture-coordinate allowance protects visible edges from
// GPU interpolation rounding; entirely transparent texture regions stay holes.
// No readback, HWND operation, persistent cache or background work occurs here.
// Invalid/oversized input fails explicitly: callers must not replace failure
// with an opaque bounding rectangle or silently keep an unrelated old region.
AlphaRegionResult RasterizeAlphaRegion(
    int width, int height, const std::vector<AlphaRegionQuad>& quads);

#ifdef _WIN32
struct PixelImage;
struct Quad;

// The caller resolves textureId to the same CPU image used for AddTexture.
AlphaRegionQuad FromRendererQuad(const Quad& quad, const PixelImage& image);

struct AlphaRegionData {
    bool success = false;
    std::string error;
    // DWORD-aligned RGNDATA bytes. Pass data()/byteCount to ExtCreateRegion.
    std::vector<std::uint32_t> words;
    std::uint32_t byteCount = 0;
    double serializeMs = 0;
};

// Serialization only; the caller owns ExtCreateRegion/SetWindowRgn, including
// HRGN transfer/deletion on success/failure. Empty successful regions are valid.
AlphaRegionData MakeAlphaRegionData(const AlphaRegionResult& region);
#endif

}  // namespace niuma::runtime
