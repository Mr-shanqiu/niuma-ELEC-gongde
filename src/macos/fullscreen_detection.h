#pragma once
#include <algorithm>
#include <cmath>
#include <vector>

namespace niuma::macos {
struct FullscreenRect { double x, y, width, height; int owner; };

// Window-server rectangles are in global display coordinates. Consider only
// layer-zero windows on the pet's screen, not only the globally active app:
// another monitor may have focus while this screen remains in fullscreen.
inline bool FullscreenOnDisplay(const FullscreenRect& display, const FullscreenRect& visibleArea,
                                const std::vector<FullscreenRect>& windows, int ownPid) {
  if (!(display.width>0 && display.height>0 && visibleArea.width>0 && visibleArea.height>0)) return false;
  auto valid=[&](const FullscreenRect&w){return w.owner>0 && w.owner!=ownPid &&
    std::isfinite(w.x)&&std::isfinite(w.y)&&std::isfinite(w.width)&&std::isfinite(w.height)&&w.width>0&&w.height>0;};
  // CGWindowList is front-to-back. Pick the foremost substantial window on
  // this screen, independently of focus on other displays; tiny menus and
  // floating controls do not hide a fullscreen application underneath.
  int topOwner=0;
  for(const auto& w:windows){
    if(!valid(w))continue;
    const double iw=std::max(0.0,std::min(display.x+display.width,w.x+w.width)-std::max(display.x,w.x));
    const double ih=std::max(0.0,std::min(display.y+display.height,w.y+w.height)-std::max(display.y,w.y));
    if(iw*ih/(display.width*display.height)>=0.20){topOwner=w.owner;break;}
  }
  if(!topOwner)return false;
  auto covers=[&](const FullscreenRect& area) {
    // Match both true fullscreen and a window filling the usable area. A small
    // proportional margin accounts for borders/toolbars and scaling rounding.
    const double tx=std::max(4.0,area.width*0.03),ty=std::max(4.0,area.height*0.03);
    const double left=area.x,top=area.y,right=left+area.width,bottom=top+area.height;
    auto wide=[&](const FullscreenRect&w){return w.x<=left+tx&&w.x+w.width>=right-tx;};
    auto high=[&](const FullscreenRect&w){return w.y<=top+ty&&w.y+w.height>=bottom-ty;};
    auto fraction=[&](const FullscreenRect&w){
      const double iw=std::max(0.0,std::min(right,w.x+w.width)-std::max(left,w.x));
      const double ih=std::max(0.0,std::min(bottom,w.y+w.height)-std::max(top,w.y));
      return iw*ih/(area.width*area.height);
    };
    for(std::size_t i=0;i<windows.size();++i){
      const auto&a=windows[i];if(!valid(a)||a.owner!=topOwner)continue;
      if(wide(a)&&high(a))return true;
      const double fa=fraction(a);if(fa<0.08)continue;
      for(std::size_t j=i+1;j<windows.size();++j){
        const auto&b=windows[j];if(!valid(b)||b.owner!=a.owner)continue;
        const double fb=fraction(b);if(fb<0.08||std::max(fa,fb)<0.65)continue;
        if(wide(a)&&wide(b)&&std::min(a.y,b.y)<=top+ty&&
           std::max(a.y+a.height,b.y+b.height)>=bottom-ty&&
           std::max(a.y,b.y)<=std::min(a.y+a.height,b.y+b.height)+4.0)return true;
        if(high(a)&&high(b)&&std::min(a.x,b.x)<=left+tx&&
           std::max(a.x+a.width,b.x+b.width)>=right-tx&&
           std::max(a.x,b.x)<=std::min(a.x+a.width,b.x+b.width)+4.0)return true;
      }
    }
    return false;
  };
  return covers(display) || covers(visibleArea);
}
}
