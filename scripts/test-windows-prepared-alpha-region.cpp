#include "../src/windows/runtime/prepared_alpha_region.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace niuma::runtime;

namespace {
void Require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
struct Image {
    unsigned width, height, stride;
    std::vector<std::uint8_t> pixels;
    Image(unsigned w, unsigned h, unsigned padding = 0)
        : width(w), height(h), stride(4 * w + padding), pixels(stride * h, 0) {}
    void Set(unsigned x, unsigned y, std::uint8_t alpha) {
        pixels[static_cast<std::size_t>(y) * stride + 4 * x + 3] = alpha;
    }
    AlphaRegionImageView View() const { return {pixels.data(), pixels.size(), width, height, stride}; }
};
bool Contains(const PreparedAlphaMask& mask, int x, int y) {
    for (const auto& rect : mask.supportRectangles)
        if (rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom) return true;
    return false;
}
void ValidateBands(const PreparedAlphaMask& mask) {
    Require(mask.success, mask.error.c_str());
    int previousTop = -1, previousBottom = -1, previousRight = -1;
    for (const auto& rect : mask.supportRectangles) {
        Require(rect.left >= 0 && rect.top >= 0 && rect.right <= static_cast<int>(mask.width * 2) &&
            rect.bottom <= static_cast<int>(mask.height * 2) && rect.left < rect.right && rect.top < rect.bottom,
            "valid source-domain rectangle");
        Require(rect.top >= previousTop, "source bands sorted");
        if (rect.top == previousTop)
            Require(rect.bottom == previousBottom && rect.left >= previousRight, "disjoint same band");
        else
            Require(rect.top >= previousBottom, "disjoint vertical bands");
        previousTop = rect.top; previousBottom = rect.bottom; previousRight = rect.right;
    }
}
void SourceSupportAndHoles() {
    Image image(7, 7, 12);
    auto mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.empty() && mask.nonzeroSourcePixels == 0, "transparent mask empty");
    image.Set(3, 3, 1);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.size() == 1 && mask.nonzeroSourcePixels == 1, "one faint texel retained");
    const auto& rect = mask.supportRectangles[0];
    Require(rect.left == 5 && rect.top == 5 && rect.right == 9 && rect.bottom == 9,
            "one texel has exact half-texel linear-filter support");
    image.Set(3, 3, 0);
    for (unsigned y = 0; y < 7; ++y) for (unsigned x = 0; x < 7; ++x)
        if (x == 0 || y == 0 || x == 6 || y == 6) image.Set(x, y, 255);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(Contains(mask, 0, 0) && Contains(mask, 13, 13) && !Contains(mask, 7, 7),
            "source support preserves interior transparent hole");
    for (unsigned y = 0; y < 7; ++y) for (unsigned x = 0; x < 7; ++x) image.Set(x, y, 255);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.size() == 1 && mask.supportRectangles[0].right == 14 &&
        mask.supportRectangles[0].bottom == 14, "solid source compacts to one domain rectangle");
}

void SupportMatchesIndependentTexelUnion() {
    // A small non-convex source with gaps, edges and adjacent spans. Compare
    // every doubled-coordinate cell to the direct union of texel supports.
    Image image(9, 6);
    for (unsigned y = 0; y < image.height; ++y) for (unsigned x = 0; x < image.width; ++x)
        if ((x * 7 + y * 11) % 9 == 0 || (y == 2 && x >= 3 && x <= 5)) image.Set(x, y, 255);
    const auto mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    for (int y = 0; y < static_cast<int>(2 * image.height); ++y) {
        for (int x = 0; x < static_cast<int>(2 * image.width); ++x) {
            bool expected = false;
            for (unsigned sy = 0; sy < image.height; ++sy) for (unsigned sx = 0; sx < image.width; ++sx) {
                if (!image.pixels[sy * image.stride + sx * 4 + 3]) continue;
                if (x >= static_cast<int>(2 * sx) - 1 && x < static_cast<int>(2 * sx) + 3 &&
                    y >= static_cast<int>(2 * sy) - 1 && y < static_cast<int>(2 * sy) + 3) expected = true;
            }
            Require(Contains(mask, x, y) == expected, "prepared support equals independent texel union");
        }
    }
}

