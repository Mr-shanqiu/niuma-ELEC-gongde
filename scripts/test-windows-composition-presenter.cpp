#include <objbase.h>
#include "../src/windows/runtime/composition_presenter.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>

namespace niuma::runtime {
struct CompositionPresenterTestAccess {
  static std::uint32_t Spare(const CompositionPresenter& p,std::uint64_t key) {
    for(const auto& texture:p.spares_)if(texture.key==key)return texture.id;
    return 0;
  }
  static D3D11Renderer& Renderer(CompositionPresenter& p){return p.renderer_.ModernRendererForTest();}
};
}

namespace {
void Check(bool okay, const char* name) {
  if (!okay) { std::fprintf(stderr, "FAIL %s\n", name); std::exit(1); }
}
niuma::runtime::PixelImage Image(unsigned char color) {
  niuma::runtime::PixelImage image;
  image.width = image.height = 16; image.strideBytes = 64;
  image.bgraPremultiplied.resize(1024);
  for (unsigned y = 2; y < 14; ++y) for (unsigned x = 2; x < 14; ++x) {
    auto p = (y * 16 + x) * 4;
    image.bgraPremultiplied[p] = color;
    image.bgraPremultiplied[p + 3] = 255;
  }
  return image;
}
niuma::runtime::PreparedAlphaMask Mask(const niuma::runtime::PixelImage& image) {
  return niuma::runtime::PrepareAlphaMask({image.bgraPremultiplied.data(),
    image.bgraPremultiplied.size(),image.width,image.height,image.strideBytes});
}
}
namespace {
using namespace niuma::runtime;
void CheckNative(HWND window, int width, int height, const std::vector<CompositionQuad>& quads) {
  std::vector<PreparedAlphaQuad> masks;
  for (const auto& q : quads) masks.push_back(FromRendererPreparedQuad(q.geometry, *q.mask));
  // Independent fresh native creation on every reference frame, never reused.
  auto reference = BuildPreparedAlphaRegion(width, height, masks);
  Check(reference.success && reference.region, "fresh reference region");
  HRGN actual = CreateRectRgn(0,0,0,0);
  Check(actual && GetWindowRgn(window, actual) != ERROR, "read installed native region");
  Check(EqualRgn(actual, reference.region), "installed coverage exactly equals fresh native region");
  DeleteObject(actual);
}
PixelImage Pattern(unsigned width,unsigned height,unsigned color) {
  PixelImage result;
  result.width=width;result.height=height;result.strideBytes=width*4;
  result.bgraPremultiplied.resize(static_cast<std::size_t>(width)*height*4);
  for(unsigned y=1;y+1<height;++y)for(unsigned x=1;x+1<width;++x) {
    const unsigned alpha=(x+y+color)%11==0?1:255;
    const auto i=static_cast<std::size_t>(y*width+x)*4;
    result.bgraPremultiplied[i]=static_cast<unsigned char>(std::min(alpha,color%220));
    result.bgraPremultiplied[i+3]=static_cast<unsigned char>(alpha);
  }
  return result;
}
void TextureReuse(HWND first,HWND second) {
  CompositionPresenter cached,reference;
  Check(cached.Initialize(first,120,125,true) && reference.Initialize(second,120,125,true),"texture presenters initialize");
  auto art=Image(25),a=Image(40),b=Image(60);
  auto artMask=Mask(art),aMask=Mask(a),bMask=Mask(b);
  CompositionQuad qa;qa.textureKey=1;qa.mask=&artMask;
  qa.geometry.positions={{{10,20},{110,20},{110,120},{10,120}}};
  auto qb=qa;qb.textureKey=2;qb.mask=&aMask;qb.geometry.positions={{{10,0},{100,0},{100,35},{10,35}}};
  auto qc=qb;qc.textureKey=3;qc.mask=&bMask;qc.geometry.positions={{{25,20},{115,20},{115,60},{25,60}}};
  std::vector<CompositionQuad> quads{qa,qb,qc};
  std::vector<CompositionTexture> textures{{1,1,&art},{2,1,&a,true},{3,1,&b,true}};
  const auto compare=[&] {
    auto fresh=textures;for(auto& texture:fresh)texture.reusable=false;
    Check(cached.SetTextures(textures) && reference.SetTextures(fresh),"prepare mutable vs fresh immutable textures");
    PixelImage actual,expected;
    Check(cached.DrawLatest(quads,&actual) && reference.DrawLatest(quads,&expected),"capture mutable vs immutable frames");
    Check(actual.bgraPremultiplied==expected.bgraPremultiplied,"updated GPU pixels equal fresh immutable upload");
    HRGN x=CreateRectRgn(0,0,0,0),y=CreateRectRgn(0,0,0,0);
    Check(x && y && GetWindowRgn(first,x)!=ERROR && GetWindowRgn(second,y)!=ERROR && EqualRgn(x,y),"updated native coverage matches fresh upload");
    DeleteObject(x);DeleteObject(y);
    Check(cached.Stats().spareTextureCount<=CompositionPresenter::kSpareTextureCountLimit &&
        cached.Stats().spareTextureBytes<=CompositionPresenter::kSpareTextureByteLimit &&
        cached.BackendStats().textureBytes==cached.Stats().residentTextureBytes+cached.Stats().spareTextureBytes &&
        cached.Stats().peakTextureBytes<=CompositionPresenter::kReplacementTextureLimit,"spare owners and bytes bounded");
  };
  for(unsigned frame=0;frame<96;++frame) {
    const unsigned size=16+(frame/32);
    a=Pattern(size,size,30+frame);b=Pattern(size,size,80+frame);aMask=Mask(a);bMask=Mask(b);
    textures[1].version=textures[2].version=frame+1;compare();
    Check(cached.BackendStats().textureCount<=5,"only active art plus two text pairs retained");
  }
  Check(cached.BackendStats().textureCreations==13 && cached.BackendStats().textureUpdates==180,
      "unchanged dimensions reuse resources; size changes replace both slots");
  textures[1].reusable=false;++textures[1].version;compare();
  Check(!CompositionPresenterTestAccess::Spare(cached,2),"immutable mode removes spare owner");
  textures[1].reusable=true;
  for(unsigned n=0;n<2;++n){++textures[1].version;++textures[2].version;compare();}
  PixelImage before,after;
  Check(cached.DrawLatest(quads,&before),"capture old active values before failed replacement");
  const auto spare=CompositionPresenterTestAccess::Spare(cached,3);
  Check(spare && CompositionPresenterTestAccess::Renderer(cached).RemoveTexture(spare),"inject missing inactive resource, leaving active textures intact");
  a=Pattern(18,18,190);b=Pattern(18,18,210);
  ++textures[1].version;++textures[2].version;
  const auto updates=cached.BackendStats().textureUpdates;
  Check(!cached.SetTextures(textures) && FAILED(cached.LastError()) && !cached.LastErrorMessage().empty(),
      "later update failure remains visible after cleanup");
  Check(cached.BackendStats().textureUpdates==updates+1,"earlier inactive update really succeeded before injected failure");
  Check(cached.DrawLatest(quads,&after) && before.bgraPremultiplied==after.bgraPremultiplied,
      "failed multi-texture replacement leaves every active GPU pixel unchanged");
  aMask=Mask(a);bMask=Mask(b);compare();
  auto invalid=textures;PixelImage shortImage=a;shortImage.bgraPremultiplied.clear();invalid[2].pixels=&shortImage;
  Check(!cached.SetTextures(invalid),"invalid pixels rejected before any upload");
  Check(cached.DrawLatest(quads,&before),"valid old set survives invalid replacement");
  // More reusable keys remain valid: only three idle slots may be retained.
  std::vector<CompositionTexture> four;
  for(unsigned key=10;key<14;++key)four.push_back({key,1,&a,true});
  for(unsigned frame=0;frame<5;++frame) {
    for(auto& texture:four)++texture.version;
    Check(cached.SetTextures(four) && cached.Stats().spareTextureCount<=3 && cached.BackendStats().textureCount<=7,
        "four mutable keys do not grow the three-slot cache");
  }
  auto large=Pattern(1024,513,80); // Valid, but too large for the spare budget.
  Check(cached.SetTextures({{20,1,&large,true}}) && cached.SetTextures({{20,2,&large,true}}) &&
      cached.Stats().spareTextureCount==0 && cached.BackendStats().textureCount==1,
      "oversized reusable texture falls back to replacement instead of rejecting valid content");
  Check(cached.SetTextures({textures[0]}) && cached.BackendStats().textureCount==1 &&
      cached.Stats().spareTextureBytes==0,"removal releases all unused text buffers");
  cached.Shutdown();
  Check(cached.BackendStats().textureCount==0 && cached.Stats().spareTextureCount==0,"shutdown releases active and idle buffers");
  Check(cached.Initialize(first,120,125,true) && cached.SetTextures(textures) && cached.DrawLatest(quads),
      "device recreation uses current content and no stale buffer ids");
  std::puts("PASS texture reuse: 100 fresh-immutable GPU/native comparisons; bounded creation, resize, mode changes, inactive-write failure atomicity, removal and recreation");
}
void RegionReuse(HWND first, HWND second) {
  CompositionPresenter cached, reference;
  Check(cached.Initialize(first,120,125,true) && reference.Initialize(second,120,125,true), "reuse presenters initialize");
  auto image = Image(20);
  // Include weak-only pixels, transparent holes and an opaque centre.
  for(unsigned y=0;y<16;++y) {
    auto p=(y*16)*4; image.bgraPremultiplied[p]=1; image.bgraPremultiplied[p+3]=1;
  }
  auto mask = Mask(image);
  Check(mask.success, "mixed alpha mask");
  CompositionQuad q; q.textureKey=1; q.mask=&mask;
  q.geometry.positions={{{10,20},{110,20},{110,120},{10,120}}};
  std::vector<CompositionQuad> quads{q};
  std::vector<CompositionTexture> textures{{1,1,&image}};
  Check(cached.SetTextures(textures) && reference.SetTextures(textures), "reuse textures");
  int width=120,height=125;
  for(unsigned n=0;n<80;++n) {
    if(n==20) {
      width=180;height=188;
      Check(cached.Resize(width,height) && reference.Resize(width,height), "surface resize");
    }
    // Color updates preserve coverage; changed pose/opacity/clip must be evaluated anew.
    image.bgraPremultiplied[(8*16+8)*4]=static_cast<unsigned char>(20+n);
    textures[0].version=n+2;
    Check(cached.SetTextures(textures) && reference.SetTextures(textures), "changed color/version");
    if(n<10) quads[0].geometry=q.geometry;
    else if(n<40) {
      const float angle=static_cast<float>((n-10)*.03);
      for(unsigned j=0;j<4;++j) {
        const auto a=q.geometry.positions[j];const float x=a.x-60,y=a.y-70;
        quads[0].geometry.positions[j]={60+x*std::cos(angle)-y*std::sin(angle),70+x*std::sin(angle)+y*std::cos(angle)};
      }
      quads[0].geometry.opacity=n%3==0?.5f:1.f;
      quads[0].geometry.scissor=ScissorRect{15,10,95,105};
    } else {
      quads[0].geometry=q.geometry;
      quads[0].geometry.opacity=0; // Empty regions must also be reusable.
    }
    if(n==50) cached.Invalidate();
    if(n==60) {
      Check(cached.Initialize(first,width,height,true) && cached.SetTextures(textures), "device recreation clears installed cache");
    }
    reference.Invalidate();
    PixelImage actual, expected;
    Check(cached.DrawLatest(quads,&actual) && reference.DrawLatest(quads,&expected), "cached and forced fresh frames");
    Check(actual.width==expected.width && actual.height==expected.height &&
        actual.bgraPremultiplied==expected.bgraPremultiplied, "GPU pixels identical with freshly resolved weak alpha");
    CheckNative(first,width,height,quads);
    const auto& stats=cached.Stats();
    Check(stats.retainedRegionBytes<=CompositionPresenter::kInstalledRegionByteLimit, "one installed coverage bounded");
    if(n<10 || n>=41) {
      const bool forced=n==0 || n==50 || n==60;
      Check(stats.lastRegionDetails.nativeRegionReused!=forced, "identical coverage reuses except explicit invalidation");
      if(!forced) Check(stats.lastRegionInstallWallMs==0 && stats.lastRegionDetails.nativeCreateMs==0,
          "reused coverage does not call native create/install");
    }
  }
  Check(cached.Stats().nativeRegionReuses>20, "meaningful reuse exercised");
  auto invalid=quads;invalid[0].geometry.positions[0].x=std::nanf("");
  Check(!cached.DrawLatest(invalid), "invalid current geometry cannot reuse old coverage");
  cached.Shutdown();reference.Shutdown();
  Check(cached.Stats().retainedRegionBytes==0, "shutdown releases retained coverage");
  std::puts("PASS region reuse: 80 fresh-native and pixel comparisons; weak alpha, color changes, rotation, fading, clipping, resize, empty coverage, invalidation, recreation and invalid input");
}
}
int main(int argc, char** argv) {
  using namespace niuma::runtime;
  Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "COM");
  WNDCLASSW cls{};
  cls.hInstance = GetModuleHandleW(nullptr); cls.lpfnWndProc = DefWindowProcW;
  cls.lpszClassName = L"NiuMaCompositionPresenterTest";
  Check(RegisterClassW(&cls) != 0, "owned class");
  HWND window = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      cls.lpszClassName, L"NiuMa composition test", WS_POPUP, 30, 30, 120, 125,
      nullptr, nullptr, cls.hInstance, nullptr);
  Check(window != nullptr, "owned window");
  if(argc==2 && (std::strcmp(argv[1], "--region-reuse-only")==0 || std::strcmp(argv[1], "--texture-reuse-only")==0)) {
    HWND second=CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        cls.lpszClassName,L"NiuMa fresh region reference",WS_POPUP,200,30,120,125,
        nullptr,nullptr,cls.hInstance,nullptr);
    Check(second!=nullptr,"reference window");
    if(std::strcmp(argv[1],"--texture-reuse-only")==0)TextureReuse(window,second);else RegionReuse(window,second);
    DestroyWindow(second);DestroyWindow(window);
    UnregisterClassW(cls.lpszClassName,cls.hInstance);CoUninitialize();return 0;
  }
  {
    CompositionPresenter presenter;
    Check(presenter.Initialize(window,120,125,true), "real composition initialization (software permitted for CI)");
    auto art = Image(20), text = Image(40);
    auto artMask = Mask(art), textMask = Mask(text);
    Check(artMask.success && textMask.success, "prepared masks");
    std::vector<CompositionTexture> textures{{1,1,&art},{2,1,&text}};
    Check(presenter.SetTextures(textures), "initial two textures");
    CompositionQuad artQuad;
    artQuad.textureKey = 1; artQuad.mask = &artMask;
    artQuad.geometry.positions = {{{10,20},{110,20},{110,120},{10,120}}};
    CompositionQuad textQuad;
    textQuad.textureKey = 2; textQuad.mask = &textMask;
    textQuad.geometry.positions = {{{30,0},{90,0},{90,20},{30,20}}};
    std::vector<CompositionQuad> quads{artQuad,textQuad};
    Check(presenter.DrawLatest(quads), "first frame includes art and text");
    for(unsigned n=0;n<100;++n)
      Check(presenter.SetTextures(textures) && presenter.DrawLatest(quads), "unchanged latest frame");
    Check(presenter.Stats().textureUploads==2 && presenter.Stats().framesPresented==1 &&
        presenter.Stats().unchangedFrames==100, "idle does not upload or present repeatedly");
    text = Image(80); textures[1].version = 2;
    Check(presenter.SetTextures(textures) && presenter.DrawLatest(quads), "text-only value changed");
    Check(presenter.Stats().textureUploads==3 && presenter.Stats().framesPresented==2 &&
        presenter.BackendStats().textureCount==2, "text replacement keeps art and releases prior text");
    auto invalid=quads; invalid[0].textureKey=999;
    Check(!presenter.DrawLatest(invalid) && presenter.Stats().framesPresented==2,
        "unbound resource never reports success");
    auto duplicates=textures; duplicates.push_back(textures.front());
    Check(!presenter.SetTextures(duplicates) && presenter.BackendStats().textureCount==2,
        "invalid replacement preserves installed resources");
    PixelImage tooLarge; tooLarge.width=tooLarge.height=10000; tooLarge.strideBytes=40000;
    Check(!presenter.SetTextures({{3,1,&tooLarge}}) && presenter.BackendStats().textureCount==2,
        "budget rejects before allocating and keeps old textures");
    Check(presenter.Resize(180,188) && presenter.DrawLatest(quads), "resize invalidates one frame");
    Check(presenter.Stats().framesPresented==3, "resize presents exactly once");
    presenter.Invalidate();
    Check(presenter.DrawLatest(quads) && presenter.Stats().framesPresented==4, "explicit redraw once");
    Check(presenter.SetTextures({textures[0]}) && presenter.DrawLatest({artQuad}) &&
        presenter.BackendStats().textureCount==1, "removed overlay releases its texture");
    Check(presenter.BackendStats().diagnosticReadbacks==0, "normal path performs no GPU readback");
    presenter.Shutdown();
    Check(presenter.Stats().residentTextureBytes==0 && !presenter.DrawLatest(quads),
        "shutdown has no GPU resources and cannot pretend to render");
    Check(presenter.Initialize(window,120,125,true) && presenter.SetTextures(textures) &&
        presenter.DrawLatest(quads) && presenter.BackendStats().textureCount==2,
        "explicit device recreation uses only latest resources");
    std::printf("PASS composition presenter: idle, text update, bounded resources, resize and explicit recreation; adapter=%s; normalReadbacks=0\n", presenter.Adapter().kind.c_str());
  }
  DestroyWindow(window);
  UnregisterClassW(cls.lpszClassName,cls.hInstance);
  CoUninitialize();
}
