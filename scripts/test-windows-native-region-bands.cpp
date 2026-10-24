#include "../src/windows/runtime/native_region_bands.h"
#include <cstdio>
#include <stdexcept>

namespace {
using namespace niuma::runtime;
void Check(bool value,const char* message) {if(!value) throw std::runtime_error(message);}
struct Region {
    HRGN value=nullptr;
    ~Region(){if(value)DeleteObject(value);}
};
HRGN Fresh(const AlphaRegionResult& raster) {
    auto bytes=MakeAlphaRegionData(raster);
    Check(bytes.success,"fresh serialization");
    auto region=ExtCreateRegion(nullptr,bytes.byteCount,reinterpret_cast<const RGNDATA*>(bytes.words.data()));
    Check(region!=nullptr,"fresh native region");return region;
}
void ExactFramesAndOwnership() {
    NativeRegionBands cache;
    for(int frame=0;frame<120;++frame) {
        AlphaRegionResult raster;raster.success=true;raster.width=240;raster.height=330;
        raster.rectangles={{30,0,50,10},{80,0,95,10},{0,60,100,70},
            {10+frame%8,130,150+frame%8,151},{10,286,40,328},{50,286,80,328}};
        // Static holes and rectangles straddling band edges surround movement.
        if(frame%11==0) raster.rectangles[1].right=96;
        NativeRegionBandStats stats;
        Region actual,expected{Fresh(raster)};
        Check(cache.TryBuild(raster,actual.value,stats),"band assembly");
        Check(EqualRgn(actual.value,expected.value)!=FALSE,"exact native union differs");
        Check(cache.RetainedBytes()<=NativeRegionBands::kByteLimit &&
            cache.RetainedHandles()<=NativeRegionBands::kMaximumBands,"native owner budget");
        if(frame>0 && frame!=31 && frame!=91) Check(stats.reused>=3,"static portions were rebuilt");
        if(frame==30 || frame==90) {
            cache.Clear();
            Check(cache.RetainedBytes()==0 && cache.RetainedHandles()==0,"clear retained native owners");
            Check(EqualRgn(actual.value,expected.value)!=FALSE,"cache released caller-owned result");
        }
    }
    AlphaRegionResult resized;resized.success=true;resized.width=120;resized.height=125;
    resized.rectangles={{0,63,120,65},{10,65,110,124}};
    NativeRegionBandStats stats;Region actual,expected{Fresh(resized)};
    Check(cache.TryBuild(resized,actual.value,stats) && EqualRgn(actual.value,expected.value),"resize exact coverage");
    Check(stats.reused==0,"resize kept old dimensions");
    AlphaRegionResult empty;empty.success=true;empty.width=120;empty.height=125;
    Region blank,freshEmpty{Fresh(empty)};
    Check(cache.TryBuild(empty,blank.value,stats) && EqualRgn(blank.value,freshEmpty.value),"empty native coverage");
    Check(cache.RetainedHandles()==0,"empty coverage kept prior native shape");
}
void FallbackDoesNotRejectPreviouslyValidContours() {
    NativeRegionBands cache;NativeRegionBandStats stats;Region actual;
    AlphaRegionResult tall;tall.success=true;tall.width=10;tall.height=4097;tall.rectangles={{0,0,10,4097}};
    Check(!cache.TryBuild(tall,actual.value,stats) && actual.value==nullptr,"large height fallback");
    Check(MakeAlphaRegionData(tall).success,"large height remains valid in original path");
    AlphaRegionResult fragmented;fragmented.success=true;fragmented.width=16384;fragmented.height=64;
    for(int i=0;i<131073;++i) {
        const int y=i/8192,x=(i%8192)*2;
        fragmented.rectangles.push_back({x,y,x+1,y+1});
    }
    Check(MakeAlphaRegionData(fragmented).success,"fragmented contour remains valid in original path");
    Check(!cache.TryBuild(fragmented,actual.value,stats) && actual.value==nullptr,"CPU capacity fallback");
    Check(cache.RetainedBytes()==0 && cache.RetainedHandles()==0,"fallback retained partial owners");
    fragmented.rectangles={{-1,0,1,1}};
    Check(!cache.TryBuild(fragmented,actual.value,stats),"invalid rectangle accepted");
    fragmented.success=false;
    Check(!cache.TryBuild(fragmented,actual.value,stats),"failed raster accepted");
}
}
int main() {
    try {
        ExactFramesAndOwnership();FallbackDoesNotRejectPreviouslyValidContours();
        std::puts("PASS native bands: 120 fresh native comparisons, static holes, band edges, movement, resize, empty coverage, ownership, invalid input and original-path fallback");
        return 0;
    }catch(const std::exception& e){std::fprintf(stderr,"FAIL native bands: %s\n",e.what());return 1;}
}
