#include "../src/windows/runtime/composition_presenter.h"
#include "../src/windows/runtime/platform_compat.h"
#include <iostream>
#include <stdexcept>
#include <cmath>
#define CHECK(x) do { if (!(x)) throw std::runtime_error("line " + std::to_string(__LINE__) + ": " #x); } while(false)
using namespace niuma::runtime;
PixelImage Image(unsigned color) {
  PixelImage p; p.width=p.height=16; p.strideBytes=64;p.bgraPremultiplied.resize(1024);
  for(unsigned y=2;y<14;++y)for(unsigned x=2;x<14;++x) {
    const auto i=(y*16+x)*4;p.bgraPremultiplied[i]=static_cast<unsigned char>(color);p.bgraPremultiplied[i+3]=255;
  }
  return p;
}
PreparedAlphaMask Mask(const PixelImage& p) {
  return PrepareAlphaMask({p.bgraPremultiplied.data(),p.bgraPremultiplied.size(),p.width,p.height,p.strideBytes});
}
int main() {
  ULONG_PTR gdiplus=0;
  try {
    Gdiplus::GdiplusStartupInput startup;
    CHECK(Gdiplus::GdiplusStartup(&gdiplus,&startup,nullptr)==Gdiplus::Ok);
    WNDCLASSW wc{};wc.lpszClassName=L"NiuMaLayeredCompatibilityTest";
    wc.lpfnWndProc=DefWindowProcW;wc.hInstance=GetModuleHandleW(nullptr);CHECK(RegisterClassW(&wc));
    const auto make=[&] { return CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP|WS_EX_NOACTIVATE,
      wc.lpszClassName,L"Isolated compatibility test",WS_POPUP,20,20,80,80,nullptr,nullptr,wc.hInstance,nullptr); };
    HWND a=make(),b=make();CHECK(a && b);
    {
      CompositionPresenter cached,fresh;
      if (!cached.Initialize(a,80,80,false,true)) throw std::runtime_error(
        "cached initialize: " + cached.LastErrorMessage() + " hr=" + std::to_string(cached.LastError()) +
        " win32=" + std::to_string(GetLastError()));
      if (!fresh.Initialize(b,80,80,false,true)) throw std::runtime_error("fresh initialize: " + fresh.LastErrorMessage());
      CHECK(cached.layered() && cached.Adapter().kind=="cpu-layered" && !cached.Adapter().hardwareAccelerated);
      CHECK((GetWindowLongPtrW(a,GWL_EXSTYLE)&WS_EX_LAYERED)!=0);
      CHECK((GetWindowLongPtrW(a,GWL_EXSTYLE)&WS_EX_NOREDIRECTIONBITMAP)==0);
      auto image=Image(80);auto mask=Mask(image);
      CompositionQuad quad;quad.textureKey=1;quad.mask=&mask;
      quad.geometry.positions={{{8,8},{56,8},{56,56},{8,56}}};
      std::vector<CompositionTexture> textures{{1,1,&image,true}};
      CHECK(cached.SetTextures(textures));
      PixelImage capture;CHECK(cached.DrawLatest({quad},&capture));
      CHECK(capture.bgraPremultiplied[(32*80+32)*4]==80);
      CHECK(capture.bgraPremultiplied[(32*80+32)*4+3]==255);
      CHECK(capture.bgraPremultiplied[3]==0);
      const auto presents=cached.Stats().framesPresented;
      CHECK(cached.DrawLatest({quad})); CHECK(cached.Stats().framesPresented==presents);
      CHECK(cached.Stats().nativeRegionInstalls==0 && cached.BackendStats().diagnosticReadbacks==1);
      const auto handles=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
      for(unsigned frame=0;frame<120;++frame) {
        image=Image(40+frame); mask=Mask(image);++textures[0].version;
        CHECK(cached.SetTextures(textures));
        auto reference=textures;reference[0].reusable=false;
        CHECK(fresh.SetTextures(reference));
        // Translation, rotation, opacity, cropped UVs and scissor share the
        // same cache lifecycle; fresh immutable uploads are an independent owner.
        const float angle=static_cast<float>(frame)*.02f;
        const Point2 origin{25,20},x{28*std::cos(angle),28*std::sin(angle)},y{-28*std::sin(angle),28*std::cos(angle)};
        quad.geometry.positions={{{origin.x,origin.y},{origin.x+x.x,origin.y+x.y},
          {origin.x+x.x+y.x,origin.y+x.y+y.y},{origin.x+y.x,origin.y+y.y}}};
        quad.geometry.opacity=frame%2 ? .5f : 1.f;
        quad.geometry.uv={{{.125f,.125f},{.875f,.125f},{.875f,.875f},{.125f,.875f}}};
        quad.geometry.scissor=ScissorRect{5,5,60,60};
        PixelImage expected;
        CHECK(cached.DrawLatest({quad},&capture) && fresh.DrawLatest({quad},&expected));
        CHECK(capture.bgraPremultiplied==expected.bgraPremultiplied);
        CHECK(cached.BackendStats().textureCount<=2);
        CHECK(cached.Stats().residentTextureBytes+cached.Stats().spareTextureBytes<=2048);
      }
      CHECK(GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS)<=handles+1);
      const auto uploads=cached.Stats().textureUploads;
      auto invalid=image;invalid.bgraPremultiplied.clear();auto bad=textures;bad[0].pixels=&invalid;++bad[0].version;
      CHECK(!cached.SetTextures(bad));CHECK(cached.Stats().textureUploads==uploads);
      CHECK(cached.DrawLatest({quad},&capture));
      CHECK(!cached.Resize(4096,4096));CHECK(cached.DrawLatest({quad},&capture));
      cached.Shutdown();CHECK(cached.BackendStats().textureCount==0);
      CHECK(cached.Initialize(a,80,80,false,true));CHECK(cached.SetTextures(textures));
      CHECK(cached.DrawLatest({quad},&capture));
      CHECK(cached.BackendStats().diagnosticReadbacks==1); // Only explicit test capture, never a GPU transfer.
      CHECK(cached.Stats().nativeRegionInstalls==0);
    }
    DestroyWindow(a);DestroyWindow(b);Gdiplus::GdiplusShutdown(gdiplus);
    std::cout<<"LAYERED_COMPATIBILITY=PASS preparedPixels=true noGpuReadback=true idleNoPresent=true "
      <<"rotationCropOpacityScissor=true textureReplacement=true boundedResources=true recovery=true scope=forced-backend-not-old-OS\n";
    return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<"\n";return 1; }
}
