#include <objbase.h>
#include "../src/windows/runtime/composition_presenter.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>

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
  if(argc==2 && std::strcmp(argv[1], "--region-reuse-only")==0) {
    HWND second=CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        cls.lpszClassName,L"NiuMa fresh region reference",WS_POPUP,200,30,120,125,
        nullptr,nullptr,cls.hInstance,nullptr);
    Check(second!=nullptr,"reference window");
    RegionReuse(window,second);
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