void TransformMapsCroppedCorners() {
    Image image(200, 100);
    const auto mask = PrepareAlphaMask(image.View());
    PreparedAlphaQuad quad;
    quad.mask = &mask;
    quad.positions = {{{20, 30}, {140, 70}, {120, 130}, {0, 90}}};
    quad.uv = {{{0.25f, 0.125f}, {0.75f, 0.125f}, {0.75f, 0.875f}, {0.25f, 0.875f}}};
    PreparedAlphaAffine transform;
    std::string error;
    Require(ResolvePreparedAlphaTransform(quad, transform, error), error.c_str());
    for (std::size_t i = 0; i < 4; ++i) {
        const double x = quad.uv[i].x * mask.width * 2;
        const double y = quad.uv[i].y * mask.height * 2;
        Require(std::abs(transform.xx * x + transform.yx * y + transform.tx - quad.positions[i].x) < 1e-8 &&
            std::abs(transform.xy * x + transform.yy * y + transform.ty - quad.positions[i].y) < 1e-8,
            "cropped affine source corners map to renderer positions");
    }
    quad.uv = {{{0.75f, 0.875f}, {0.25f, 0.875f}, {0.25f, 0.125f}, {0.75f, 0.125f}}};
    Require(ResolvePreparedAlphaTransform(quad, transform, error), "flipped crop supported");
    for (std::size_t i = 0; i < 4; ++i) {
        const double x = quad.uv[i].x * mask.width * 2;
        const double y = quad.uv[i].y * mask.height * 2;
        Require(std::abs(transform.xx * x + transform.yx * y + transform.tx - quad.positions[i].x) < 1e-8 &&
            std::abs(transform.xy * x + transform.yy * y + transform.ty - quad.positions[i].y) < 1e-8,
            "flipped affine corners map exactly");
    }
}

void UnsupportedIsExplicit() {
    Image image(2, 2);
    const auto mask = PrepareAlphaMask(image.View());
    PreparedAlphaQuad quad;
    quad.mask = &mask;
    quad.positions = {{{0, 0}, {20, 0}, {20, 20}, {0, 20}}};
    PreparedAlphaAffine transform;
    std::string error;
    quad.positions[2].x = 23;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error) && !error.empty(), "non-affine fails");
    quad.positions[2].x = 20;
    quad.uv[0].x = -0.1f;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "wrapped UV domain fails");
    quad.uv[0].x = 0;
    quad.uv[0].y = 0.2f;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "non-rectangular UV fails");
    quad.uv[0].y = 0;
    quad.opacity = 0;
    Require(ResolvePreparedAlphaTransform(quad, transform, error), "zero opacity is supported to skip");
    quad.opacity = -1;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "invalid opacity fails");
    auto shortImage = image.View(); shortImage.byteCount = 1;
    Require(!PrepareAlphaMask(shortImage).success, "short source pixel buffer fails");
}
}  // namespace

int main() {
    struct Test { const char* name; void (*run)(); };
    const Test tests[] = {
        {"source-support-and-holes", SourceSupportAndHoles},
        {"support-matches-independent-texel-union", SupportMatchesIndependentTexelUnion},
        {"transform-maps-cropped-corners", TransformMapsCroppedCorners},
        {"unsupported-is-explicit", UnsupportedIsExplicit},
    };
    unsigned passed = 0;
    for (const auto& test : tests) {
        try { test.run(); ++passed; std::cout << "PASS " << test.name << '\n'; }
        catch (const std::exception& error) { std::cerr << "FAIL " << test.name << ": " << error.what() << '\n'; return 1; }
    }
    std::cout << "prepared-alpha-region: " << passed << "/4 passed\n";
    return 0;
}
