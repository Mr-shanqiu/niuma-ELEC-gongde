#include "prepared_alpha_region.h"

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
using Run = std::pair<int, int>;
constexpr int kMaxTextureDimension = 16384;
constexpr std::size_t kMaxRectangles = 262144;
constexpr std::size_t kMaxSourceRuns = 1048576;
#ifdef _WIN32
constexpr std::size_t kMaxQuads = 4096;
#endif

double Milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

void AppendRun(std::vector<Run>& output, const Run& run) {
    if (!output.empty() && run.first <= output.back().second)
        output.back().second = std::max(output.back().second, run.second);
    else
        output.push_back(run);
}

std::vector<Run> MergeRuns(const std::vector<Run>& first, const std::vector<Run>& second) {
    std::vector<Run> output;
    output.reserve(first.size() + second.size());
    std::size_t a = 0, b = 0;
    while (a < first.size() || b < second.size()) {
        if (b == second.size() || (a < first.size() && first[a].first <= second[b].first))
            AppendRun(output, first[a++]);
        else
            AppendRun(output, second[b++]);
    }
    return output;
}

bool AppendBand(const std::vector<Run>& runs, int top, int bottom,
                std::vector<AlphaRegionRect>& output) {
    if (runs.size() > kMaxRectangles - output.size()) return false;
    for (const auto& run : runs) output.push_back({run.first, top, run.second, bottom});
    return true;
}
}  // namespace

PreparedAlphaMask PrepareAlphaMask(const AlphaRegionImageView& image) {
    const auto start = Clock::now();
    PreparedAlphaMask result;
    result.width = image.width;
    result.height = image.height;
    const auto finish = [&](const char* error = nullptr) {
        result.success = error == nullptr;
        if (error) {
            result.error = error;
            result.supportRectangles.clear();
#ifdef _WIN32
            result.nativeWords.clear();
            result.nativeByteCount = 0;
#endif
        }
        result.storageBytes = result.supportRectangles.capacity() * sizeof(AlphaRegionRect);
#ifdef _WIN32
        result.storageBytes += result.nativeWords.capacity() * sizeof(std::uint32_t);
#endif
        result.preparationMs = Milliseconds(start);
        return std::move(result);
    };
    const auto rowBytes = static_cast<std::uint64_t>(image.width) * 4;
    if (!image.bgra || image.width == 0 || image.height == 0 ||
        image.width > kMaxTextureDimension || image.height > kMaxTextureDimension ||
        image.strideBytes < rowBytes ||
        static_cast<std::uint64_t>(image.width) * image.height > 64 * 1024 * 1024 ||
        static_cast<std::uint64_t>(image.height - 1) * image.strideBytes + rowBytes > image.byteCount)
        return finish("prepared alpha image invalid/oversized");
    result.sourcePixels = static_cast<std::uint64_t>(image.width) * image.height;
    try {
        std::vector<std::vector<Run>> rows(image.height);
        std::size_t totalRuns = 0;
        for (std::uint32_t y = 0; y < image.height; ++y) {
            const auto* row = image.bgra + static_cast<std::size_t>(y) * image.strideBytes;
            std::uint32_t x = 0;
            while (x < image.width) {
                while (x < image.width && row[static_cast<std::size_t>(x) * 4 + 3] == 0) ++x;
                const auto begin = x;
                while (x < image.width && row[static_cast<std::size_t>(x) * 4 + 3] != 0) {
                    ++result.nonzeroSourcePixels;
                    ++x;
                }
                if (begin == x) continue;
                AppendRun(rows[y], {std::max(0, static_cast<int>(2 * begin) - 1),
                    std::min(static_cast<int>(2 * image.width), static_cast<int>(2 * x) + 1)});
            }
            totalRuns += rows[y].size();
            if (totalRuns > kMaxSourceRuns) return finish("prepared alpha source-run limit");
        }
        const std::vector<Run> empty;
        std::vector<Run> previous;
        int bandTop = 0;
        // Each expanded source row covers four doubled-coordinate rows. The
        // even row joins this source row with its predecessor, the odd row
        // joins it with its successor. No 2x texture or per-frame mask exists.
        for (int y = 0; y < static_cast<int>(2 * image.height); ++y) {
            const int sourceRow = y / 2;
            const int neighbour = sourceRow + ((y & 1) ? 1 : -1);
            const auto& other = neighbour >= 0 && neighbour < static_cast<int>(image.height)
                ? rows[static_cast<std::size_t>(neighbour)] : empty;
            auto current = MergeRuns(rows[static_cast<std::size_t>(sourceRow)], other);
            if (current != previous) {
                if (!AppendBand(previous, bandTop, y, result.supportRectangles))
                    return finish("prepared alpha rectangle limit");
                previous = std::move(current);
                bandTop = y;
            }
        }
        if (!AppendBand(previous, bandTop, static_cast<int>(2 * image.height), result.supportRectangles))
            return finish("prepared alpha rectangle limit");
#ifdef _WIN32
        AlphaRegionResult source;
        source.success = true;
        source.width = static_cast<int>(2 * image.width);
        source.height = static_cast<int>(2 * image.height);
        source.rectangles = std::move(result.supportRectangles);
        auto data = MakeAlphaRegionData(source);
        result.supportRectangles = std::move(source.rectangles);
        if (!data.success) return finish("prepared alpha native serialization failed");
        result.nativeWords = std::move(data.words);
        result.nativeByteCount = data.byteCount;
#endif
    } catch (const std::bad_alloc&) {
        return finish("prepared alpha allocation failed");
    }
    return finish();
}

