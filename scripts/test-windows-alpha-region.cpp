#include "../src/windows/runtime/alpha_region.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

using namespace niuma::runtime;

namespace {
void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

struct Image {
    std::uint32_t width;
    std::uint32_t height;
    std::uint32_t stride;
    std::vector<std::uint8_t> pixels;
    Image(std::uint32_t w, std::uint32_t h, std::uint8_t alpha = 0, int padding = 0)
        : width(w), height(h), stride(w * 4 + padding), pixels(stride * h, 0) {
        for (std::uint32_t y = 0; y < h; ++y) {
            for (std::uint32_t x = 0; x < w; ++x) Set(x, y, alpha);
        }
    }
    void Set(std::uint32_t x, std::uint32_t y, std::uint8_t alpha) {
        pixels[static_cast<std::size_t>(y) * stride + x * 4 + 3] = alpha;
    }
    AlphaRegionImageView View() const {
        return {pixels.data(), pixels.size(), width, height, stride};
    }
};

AlphaRegionQuad Rect(const Image& image, float x, float y, float width, float height) {
    AlphaRegionQuad quad;
    quad.image = image.View();
    quad.positions = {{{x, y}, {x + width, y}, {x + width, y + height}, {x, y + height}}};
    return quad;
}

bool Contains(const AlphaRegionResult& region, int x, int y) {
    for (const auto& rect : region.rectangles) {
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return true;
    }
    return false;
}

void Validate(const AlphaRegionResult& region) {
    Require(region.success, region.error.c_str());
    std::vector<bool> pixels(static_cast<std::size_t>(region.width) * region.height);
    std::uint64_t total = 0;
    int lastTop = -1, lastRight = -1, lastBottom = -1;
    for (const auto& rect : region.rectangles) {
        Require(rect.left >= 0 && rect.top >= 0 && rect.right <= region.width &&
                rect.bottom <= region.height && rect.left < rect.right && rect.top < rect.bottom,
                "rectangle must be nonempty and inside surface");
        Require(rect.top >= lastTop, "rectangle bands must be sorted");
        if (rect.top == lastTop) {
            Require(rect.left >= lastRight && rect.bottom == lastBottom,
                    "same band must have ordered disjoint runs");
        } else {
            Require(rect.top >= lastBottom, "bands must not overlap");
        }
        lastTop = rect.top;
        lastRight = rect.right;
        lastBottom = rect.bottom;
        for (int y = rect.top; y < rect.bottom; ++y) {
            for (int x = rect.left; x < rect.right; ++x) {
                const auto index = static_cast<std::size_t>(y) * region.width + x;
                Require(!pixels[index], "rectangles must not duplicate pixels");
                pixels[index] = true;
                ++total;
            }
        }
    }
    Require(total == region.stats.coveredPixels, "coverage count must equal rectangle area");
    Require(region.stats.conservativePixels <= total, "conservative count must be a subset");
    Require(region.stats.rectangleCount == region.rectangles.size(), "rectangle count must match");
}

void EmptyAndTransparent() {
    auto result = RasterizeAlphaRegion(12, 12, {});
    Validate(result);
    Require(result.rectangles.empty(), "no quads must be empty");
    Image clear(5, 5);
    result = RasterizeAlphaRegion(12, 12, {Rect(clear, 1, 1, 10, 10)});
    Validate(result);
    Require(result.rectangles.empty(), "transparent artwork must not produce a full window");
}

void SolidAffineAndBands() {
    Image solid(2, 2, 255);
    auto result = RasterizeAlphaRegion(12, 12, {Rect(solid, 2, 3, 4, 4)});
    Validate(result);
    Require(result.stats.coveredPixels == 16 && result.rectangles.size() == 1,
            "solid rectangle must compact to one rectangle");
    Require(Contains(result, 2, 3) && Contains(result, 5, 6) && !Contains(result, 6, 6),
            "solid rectangle location");
    auto quad = Rect(solid, 0, 0, 1, 1);
    quad.positions = {{{2, 2}, {8, 2}, {10, 6}, {4, 6}}};
    result = RasterizeAlphaRegion(12, 12, {quad});
    Validate(result);
    Require(result.stats.coveredPixels == 24, "affine shear must rasterize actual parallelogram");
    Require(Contains(result, 5, 3) && !Contains(result, 2, 5), "affine shear edge");
}

void LinearVisibleEdgesAndHoles() {
    Image point(5, 5);
    point.Set(2, 2, 255);
    auto result = RasterizeAlphaRegion(12, 12, {Rect(point, 0, 0, 10, 10)});
    Validate(result);
    Require(result.stats.coveredPixels == 16, "linear upscale must retain interpolation edge");
    Require(Contains(result, 3, 3) && Contains(result, 6, 6), "visible filtered fringe retained");
    Require(!Contains(result, 2, 3) && !Contains(result, 7, 6), "transparent background stays hole");

    Image ring(7, 7, 255);
    for (int y = 1; y < 6; ++y) for (int x = 1; x < 6; ++x) ring.Set(x, y, 0);
    result = RasterizeAlphaRegion(7, 7, {Rect(ring, 0, 0, 7, 7)});
    Validate(result);
    Require(Contains(result, 0, 0) && !Contains(result, 3, 3), "interior transparent hole retained");
    Require(result.stats.conservativePixels > 0, "rounding allowance counted separately");
}

void UvCropFlipAndClamp() {
    Image strip(4, 1);
    strip.Set(2, 0, 255);
    auto quad = Rect(strip, 0, 0, 4, 2);
    quad.uv = {{{0.5f, 0}, {0.75f, 0}, {0.75f, 1}, {0.5f, 1}}};
    auto result = RasterizeAlphaRegion(6, 4, {quad});
    Validate(result);
    Require(result.stats.coveredPixels == 8, "UV crop must use cropped opaque interval");
    quad.uv = {{{0, 0}, {0.125f, 0}, {0.125f, 1}, {0, 1}}};
    result = RasterizeAlphaRegion(6, 4, {quad});
    Validate(result);
    Require(result.rectangles.empty(), "UV crop entirely outside alpha must remain empty");

    Image two(2, 1);
    two.Set(0, 0, 255);
    quad = Rect(two, 0, 0, 4, 2);
    quad.uv = {{{1, 0}, {0, 0}, {0, 1}, {1, 1}}};
    result = RasterizeAlphaRegion(6, 4, {quad});
    Validate(result);
    Require(!Contains(result, 0, 0) && Contains(result, 3, 0), "flipped UV must flip hit shape");
    quad.uv = {{{-2, -2}, {-1, -2}, {-1, -1}, {-2, -1}}};
    result = RasterizeAlphaRegion(6, 4, {quad});
    Validate(result);
    Require(result.stats.coveredPixels == 8, "out-of-bounds UV must clamp to edge alpha");
}

void OpacityAndScissor() {
    Image solid(1, 1, 1);
    auto quad = Rect(solid, 0, 0, 10, 10);
    quad.opacity = 0;
    auto result = RasterizeAlphaRegion(10, 10, {quad});
    Validate(result);
    Require(result.rectangles.empty(), "opacity zero must never intercept input");
    quad.opacity = 0.000001f;
    quad.scissor = AlphaRegionScissor{2, 3, 4, 2};
    result = RasterizeAlphaRegion(10, 10, {quad});
    Validate(result);
    Require(result.stats.coveredPixels == 8 && Contains(result, 2, 3) &&
            !Contains(result, 1, 3) && !Contains(result, 6, 3),
            "positive faint alpha retained, scissor strictly obeyed");
    quad.scissor = AlphaRegionScissor{std::numeric_limits<int>::max(), 0,
                                     std::numeric_limits<int>::max(), 10};
    result = RasterizeAlphaRegion(10, 10, {quad});
    Validate(result);
    Require(result.rectangles.empty(), "scissor endpoint addition must not overflow");
}

void RotatedTextureAndBackground() {
    Image solid(2, 2, 255);
    auto quad = Rect(solid, 0, 0, 1, 1);
    quad.positions = {{{5, 1}, {9, 5}, {5, 9}, {1, 5}}};
    auto result = RasterizeAlphaRegion(11, 11, {quad});
    Validate(result);
    Require(Contains(result, 4, 4) && Contains(result, 4, 1), "rotated visible edge retained");
    Require(!Contains(result, 1, 1) && !Contains(result, 8, 8),
            "rotated bounds must not swallow transparent corners");
    Image corner(2, 2);
    corner.Set(0, 0, 255);
    quad.image = corner.View();
    result = RasterizeAlphaRegion(11, 11, {quad});
    Validate(result);
    Require(Contains(result, 4, 2) && !Contains(result, 5, 7),
            "rotated UVs must follow artwork, not bounding box");
}

void PaddedRowsOverlapAndDegenerate() {
    Image padded(2, 2, 255, 12);
    auto result = RasterizeAlphaRegion(6, 4,
        {Rect(padded, 0, 0, 2, 2), Rect(padded, 1, 0, 2, 2)});
    Validate(result);
    Require(result.stats.coveredPixels == 6 && result.rectangles.size() == 1,
            "overlapping alpha union must not double count and must obey row stride");
    auto quad = Rect(padded, 1, 1, 0, 0);
    result = RasterizeAlphaRegion(6, 4, {quad});
    Validate(result);
    Require(result.rectangles.empty(), "degenerate triangles must not create a region");
}

void InvalidInputsFailExplicitly() {
    Image solid(2, 2, 255);
    auto quad = Rect(solid, 0, 0, 2, 2);
    quad.image.byteCount = 1;
    Require(!RasterizeAlphaRegion(4, 4, {quad}).success, "short image data rejected");
    quad = Rect(solid, 0, 0, 2, 2);
    quad.opacity = std::numeric_limits<float>::quiet_NaN();
    Require(!RasterizeAlphaRegion(4, 4, {quad}).success, "NaN opacity rejected");
    quad = Rect(solid, 0, 0, 2, 2);
    quad.positions[0].x = std::numeric_limits<float>::infinity();
    Require(!RasterizeAlphaRegion(4, 4, {quad}).success, "infinite vertex rejected");
    quad = Rect(solid, 0, 0, 2, 2);
    quad.scissor = AlphaRegionScissor{0, 0, -1, 2};
    Require(!RasterizeAlphaRegion(4, 4, {quad}).success, "negative scissor rejected");
    Require(!RasterizeAlphaRegion(0, 4, {}).success, "empty dimensions rejected");
    Require(!RasterizeAlphaRegion(16384, 16384, {}).success, "mask memory bound enforced");
}
}  // namespace

int main() {
    struct Test { const char* name; void (*run)(); };
    const Test tests[] = {
        {"empty-and-transparent", EmptyAndTransparent},
        {"solid-affine-and-bands", SolidAffineAndBands},
        {"linear-visible-edges-and-holes", LinearVisibleEdgesAndHoles},
        {"uv-crop-flip-and-clamp", UvCropFlipAndClamp},
        {"opacity-and-scissor", OpacityAndScissor},
        {"rotated-texture-and-background", RotatedTextureAndBackground},
        {"padded-rows-overlap-and-degenerate", PaddedRowsOverlapAndDegenerate},
        {"invalid-inputs-fail-explicitly", InvalidInputsFailExplicitly},
    };
    int passed = 0;
    for (const auto& test : tests) {
        try {
            test.run();
            ++passed;
            std::cout << "PASS " << test.name << '\n';
        } catch (const std::exception& error) {
            std::cerr << "FAIL " << test.name << ": " << error.what() << '\n';
            return 1;
        }
    }
    std::cout << "alpha-region: " << passed << '/' << std::size(tests) << " passed\n";
    return 0;
}
