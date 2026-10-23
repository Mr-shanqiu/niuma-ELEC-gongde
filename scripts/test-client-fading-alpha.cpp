#include "../src/windows/runtime/prepared_alpha_region.h"
#include <cmath>
#include <iostream>
#include <stdexcept>
using namespace niuma::runtime;
namespace {
void Check(bool okay,const char* name) { if(!okay) throw std::runtime_error(name); }
bool Covers(const AlphaRegionResult& result,int x,int y) {
  for(const auto& r:result.rectangles)
    if(r.left<=x && x<r.right && r.top<=y && y<r.bottom) return true;
  return false;
}
}
int main() {
  try {
    unsigned cases=0;
    for(unsigned alpha:{1u,2u,4u,8u,16u,32u,64u,128u,255u}) {
      std::vector<std::uint8_t> pixels(4*4*4);
      for(unsigned i=0;i<16;++i) pixels[i*4+3]=static_cast<std::uint8_t>(alpha);
      AlphaRegionImageView view{pixels.data(),pixels.size(),4,4,16};
      const auto mask=PrepareAlphaMask(view,true,1024*1024);
      Check(mask.success && mask.opacityBandsPrepared,"load-time fading bands");
      const auto legacy=PrepareAlphaMask(view);
      Check(legacy.success && !legacy.opacityBandsPrepared,"opaque preparation remains independent");
      for(float opacity:{0.f,.001f,.003f,.007f,.03f,.1f,.2f,.3f,.49f,.7f,.99f,1.f}) {
        PreparedAlphaQuad q;
        q.mask=&mask; q.opacity=opacity;
        q.positions={{{0,0},{16,0},{16,16},{0,16}}};
        WeakAlphaOverrides decisions;
        const auto region=TransformPreparedAlphaRegion(16,16,{q},&decisions);
        Check(region.success,"fading transform succeeds");
        const bool visible=std::lround(alpha*static_cast<double>(opacity))!=0;
        Check(Covers(region,8,8)==visible,"effective alpha controls interior hit region");
        if(!visible) Check(region.rectangles.empty(),"fully faded layer cannot intercept desktop");
        for(const auto& list:decisions) for(const auto& pixel:list)
          Check(pixel.alphaByte<=1,"GPU shared sparse contract remains one byte");
        ++cases;
      }
      Check(!PrepareAlphaMask(view,true,1).success,"fading contours obey storage budget");
    }
    std::cout<<"PASS fading alpha: "<<cases<<" source-alpha/opacity cases; fully faded hit regions empty; shared 0/1 decisions; bounded storage\n";
    return 0;
  } catch(const std::exception& error) { std::cerr<<"FAIL "<<error.what()<<"\n"; return 1; }
}