bool ResolvePreparedAlphaTransform(const PreparedAlphaQuad& quad,
                                   PreparedAlphaAffine& transform,
                                   std::string& error) {
    const auto fail = [&](const char* message) { error = message; return false; };
    if (!quad.mask || !quad.mask->success || !quad.mask->width || !quad.mask->height ||
        !std::isfinite(quad.opacity) || quad.opacity < 0 || quad.opacity > 1 ||
        (quad.scissor && (quad.scissor->width < 0 || quad.scissor->height < 0)))
        return fail("prepared alpha mask/opacity/scissor invalid");
    for (std::size_t i = 0; i < 4; ++i) {
        if (!std::isfinite(quad.positions[i].x) || !std::isfinite(quad.positions[i].y) ||
            std::abs(quad.positions[i].x) > 16777216 || std::abs(quad.positions[i].y) > 16777216 ||
            !std::isfinite(quad.uv[i].x) || !std::isfinite(quad.uv[i].y) ||
            quad.uv[i].x < 0 || quad.uv[i].x > 1 || quad.uv[i].y < 0 || quad.uv[i].y > 1)
            return fail("prepared alpha finite coordinates/UV domain unsupported");
    }
    constexpr double uvTolerance = 1e-7;
    if (std::abs(quad.uv[0].y - quad.uv[1].y) > uvTolerance ||
        std::abs(quad.uv[3].y - quad.uv[2].y) > uvTolerance ||
        std::abs(quad.uv[0].x - quad.uv[3].x) > uvTolerance ||
        std::abs(quad.uv[1].x - quad.uv[2].x) > uvTolerance)
        return fail("prepared alpha requires rectangular UV crop");
    const double ux = static_cast<double>(quad.positions[1].x) - quad.positions[0].x;
    const double uy = static_cast<double>(quad.positions[1].y) - quad.positions[0].y;
    const double vx = static_cast<double>(quad.positions[3].x) - quad.positions[0].x;
    const double vy = static_cast<double>(quad.positions[3].y) - quad.positions[0].y;
    if (std::abs(quad.positions[0].x + ux + vx - quad.positions[2].x) > 0.001 ||
        std::abs(quad.positions[0].y + uy + vy - quad.positions[2].y) > 0.001)
        return fail("prepared alpha non-affine quad unsupported");
    const double du = static_cast<double>(quad.uv[1].x) - quad.uv[0].x;
    const double dv = static_cast<double>(quad.uv[3].y) - quad.uv[0].y;
    if (du == 0 || dv == 0 || ux * vy - uy * vx == 0)
        return fail("prepared alpha degenerate transform unsupported");
    transform.xx = ux / (du * 2 * quad.mask->width);
    transform.xy = uy / (du * 2 * quad.mask->width);
    transform.yx = vx / (dv * 2 * quad.mask->height);
    transform.yy = vy / (dv * 2 * quad.mask->height);
    transform.tx = quad.positions[0].x - ux * quad.uv[0].x / du - vx * quad.uv[0].y / dv;
    transform.ty = quad.positions[0].y - uy * quad.uv[0].x / du - vy * quad.uv[0].y / dv;
    const double values[] = {transform.xx, transform.xy, transform.yx, transform.yy,
                             transform.tx, transform.ty};
    for (double value : values) {
        if (!std::isfinite(value) || std::abs(value) > 16777216)
            return fail("prepared alpha transformed region range unsupported");
    }
    error.clear();
    return true;
}

