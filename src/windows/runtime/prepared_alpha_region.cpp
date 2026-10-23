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
constexpr std::size_t kMaxQuads = 4096;

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

static PreparedAlphaMask PrepareThresholdMask(const AlphaRegionImageView& image, std::uint8_t threshold) {
    const auto start = Clock::now();
    PreparedAlphaMask result;
    result.width = image.width;
    result.height = image.height;
    const auto finish = [&](const char* error = nullptr) {
        result.success = error == nullptr;
        if (error) {
            result.error = error;
            result.supportRectangles.clear();

        }
        result.storageBytes = result.supportRectangles.capacity() * sizeof(AlphaRegionRect);

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
                while (x < image.width && row[static_cast<std::size_t>(x) * 4 + 3] < threshold) ++x;
                const auto begin = x;
                while (x < image.width && row[static_cast<std::size_t>(x) * 4 + 3] >= threshold) {
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

    } catch (const std::bad_alloc&) {
        return finish("prepared alpha allocation failed");
    }
    return finish();
}

PreparedAlphaMask PrepareAlphaMask(const AlphaRegionImageView& image) {
    const auto start = Clock::now();
    auto result = PrepareThresholdMask(image,1);
    if (!result.success) return result;
    auto strong = PrepareThresholdMask(image,2);
    if (!strong.success) return strong;
    try {
        result.strongSupportRectangles = std::move(strong.supportRectangles);
        result.sourceAlpha.resize(static_cast<std::size_t>(image.width)*image.height);
        for (std::uint32_t y=0;y<image.height;++y) for(std::uint32_t x=0;x<image.width;++x)
            result.sourceAlpha[static_cast<std::size_t>(y)*image.width+x]=image.bgra[static_cast<std::size_t>(y)*image.strideBytes+x*4+3];
        result.storageBytes = (result.supportRectangles.capacity()+result.strongSupportRectangles.capacity())*sizeof(AlphaRegionRect)+result.sourceAlpha.capacity();
        result.preparationMs = Milliseconds(start);
    } catch (const std::bad_alloc&) { result.success=false; result.error="prepared alpha coverage allocation failed"; }
    return result;
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

// Scan-convert only prepared support rectangles. Native transformed HRGNs can
// drop a thin source band entirely during minification; growing that already
// empty result cannot recover the visible sample. Keep subpixel geometry until
// the destination scanline is known instead.
namespace {
bool SpanAtRow(const std::array<AlphaRegionPoint, 4>& points, double centerY,
               double allowance, double& left, double& right) {
    const double low = centerY - allowance, high = centerY + allowance;
    left = std::numeric_limits<double>::infinity();
    right = -left;
    const auto include = [&](double x) { left = std::min(left, x); right = std::max(right, x); };
    for (std::size_t i = 0; i < 4; ++i) {
        const auto& a = points[i]; const auto& b = points[(i + 1) % 4];
        if (a.y >= low && a.y <= high) include(a.x);
        if (a.y == b.y) continue;
        for (const auto boundary : {low, high}) {
            const double t = (boundary - a.y) / (static_cast<double>(b.y) - a.y);
            if (t >= 0 && t <= 1) include(a.x + t * (static_cast<double>(b.x) - a.x));
        }
    }
    return left <= right;
}
}

static AlphaRegionResult TransformSupport(
    int width, int height, const std::vector<PreparedAlphaQuad>& quads, bool strong) {
    const auto start = Clock::now();
    AlphaRegionResult result;
    result.width = width; result.height = height;
    const auto finish = [&](const std::string& error = {}) {
        result.success = error.empty(); result.error = error;
        result.stats.rasterMs = Milliseconds(start);
        result.stats.rectangleCount = result.rectangles.size();
        if (!result.success) result.rectangles.clear();
        return std::move(result);
    };
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || quads.size() > kMaxQuads)
        return finish("prepared alpha surface/quad limit");
    try {
        std::vector<std::vector<Run>> rows(static_cast<std::size_t>(height));
        const double allowance = 1.0 / 128.0 + std::max(width, height) *
            2.0 * std::numeric_limits<float>::epsilon();
        std::size_t work = 0;
        for (const auto& quad : quads) {
            PreparedAlphaAffine affine;
            std::string error;
            if (!ResolvePreparedAlphaTransform(quad, affine, error)) return finish(error);
            if (quad.opacity == 0) continue;
            int clipLeft = 0, clipTop = 0, clipRight = width, clipBottom = height;
            if (quad.scissor) {
                const auto& sc = *quad.scissor;
                clipLeft = std::clamp(sc.x, 0, width); clipTop = std::clamp(sc.y, 0, height);
                clipRight = static_cast<int>(std::clamp<std::int64_t>(static_cast<std::int64_t>(sc.x)+sc.width, 0, width));
                clipBottom = static_cast<int>(std::clamp<std::int64_t>(static_cast<std::int64_t>(sc.y)+sc.height, 0, height));
            }
            if (clipLeft >= clipRight || clipTop >= clipBottom) continue;
            // Domain spans are reused for every prepared rectangle in this quad.
            std::vector<std::pair<double,double>> domain(static_cast<std::size_t>(clipBottom-clipTop));
            for (int y=clipTop;y<clipBottom;++y) {
                double left=0,right=0;
                if (!SpanAtRow(quad.positions,y+0.5,allowance,left,right)) left=1,right=0;
                domain[static_cast<std::size_t>(y-clipTop)]={left,right};
            }
            // Support epsilon covers 8-bit subtexel interpolation and float UV
            // arithmetic; this is not a whole destination-pixel dilation.
            const double sx = 1.0 / 128.0 + 32 * std::numeric_limits<float>::epsilon() * quad.mask->width;
            const double sy = 1.0 / 128.0 + 32 * std::numeric_limits<float>::epsilon() * quad.mask->height;
            for (const auto& rect : (strong ? quad.mask->strongSupportRectangles : quad.mask->supportRectangles)) {
                const double xs[] = {rect.left-sx, rect.right+sx};
                const double ys[] = {rect.top-sy, rect.bottom+sy};
                std::array<AlphaRegionPoint,4> polygon{};
                const int xi[] = {0,1,1,0}, yi[] = {0,0,1,1};
                double minY=std::numeric_limits<double>::infinity(),maxY=-minY;
                for (int i=0;i<4;++i) {
                    const double x=affine.xx*xs[xi[i]]+affine.yx*ys[yi[i]]+affine.tx;
                    const double y=affine.xy*xs[xi[i]]+affine.yy*ys[yi[i]]+affine.ty;
                    polygon[i]={static_cast<float>(x),static_cast<float>(y)};
                    minY=std::min(minY,y); maxY=std::max(maxY,y);
                }
                const int top=static_cast<int>(std::clamp(std::ceil(minY-0.5-allowance),static_cast<double>(clipTop),static_cast<double>(clipBottom)));
                const int bottom=static_cast<int>(std::clamp(std::floor(maxY-0.5+allowance)+1,static_cast<double>(clipTop),static_cast<double>(clipBottom)));
                for (int y=top;y<bottom;++y) {
                    if (++work>8*1024*1024) return finish("prepared alpha span-work limit");
                    const auto& bounds=domain[static_cast<std::size_t>(y-clipTop)];
                    if (bounds.first>bounds.second) continue;
                    double left=0,right=0;
                    if (!SpanAtRow(polygon,y+0.5,allowance,left,right)) continue;
                    left=std::max(left,bounds.first)-allowance;
                    right=std::min(right,bounds.second)+allowance;
                    if (left>right) continue;
                    const int x0=static_cast<int>(std::clamp(std::ceil(left-0.5),static_cast<double>(clipLeft),static_cast<double>(clipRight)));
                    const int x1=static_cast<int>(std::clamp(std::floor(right-0.5)+1,static_cast<double>(clipLeft),static_cast<double>(clipRight)));
                    if (x0<x1) rows[static_cast<std::size_t>(y)].emplace_back(x0,x1);
                }
            }
        }
        std::vector<Run> previous;
        int bandTop=0;
        for (int y=0;y<height;++y) {
            auto& raw=rows[static_cast<std::size_t>(y)];
            std::sort(raw.begin(),raw.end());
            std::vector<Run> merged;
            for (const auto& span:raw) AppendRun(merged,span);
            for (const auto& span:merged) result.stats.coveredPixels+=static_cast<std::uint64_t>(span.second-span.first);
            if (merged!=previous) {
                if (!AppendBand(previous,bandTop,y,result.rectangles)) return finish("prepared alpha rectangle limit");
                previous=std::move(merged); bandTop=y;
            }
        }
        if (!AppendBand(previous,bandTop,height,result.rectangles)) return finish("prepared alpha rectangle limit");
    } catch(const std::bad_alloc&) { return finish("prepared alpha frame allocation failed"); }
    return finish();
}

namespace {
struct AlphaSampler {
    const PreparedAlphaQuad* quad;
    PreparedAlphaAffine transform;
    double determinant = 0;
};
// Evaluate only the weak-only fragments, where every contributing source
// texel is alpha 0 or 1. Solid shape interiors retain span operations.
std::uint32_t WeakCoverageByte(int x, int y, const AlphaSampler& item,
                               std::uint64_t& sampledTexels) {
    const auto& q=*item.quad; const auto& m=*q.mask; const auto& f=item.transform;
    if(q.opacity==0) return 0;
    if(q.scissor && (x<q.scissor->x || y<q.scissor->y ||
        static_cast<std::int64_t>(x)>=static_cast<std::int64_t>(q.scissor->x)+q.scissor->width ||
        static_cast<std::int64_t>(y)>=static_cast<std::int64_t>(q.scissor->y)+q.scissor->height)) return 0;
    const double dx=x+0.5-f.tx,dy=y+0.5-f.ty;
    const double sx=(f.yy*dx-f.yx*dy)/item.determinant/2;
    const double sy=(-f.xy*dx+f.xx*dy)/item.determinant/2;
    const auto u0=std::min(q.uv[0].x,q.uv[1].x)*m.width, u1=std::max(q.uv[0].x,q.uv[1].x)*m.width;
    const auto v0=std::min(q.uv[0].y,q.uv[3].y)*m.height, v1=std::max(q.uv[0].y,q.uv[3].y)*m.height;
    if(sx<u0 || sx>u1 || sy<v0 || sy>v1) return 0;
    const double tx=sx-0.5,ty=sy-0.5;
    const int ix=static_cast<int>(std::floor(tx)),iy=static_cast<int>(std::floor(ty));
    const double fx=tx-ix,fy=ty-iy;
    const auto alpha=[&](int px,int py) {
        px=std::clamp(px,0,static_cast<int>(m.width)-1); py=std::clamp(py,0,static_cast<int>(m.height)-1);
        return static_cast<double>(m.sourceAlpha[static_cast<std::size_t>(py)*m.width+px]);
    };
    sampledTexels += 4;
    const double a=((1-fy)*((1-fx)*alpha(ix,iy)+fx*alpha(ix+1,iy))+
        fy*((1-fx)*alpha(ix,iy+1)+fx*alpha(ix+1,iy+1)))*q.opacity;
    // A single quantization decision serves both the native region and shader.
    // No driver-dependent epsilon and no hardware Sample threshold assumption.
    return static_cast<std::uint32_t>(std::floor(a+0.5));
}
}

AlphaRegionResult TransformPreparedAlphaRegion(
    int width,int height,const std::vector<PreparedAlphaQuad>& quads,
    WeakAlphaOverrides* weakOverrides) {
    const auto start = Clock::now();
    if (weakOverrides) weakOverrides->clear();
    auto all=TransformSupport(width,height,quads,false);
    if(!all.success) return all;
    auto strong=TransformSupport(width,height,quads,true);
    if(!strong.success) return strong;
    const auto fail = [&](const std::string& error) {
        all.success = false;
        all.error = error;
        all.rectangles.clear();
        all.stats = {};
        all.stats.rasterMs = Milliseconds(start);
        return std::move(all);
    };
    try {
        WeakAlphaOverrides overrides(quads.size());
        std::vector<AlphaSampler> samplers;
        for(const auto& q:quads) {
            if(q.mask->sourceAlpha.size()!=static_cast<std::size_t>(q.mask->width)*q.mask->height) {
                return fail("prepared alpha source coverage unavailable");
            }
            AlphaSampler item{&q,{}};std::string error;
            if(!ResolvePreparedAlphaTransform(q,item.transform,error)) return fail(error);
            const auto& t=item.transform;item.determinant=t.xx*t.yy-t.xy*t.yx;
            if (!std::isfinite(item.determinant) || item.determinant == 0)
                return fail("prepared alpha inverse transform is degenerate");
            samplers.push_back(item);
        }
        std::vector<std::vector<Run>> weakRows(static_cast<std::size_t>(height)),strongRows(static_cast<std::size_t>(height));
        for(const auto& r:all.rectangles) for(int y=r.top;y<r.bottom;++y) weakRows[y].emplace_back(r.left,r.right);
        for(const auto& r:strong.rectangles) for(int y=r.top;y<r.bottom;++y) strongRows[y].emplace_back(r.left,r.right);
        std::vector<AlphaRegionRect> filtered;std::vector<Run> previous;
        int bandTop=0;std::uint64_t covered=0,samples=0,sampledTexels=0;
        bool invalidWeak = false;
        for(int y=0;y<height;++y) {
            std::vector<Run> row;
            const auto sample=[&](int left,int right) {
                if (invalidWeak) return;
                int begin=-1;
                for(int x=left;x<right;++x) {
                    if ((samples+1)*samplers.size()>kMaxWeakAlphaEntries) { invalidWeak=true; return; }
                    ++samples;
                    bool visible = false;
                    for (std::size_t i=0;i<samplers.size();++i) {
                        const auto byte=WeakCoverageByte(x,y,samplers[i],sampledTexels);
                        if (byte>1) { invalidWeak=true; return; }
                        overrides[i].push_back({static_cast<std::uint32_t>(y*width+x),byte});
                        visible = visible || byte!=0;
                    }
                    if(visible) {if(begin<0)begin=x;}
                    else if(begin>=0) {AppendRun(row,{begin,x});begin=-1;}
                }
                if(begin>=0) AppendRun(row,{begin,right});
            };
            for(const auto& run:weakRows[y]) {
                int left=run.first;
                for(const auto& solid:strongRows[y]) {
                    if(solid.second<=left)continue;
                    if(solid.first>=run.second)break;
                    if(left<solid.first)sample(left,std::min(solid.first,run.second));
                    const int begin=std::max(left,solid.first),end=std::min(run.second,solid.second);
                    if(begin<end)AppendRun(row,{begin,end});
                    left=std::max(left,end);
                }
                if(left<run.second)sample(left,run.second);
            }
            if(invalidWeak) return fail("prepared weak-coverage contract/work limit");
            for(const auto& run:row)covered+=static_cast<std::uint64_t>(run.second-run.first);
            if(row!=previous) {
                if(!AppendBand(previous,bandTop,y,filtered)) return fail("prepared filtered rectangle limit");
                previous=std::move(row);bandTop=y;
            }
        }
        if(!AppendBand(previous,bandTop,height,filtered)) return fail("prepared filtered rectangle limit");
        all.rectangles=std::move(filtered);all.stats.coveredPixels=covered;all.stats.rectangleCount=all.rectangles.size();
        all.stats.testedPixels=samples;
        all.stats.sampledTexels=sampledTexels;
        if(weakOverrides) *weakOverrides=std::move(overrides);
    } catch(const std::bad_alloc&) { return fail("prepared weak-coverage allocation failed"); }
    all.stats.rasterMs=Milliseconds(start);
    return all;
}

#ifdef _WIN32
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
    weakOverrides = std::move(other.weakOverrides);
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
            result.weakOverrides.clear();
        }
        return std::move(result);
    };
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384 || quads.size() > kMaxQuads)
        return finish("prepared alpha surface/quad limit");
    try {
        result.raster = TransformPreparedAlphaRegion(width,height,quads,&result.weakOverrides);
        if (!result.raster.success) return finish(result.raster.error);
        auto native = MakeAlphaRegionData(result.raster);
        if (!native.success) return finish(native.error);
        result.region = ExtCreateRegion(nullptr,native.byteCount,
            reinterpret_cast<const RGNDATA*>(native.words.data()));
        if (!result.region) return finish("create destination alpha region failed");
        result.stats.coveredPixels = result.raster.stats.coveredPixels;
        result.stats.rectangleCount = result.raster.rectangles.size();
        result.stats.transformedMasks = quads.size();
    } catch (const std::bad_alloc&) {
        return finish("prepared alpha frame allocation failed");
    }
    return finish();
}
#endif

}  // namespace niuma::runtime
