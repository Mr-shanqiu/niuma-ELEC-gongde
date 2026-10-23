#include "alpha_region.h"

#ifdef _WIN32
#include "d3d11_renderer.h"
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <new>
#include <utility>

namespace niuma::runtime {
namespace {
using Clock = std::chrono::steady_clock;
constexpr int kMaxDimension = 16384;
constexpr std::uint64_t kMaxMaskPixels = 16 * 1024 * 1024;
constexpr std::uint64_t kMaxPixelTests = 64 * 1024 * 1024;
constexpr std::uint64_t kMaxTexelTests = 256 * 1024 * 1024;
constexpr std::size_t kMaxRectangles = 262144;
constexpr std::size_t kMaxQuads = 4096;

double ElapsedMs(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

bool ValidImage(const AlphaRegionImageView& image) {
    const auto row = static_cast<std::uint64_t>(image.width) * 4;
    if (!image.bgra || image.width == 0 || image.height == 0 ||
        image.width > kMaxDimension || image.height > kMaxDimension ||
        image.strideBytes < row) return false;
    const auto required = static_cast<std::uint64_t>(image.height - 1) *
                          image.strideBytes + row;
    return required <= image.byteCount;
}

struct Triangle {
    double x[3]{}, y[3]{}, u[3]{}, v[3]{};
    double area = 0;
    double edgeTolerance[3]{};
    double uAllowance = 0;
    double vAllowance = 0;

    Triangle(const AlphaRegionQuad& quad, int a, int b, int c,
             double positionAllowance) {
        const int indices[] = {a, b, c};
        double largestU = 1, largestV = 1;
        for (int i = 0; i < 3; ++i) {
            const int source = indices[i];
            x[i] = quad.positions[source].x;
            y[i] = quad.positions[source].y;
            u[i] = quad.uv[source].x;
            v[i] = quad.uv[source].y;
            largestU = std::max(largestU, std::abs(u[i]));
            largestV = std::max(largestV, std::abs(v[i]));
        }
        area = (x[1] - x[0]) * (y[2] - y[0]) -
               (y[1] - y[0]) * (x[2] - x[0]);
        if (area == 0) return;
        for (int i = 0; i < 3; ++i) {
            const int j = (i + 1) % 3, k = (i + 2) % 3;
            edgeTolerance[i] = positionAllowance *
                (std::abs(x[j] - x[k]) + std::abs(y[j] - y[k])) /
                std::abs(area);
        }
        const auto gradients = [&](const double values[3]) {
            const double dx = (values[0] * (y[1] - y[2]) +
                values[1] * (y[2] - y[0]) + values[2] * (y[0] - y[1])) / area;
            const double dy = (values[0] * (x[2] - x[1]) +
                values[1] * (x[0] - x[2]) + values[2] * (x[1] - x[0])) / area;
            return std::abs(dx) + std::abs(dy);
        };
        // Allow the 8-bit subpixel rasterizer and float interpolation to land
        // on either side of a CPU-computed sample. This is a conservative
        // support interval, not a claim of bit-exact hardware sampling.
        constexpr double floatAllowance = 16 * std::numeric_limits<float>::epsilon();
        uAllowance = gradients(u) * positionAllowance + largestU * floatAllowance;
        vAllowance = gradients(v) * positionAllowance + largestV * floatAllowance;
    }

    bool SamplePoint(double px, double py, double& outU, double& outV,
                     bool& exactInside) const {
        if (area == 0) return false;
        double weights[3]{};
        exactInside = true;
        for (int i = 0; i < 3; ++i) {
            const int j = (i + 1) % 3, k = (i + 2) % 3;
            weights[i] = ((x[j] - px) * (y[k] - py) -
                          (y[j] - py) * (x[k] - px)) / area;
            if (weights[i] < -edgeTolerance[i]) return false;
            if (weights[i] < 0) exactInside = false;
        }
        outU = weights[0] * u[0] + weights[1] * u[1] + weights[2] * u[2];
        outV = weights[0] * v[0] + weights[1] * v[1] + weights[2] * v[2];
        return true;
    }
};

// A texel participates in linear filtering whenever its distance from the
// sample is less than one texel. Integer endpoints have zero outer weight and
// are omitted by floor/ceil. CLAMP means out-of-range UVs sample edge texels.
bool PositiveSupport(const AlphaRegionImageView& image, double u, double v,
                     double uAllowance, double vAllowance,
                     AlphaRegionStats& stats, bool& exhausted) {
    const auto bounds = [](double coord, double allowance, std::uint32_t size) {
        const double low = std::clamp(coord - allowance, 0.0, 1.0) * size - 0.5;
        const double high = std::clamp(coord + allowance, 0.0, 1.0) * size - 0.5;
        const int maximum = static_cast<int>(size) - 1;
        return std::pair<int, int>{
            std::clamp(static_cast<int>(std::floor(low)), 0, maximum),
            std::clamp(static_cast<int>(std::ceil(high)), 0, maximum)};
    };
    const auto xs = bounds(u, uAllowance, image.width);
    const auto ys = bounds(v, vAllowance, image.height);
    for (int y = ys.first; y <= ys.second; ++y) {
        const auto* row = image.bgra + static_cast<std::size_t>(y) * image.strideBytes;
        for (int x = xs.first; x <= xs.second; ++x) {
            if (++stats.sampledTexels > kMaxTexelTests) {
                exhausted = true;
                return false;
            }
            if (row[static_cast<std::size_t>(x) * 4 + 3] != 0) return true;
        }
    }
    return false;
}

using Run = std::pair<int, int>;

bool AppendBand(const std::vector<Run>& runs, int top, int bottom,
                std::vector<AlphaRegionRect>& rectangles) {
    if (runs.size() > kMaxRectangles - rectangles.size()) return false;
    for (const auto& run : runs) rectangles.push_back({run.first, top, run.second, bottom});
    return true;
}
}  // namespace

AlphaRegionResult RasterizeAlphaRegion(
    int width, int height, const std::vector<AlphaRegionQuad>& quads) {
    const auto start = Clock::now();
    AlphaRegionResult result;
    result.width = width;
    result.height = height;
    const auto finish = [&](const char* error = nullptr) {
        result.success = error == nullptr;
        if (error) {
            result.error = error;
            result.rectangles.clear();
        }
        result.stats.rectangleCount = result.rectangles.size();
        result.stats.rasterMs = ElapsedMs(start);
        return std::move(result);
    };
    if (width <= 0 || height <= 0 || width > kMaxDimension || height > kMaxDimension ||
        static_cast<std::uint64_t>(width) * height > kMaxMaskPixels ||
        quads.size() > kMaxQuads) return finish("alpha region surface/quad limit");
    for (const auto& quad : quads) {
        if (!ValidImage(quad.image) || !std::isfinite(quad.opacity) ||
            quad.opacity < 0 || quad.opacity > 1 ||
            (quad.scissor && (quad.scissor->width < 0 || quad.scissor->height < 0))) {
            return finish("alpha region image/opacity/scissor invalid");
        }
        for (int i = 0; i < 4; ++i) {
            if (!std::isfinite(quad.positions[i].x) || !std::isfinite(quad.positions[i].y) ||
                !std::isfinite(quad.uv[i].x) || !std::isfinite(quad.uv[i].y)) {
                return finish("alpha region vertex invalid");
            }
        }
    }
    try {
        // 0 = transparent, 1 = positive mathematical sample, 2 = tolerance only.
        std::vector<std::uint8_t> mask(static_cast<std::size_t>(width) * height, 0);
        const double positionAllowance = 1.0 / 128.0 +
            std::max(width, height) * 2.0 * std::numeric_limits<float>::epsilon();
        for (const auto& quad : quads) {
            if (quad.opacity == 0) continue;
            int left = 0, top = 0, right = width, bottom = height;
            if (quad.scissor) {
                const auto& clip = *quad.scissor;
                left = std::clamp(clip.x, 0, width);
                top = std::clamp(clip.y, 0, height);
                right = static_cast<int>(std::clamp<std::int64_t>(
                    static_cast<std::int64_t>(clip.x) + clip.width, 0, width));
                bottom = static_cast<int>(std::clamp<std::int64_t>(
                    static_cast<std::int64_t>(clip.y) + clip.height, 0, height));
            }
            double minX = quad.positions[0].x, maxX = minX;
            double minY = quad.positions[0].y, maxY = minY;
            for (const auto& point : quad.positions) {
                minX = std::min(minX, static_cast<double>(point.x));
                maxX = std::max(maxX, static_cast<double>(point.x));
                minY = std::min(minY, static_cast<double>(point.y));
                maxY = std::max(maxY, static_cast<double>(point.y));
            }
            left = std::max(left, static_cast<int>(std::floor(std::clamp(
                minX - positionAllowance, 0.0, static_cast<double>(width)))));
            top = std::max(top, static_cast<int>(std::floor(std::clamp(
                minY - positionAllowance, 0.0, static_cast<double>(height)))));
            right = std::min(right, static_cast<int>(std::ceil(std::clamp(
                maxX + positionAllowance, 0.0, static_cast<double>(width)))));
            bottom = std::min(bottom, static_cast<int>(std::ceil(std::clamp(
                maxY + positionAllowance, 0.0, static_cast<double>(height)))));
            const Triangle triangles[] = {
                {quad, 0, 1, 2, positionAllowance},
                {quad, 0, 2, 3, positionAllowance},
            };
            for (int y = top; y < bottom; ++y) {
                for (int x = left; x < right; ++x) {
                    auto& pixel = mask[static_cast<std::size_t>(y) * width + x];
                    if (pixel == 1) continue;
                    if (++result.stats.testedPixels > kMaxPixelTests) {
                        return finish("alpha region pixel-work limit");
                    }
                    for (const auto& triangle : triangles) {
                        double u = 0, v = 0;
                        bool exactInside = false, exhausted = false;
                        if (!triangle.SamplePoint(x + 0.5, y + 0.5, u, v, exactInside)) continue;
                        if (exactInside && PositiveSupport(quad.image, u, v, 0, 0,
                                                           result.stats, exhausted)) {
                            pixel = 1;
                            break;
                        }
                        if (exhausted) return finish("alpha region texel-work limit");
                        const double uMargin = triangle.uAllowance + 1.0 / (256.0 * quad.image.width);
                        const double vMargin = triangle.vAllowance + 1.0 / (256.0 * quad.image.height);
                        if (PositiveSupport(quad.image, u, v, uMargin, vMargin,
                                            result.stats, exhausted)) pixel = 2;
                        if (exhausted) return finish("alpha region texel-work limit");
                    }
                }
            }
        }
        std::vector<Run> previousRuns;
        int bandTop = 0;
        for (int y = 0; y < height; ++y) {
            std::vector<Run> runs;
            const auto* row = mask.data() + static_cast<std::size_t>(y) * width;
            int x = 0;
            while (x < width) {
                while (x < width && row[x] == 0) ++x;
                const int begin = x;
                while (x < width && row[x] != 0) {
                    ++result.stats.coveredPixels;
                    if (row[x] == 2) ++result.stats.conservativePixels;
                    ++x;
                }
                if (begin != x) runs.emplace_back(begin, x);
            }
            if (runs != previousRuns) {
                if (!AppendBand(previousRuns, bandTop, y, result.rectangles)) {
                    return finish("alpha region rectangle limit");
                }
                previousRuns = std::move(runs);
                bandTop = y;
            }
        }
        if (!AppendBand(previousRuns, bandTop, height, result.rectangles)) {
            return finish("alpha region rectangle limit");
        }
    } catch (const std::bad_alloc&) {
        return finish("alpha region allocation failed");
    }
    return finish();
}

#ifdef _WIN32
AlphaRegionQuad FromRendererQuad(const Quad& quad, const PixelImage& image) {
    AlphaRegionQuad converted;
    converted.image = {image.bgraPremultiplied.data(), image.bgraPremultiplied.size(),
                       image.width, image.height, image.strideBytes};
    for (int i = 0; i < 4; ++i) {
        converted.positions[i] = {quad.positions[i].x, quad.positions[i].y};
        converted.uv[i] = {quad.uv[i].x, quad.uv[i].y};
    }
    converted.opacity = quad.opacity;
    if (quad.scissor) converted.scissor = AlphaRegionScissor{
        quad.scissor->x, quad.scissor->y, quad.scissor->width, quad.scissor->height};
    return converted;
}

AlphaRegionData MakeAlphaRegionData(const AlphaRegionResult& region) {
    const auto start = Clock::now();
    AlphaRegionData data;
    const auto fail = [&](const char* error) {
        data.error = error;
        data.words.clear();
        data.byteCount = 0;
        data.serializeMs = ElapsedMs(start);
        return std::move(data);
    };
    if (!region.success || region.rectangles.size() > kMaxRectangles) {
        return fail("cannot serialize failed/oversized alpha region");
    }
    const auto rectangleBytes = region.rectangles.size() * sizeof(RECT);
    const auto totalBytes = sizeof(RGNDATAHEADER) + rectangleBytes;
    if (totalBytes > std::numeric_limits<DWORD>::max()) return fail("region data exceeds DWORD");
    try {
        data.words.resize((totalBytes + sizeof(std::uint32_t) - 1) / sizeof(std::uint32_t));
    } catch (const std::bad_alloc&) {
        return fail("region data allocation failed");
    }
    RGNDATAHEADER header{};
    header.dwSize = sizeof(RGNDATAHEADER);
    header.iType = RDH_RECTANGLES;
    header.nCount = static_cast<DWORD>(region.rectangles.size());
    header.nRgnSize = static_cast<DWORD>(rectangleBytes);
    bool first = true;
    auto* destination = reinterpret_cast<std::uint8_t*>(data.words.data()) + sizeof(header);
    for (const auto& rect : region.rectangles) {
        if (rect.left < 0 || rect.top < 0 || rect.right > region.width ||
            rect.bottom > region.height || rect.right <= rect.left || rect.bottom <= rect.top) {
            return fail("invalid alpha region rectangle");
        }
        const RECT native{rect.left, rect.top, rect.right, rect.bottom};
        std::memcpy(destination, &native, sizeof(native));
        destination += sizeof(native);
        if (first) {
            header.rcBound = native;
            first = false;
        } else {
            header.rcBound.left = std::min(header.rcBound.left, native.left);
            header.rcBound.top = std::min(header.rcBound.top, native.top);
            header.rcBound.right = std::max(header.rcBound.right, native.right);
            header.rcBound.bottom = std::max(header.rcBound.bottom, native.bottom);
        }
    }
    std::memcpy(data.words.data(), &header, sizeof(header));
    data.byteCount = static_cast<std::uint32_t>(totalBytes);
    data.success = true;
    data.serializeMs = ElapsedMs(start);
    return data;
}
#endif

}  // namespace niuma::runtime