#ifdef _WIN32
namespace {
struct Region {
    HRGN value = nullptr;
    ~Region() { if (value) DeleteObject(value); }
    Region(const Region&) = delete;
    Region& operator=(const Region&) = delete;
    explicit Region(HRGN initial = nullptr) : value(initial) {}
};

bool Combine(HRGN destination, HRGN first, HRGN second, int mode) {
    return CombineRgn(destination, first, second, mode) != ERROR;
}

bool DilateOnePixel(HRGN region) {
    Region shifted(CreateRectRgn(0, 0, 0, 0));
    if (!shifted.value || !Combine(shifted.value, region, nullptr, RGN_COPY) ||
        OffsetRgn(shifted.value, -1, 0) == ERROR ||
        !Combine(region, region, shifted.value, RGN_OR) ||
        OffsetRgn(shifted.value, 2, 0) == ERROR ||
        !Combine(region, region, shifted.value, RGN_OR) ||
        !Combine(shifted.value, region, nullptr, RGN_COPY) ||
        OffsetRgn(shifted.value, 0, -1) == ERROR ||
        !Combine(region, region, shifted.value, RGN_OR) ||
        OffsetRgn(shifted.value, 0, 2) == ERROR ||
        !Combine(region, region, shifted.value, RGN_OR)) return false;
    return true;
}

HRGN QuadDomain(const PreparedAlphaQuad& quad) {
    // A high-resolution unit square avoids pre-rounding each transformed
    // corner to integer pixels. GDI performs the same affine region transform.
    struct SingleRect { RGNDATAHEADER header; RECT rect; } data{};
    constexpr LONG unit = 65536;
    data.header.dwSize = sizeof(RGNDATAHEADER);
    data.header.iType = RDH_RECTANGLES;
    data.header.nCount = 1;
    data.header.nRgnSize = sizeof(RECT);
    data.header.rcBound = data.rect = {0, 0, unit, unit};
    const XFORM transform{
        (quad.positions[1].x - quad.positions[0].x) / unit,
        (quad.positions[1].y - quad.positions[0].y) / unit,
        (quad.positions[3].x - quad.positions[0].x) / unit,
        (quad.positions[3].y - quad.positions[0].y) / unit,
        quad.positions[0].x, quad.positions[0].y};
    return ExtCreateRegion(&transform, sizeof(data), reinterpret_cast<const RGNDATA*>(&data));
}

bool ReadNativeRegion(HRGN region, int width, int height, AlphaRegionResult& output) {
    const DWORD bytes = GetRegionData(region, 0, nullptr);
    if (bytes < sizeof(RGNDATAHEADER) ||
        bytes > sizeof(RGNDATAHEADER) + kMaxRectangles * sizeof(RECT)) return false;
    std::vector<std::uint32_t> words((bytes + sizeof(std::uint32_t) - 1) / sizeof(std::uint32_t));
    auto* data = reinterpret_cast<RGNDATA*>(words.data());
    if (GetRegionData(region, bytes, data) != bytes || data->rdh.iType != RDH_RECTANGLES ||
        data->rdh.nCount > kMaxRectangles ||
        sizeof(RGNDATAHEADER) + static_cast<std::size_t>(data->rdh.nCount) * sizeof(RECT) > bytes)
        return false;
    output = {};
    output.width = width;
    output.height = height;
    output.rectangles.reserve(data->rdh.nCount);
    const auto* rectangles = reinterpret_cast<const RECT*>(data->Buffer);
    for (DWORD i = 0; i < data->rdh.nCount; ++i) {
        const auto& rect = rectangles[i];
        if (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height ||
            rect.right <= rect.left || rect.bottom <= rect.top) return false;
        output.rectangles.push_back({rect.left, rect.top, rect.right, rect.bottom});
        output.stats.coveredPixels += static_cast<std::uint64_t>(rect.right - rect.left) *
                                     static_cast<std::uint64_t>(rect.bottom - rect.top);
    }
    output.stats.rectangleCount = output.rectangles.size();
    output.success = true;
    return true;
}
}  // namespace

PreparedAlphaQuad FromRendererPreparedQuad(const Quad& quad, const PreparedAlphaMask& mask) {
    PreparedAlphaQuad result;
    result.mask = &mask;
    result.opacity = quad.opacity;
    for (std::size_t i = 0; i < 4; ++i) {
        result.positions[i] = {quad.positions[i].x, quad.positions[i].y};
        result.uv[i] = {quad.uv[i].x, quad.uv[i].y};
    }
    if (quad.scissor) result.scissor = AlphaRegionScissor{
        quad.scissor->x, quad.scissor->y, quad.scissor->width, quad.scissor->height};
    return result;
}

