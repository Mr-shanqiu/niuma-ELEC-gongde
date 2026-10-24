#include "native_region_bands.h"
#ifdef _WIN32
#include <algorithm>
#include <chrono>
#include <new>
#include <utility>

namespace niuma::runtime {
namespace {
using Clock = std::chrono::steady_clock;
double Ms(Clock::time_point t) { return std::chrono::duration<double,std::milli>(Clock::now()-t).count(); }
struct OwnedRegion {
    HRGN value = nullptr;
    ~OwnedRegion() { if(value) DeleteObject(value); }
    HRGN Release() { return std::exchange(value,nullptr); }
};
bool Same(const AlphaRegionRect& a,const AlphaRegionRect& b) {
    return a.left==b.left && a.top==b.top && a.right==b.right && a.bottom==b.bottom;
}
}
void NativeRegionBands::Clear() noexcept {
    for(auto& band:bands_) {
        if(band.handle) DeleteObject(band.handle);
        band.handle=nullptr; band.valid=false;
        std::vector<AlphaRegionRect>().swap(band.rectangles);
    }
    bytes_=0; width_=height_=0;
}
std::size_t NativeRegionBands::RetainedHandles() const noexcept {
    return static_cast<std::size_t>(std::count_if(bands_.begin(),bands_.end(),
        [](const auto& b){return b.handle!=nullptr;}));
}
bool NativeRegionBands::TryBuild(const AlphaRegionResult& raster,HRGN& output,NativeRegionBandStats& stats) {
    output=nullptr; stats={};
    const auto fail=[&]{Clear();return false;};
    if(!raster.success || raster.rectangles.size()>262144 || raster.width<=0 || raster.width>16384 || raster.height<=0 ||
        raster.height>kBandHeight*static_cast<int>(kMaximumBands)) return fail();
    if(width_!=raster.width || height_!=raster.height) Clear();
    const auto count=static_cast<std::size_t>((raster.height+kBandHeight-1)/kBandHeight);
    try {
        const auto lookupStart=Clock::now();
        std::array<std::vector<AlphaRegionRect>,kMaximumBands> next;
        std::size_t temporaryBytes=0;
        for(const auto& r:raster.rectangles) {
            if(r.left<0 || r.top<0 || r.right>raster.width || r.bottom>raster.height ||
                r.left>=r.right || r.top>=r.bottom) return fail();
            const auto first=static_cast<std::size_t>(r.top/kBandHeight);
            const auto last=static_cast<std::size_t>((r.bottom-1)/kBandHeight);
            for(std::size_t i=first;i<=last;++i) {
                auto& rows=next[i];
                if(rows.size()==rows.capacity()) {
                    const auto capacity=std::max<std::size_t>(1,rows.capacity()*2);
                    const auto extra=(capacity-rows.capacity())*sizeof(AlphaRegionRect);
                    if(extra>kByteLimit-temporaryBytes) return fail();
                    const auto before=rows.capacity();rows.reserve(capacity);
                    temporaryBytes+=(rows.capacity()-before)*sizeof(AlphaRegionRect);
                    if(temporaryBytes>kByteLimit) return fail();
                }
                rows.push_back({r.left,std::max(r.top,static_cast<int>(i)*kBandHeight),
                    r.right,std::min(r.bottom,static_cast<int>(i+1)*kBandHeight)});
            }
        }
        std::array<bool,kMaximumBands> same{};
        std::size_t retainedNext=0;
        for(std::size_t i=0;i<count;++i) {
            const auto& old=bands_[i];
            same[i]=old.valid && old.rectangles.size()==next[i].size() &&
                std::equal(old.rectangles.begin(),old.rectangles.end(),next[i].begin(),Same);
            retainedNext+=(same[i]?old.rectangles.capacity():next[i].capacity())*sizeof(AlphaRegionRect);
            if(retainedNext>kByteLimit) return fail();
        }
        // Release all replaced owners before installing replacements. Partial
        // preparation is only a cache state; on failure Clear and fall back.
        for(std::size_t i=0;i<count;++i) if(!same[i]) {
            auto& old=bands_[i];
            if(old.handle) DeleteObject(old.handle);
            old.handle=nullptr; old.valid=false;
            std::vector<AlphaRegionRect>().swap(old.rectangles);
        }
        stats.lookupMs=Ms(lookupStart);
        const auto emptyStart=Clock::now();
        OwnedRegion aggregate{CreateRectRgn(0,0,0,0)};
        stats.createMs+=Ms(emptyStart);
        if(!aggregate.value) return fail();
        for(std::size_t i=0;i<count;++i) {
            auto& band=bands_[i];
            if(same[i]) {
                if(band.handle) ++stats.reused; // Empty bands are not useful reuse.
            } else {
                OwnedRegion native;
                if(!next[i].empty()) {
                    AlphaRegionResult part;
                    part.success=true; part.width=raster.width; part.height=raster.height;
                    part.rectangles=std::move(next[i]);
                    auto data=MakeAlphaRegionData(part);
                    stats.serializeMs+=data.serializeMs;
                    if(!data.success) return fail();
                    const auto createStart=Clock::now();
                    native.value=ExtCreateRegion(nullptr,data.byteCount,reinterpret_cast<const RGNDATA*>(data.words.data()));
                    stats.createMs+=Ms(createStart);
                    if(!native.value) return fail();
                    band.rectangles=std::move(part.rectangles); ++stats.created;
                }
                band.handle=native.Release(); band.valid=true;
            }
            if(band.handle) {
                const auto combineStart=Clock::now();
                const int result=CombineRgn(aggregate.value,aggregate.value,band.handle,RGN_OR);
                stats.combineMs+=Ms(combineStart);
                if(result==ERROR) return fail();
                ++stats.combined;
            }
        }
        width_=raster.width; height_=raster.height; bytes_=retainedNext;
        output=aggregate.Release();return true;
    }catch(const std::bad_alloc&) {return fail();}
}
} // namespace niuma::runtime
#endif
