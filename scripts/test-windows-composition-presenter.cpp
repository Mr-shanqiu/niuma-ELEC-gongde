#include "../src/windows/runtime/composition_presenter.h"
#include <cstdio>
#include <cstdlib>

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
int main() {
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