PreparedAlphaRegionResult::~PreparedAlphaRegionResult() { if (region) DeleteObject(region); }
PreparedAlphaRegionResult::PreparedAlphaRegionResult(PreparedAlphaRegionResult&& other) noexcept {
    *this = std::move(other);
}
PreparedAlphaRegionResult& PreparedAlphaRegionResult::operator=(PreparedAlphaRegionResult&& other) noexcept {
    if (this == &other) return *this;
    if (region) DeleteObject(region);
    success = other.success;
    error = std::move(other.error);
    region = std::exchange(other.region, nullptr);
    raster = std::move(other.raster);
    stats = other.stats;
    other.success = false;
    return *this;
}
HRGN PreparedAlphaRegionResult::ReleaseRegion() noexcept { return std::exchange(region, nullptr); }

PreparedAlphaRegionResult BuildPreparedAlphaRegion(
    int width, int height, const std::vector<PreparedAlphaQuad>& quads) {
    const auto start = Clock::now();
    PreparedAlphaRegionResult result;
    const auto finish = [&](const std::string& error = {}) {
        result.success = error.empty();
        result.error = error;
        result.stats.transformMs = Milliseconds(start);
        result.raster.stats.rasterMs = result.stats.transformMs;
        if (!result.success) {
            if (result.region) DeleteObject(result.region);
            result.region = nullptr;
            result.raster = {};
        }
        return std::move(result);
    };
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || quads.size() > kMaxQuads)
        return finish("prepared alpha surface/quad limit");
    try {
        result.region = CreateRectRgn(0, 0, 0, 0);
        Region undilated(CreateRectRgn(0, 0, 0, 0));
        if (!result.region || !undilated.value) return finish("create prepared alpha destination failed");
        for (const auto& quad : quads) {
            PreparedAlphaAffine affine;
            std::string error;
            if (!ResolvePreparedAlphaTransform(quad, affine, error)) return finish(error);
            if (quad.opacity == 0 || quad.mask->supportRectangles.empty()) continue;
            if (quad.mask->nativeByteCount == 0 || quad.mask->nativeWords.empty())
                return finish("prepared alpha native data missing");
            const XFORM transform{static_cast<float>(affine.xx), static_cast<float>(affine.xy),
                static_cast<float>(affine.yx), static_cast<float>(affine.yy),
                static_cast<float>(affine.tx), static_cast<float>(affine.ty)};
            Region layer(ExtCreateRegion(&transform, quad.mask->nativeByteCount,
                reinterpret_cast<const RGNDATA*>(quad.mask->nativeWords.data())));
            Region domain(QuadDomain(quad));
            if (!layer.value || !domain.value) return finish("native alpha transform failed");
            ++result.stats.transformedMasks;
            int left = 0, top = 0, right = width, bottom = height;
            if (quad.scissor) {
                const auto& scissor = *quad.scissor;
                left = std::clamp(scissor.x, 0, width);
                top = std::clamp(scissor.y, 0, height);
                right = static_cast<int>(std::clamp<std::int64_t>(
                    static_cast<std::int64_t>(scissor.x) + scissor.width, 0, width));
                bottom = static_cast<int>(std::clamp<std::int64_t>(
                    static_cast<std::int64_t>(scissor.y) + scissor.height, 0, height));
            }
            Region clip(CreateRectRgn(left, top, right, bottom));
            if (!clip.value || !Combine(layer.value, layer.value, domain.value, RGN_AND) ||
                !Combine(layer.value, layer.value, clip.value, RGN_AND) ||
                !Combine(undilated.value, undilated.value, layer.value, RGN_OR) ||
                !DilateOnePixel(layer.value) ||
                !Combine(layer.value, layer.value, clip.value, RGN_AND) ||
                !Combine(result.region, result.region, layer.value, RGN_OR))
                return finish("native alpha clip/dilate/union failed");
        }
        AlphaRegionResult raw;
        if (!ReadNativeRegion(result.region, width, height, result.raster) ||
            !ReadNativeRegion(undilated.value, width, height, raw))
            return finish("native alpha result query failed");
        result.stats.coveredPixels = result.raster.stats.coveredPixels;
        result.stats.rectangleCount = result.raster.rectangles.size();
        result.stats.conservativePixels = result.stats.coveredPixels - raw.stats.coveredPixels;
        result.raster.stats.conservativePixels = result.stats.conservativePixels;
    } catch (const std::bad_alloc&) {
        return finish("prepared alpha frame allocation failed");
    }
    return finish();
}
#endif

}  // namespace niuma::runtime
