#include "../src/windows/runtime/client_display.h"
#include "../src/windows/runtime/embedded_scene.h"
#include "../src/windows/runtime/appearance_service.h"
#include <gdiplus.h>
#include <cstdio>
#include <cstdlib>
#include <thread>

namespace {
void Check(bool okay,const char* name) {
  if(!okay) { std::fprintf(stderr,"FAIL %s\n",name); std::exit(1); }
}
}
int main() {
  using namespace niuma::windows::runtime;
  namespace graphics=niuma::runtime;
  Check(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)),"COM startup");
  Gdiplus::GdiplusStartupInput gdiInput; ULONG_PTR gdi=0;
  Check(Gdiplus::GdiplusStartup(&gdi,&gdiInput,nullptr)==Gdiplus::Ok,"GDI startup");
  WNDCLASSW cls{}; cls.hInstance=GetModuleHandleW(nullptr); cls.lpfnWndProc=DefWindowProcW;
  cls.lpszClassName=L"NiuMaCompleteDisplayTest";
  Check(RegisterClassW(&cls)!=0,"private display class");
  HWND window=CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,
      cls.lpszClassName,L"NiuMa owned display test",WS_POPUP,30,30,240,334,nullptr,nullptr,cls.hInstance,nullptr);
  Check(window!=nullptr,"private display window");
  {
    ClientDisplay display;
    Check(display.Initialize(window,240,334,true),"composition initialization (CI software allowed)");
    ClientDisplayState view;
    view.text.merit=L"120"; view.text.countdownVisible=true;
    view.text.countdownLabel=L"距下班"; view.text.countdownDuration=L"01:00:00";
    Check(display.DrawLatest(view,1000,240,334),"initial text without waiting for assets");
    niuma::AppearanceResourceRequest source;
    Check(EmbeddedWoodfishRequest(source) && source.contentFingerprint.size()==64,"immutable embedded identity");
    AppearanceService loader;
    Check(loader.Start().started,"real production appearance worker");
    AppearanceLoadRequest request;
    request.id=1; request.generation=1; request.kind=AppearanceLoadKind::Woodfish; request.source=source;
    Check(loader.TrySubmit(request).accepted(),"submit builtin work on ordinary worker");
    AppearanceLoadResult result;
    auto deadline=GetTickCount64()+15000;
    while(!loader.TryConsumeResult(result) && GetTickCount64()<deadline) Sleep(5);
    Check(result.ready() && result.Matches(request) && result.scene && !result.animation && !result.thumbnail,
        "worker delivers prepared pixels, geometry and masks");
    Check(display.SetScene(result.scene) && !result.scene,"exclusive scene transfer only after upload");
    Check(display.DrawLatest(view,1001,240,334),"complete embedded scene and text");
    const auto idle=display.Stats().framesPresented;
    const auto uploads=display.Stats().textureUploads;
    const auto redraws=display.TextStats().redraws;
    for(unsigned i=0;i<120;++i) Check(display.DrawLatest(view,1002+i,240,334),"same display state");
    Check(display.Stats().framesPresented==idle && display.Stats().textureUploads==uploads &&
        display.TextStats().redraws==redraws,"idle performs no presents, uploads or text rasterization");
    view.text.countdownDuration=L"00:59:59";
    Check(display.DrawLatest(view,1130,240,334) && display.Stats().framesPresented==idle+1 &&
        display.Stats().textureUploads==uploads+1 && display.TextStats().redraws[0]==redraws[0] &&
        display.TextStats().redraws[1]==redraws[1],"one second updates clock only");
    view.action={true,1,1200,400};
    auto beforeAnimation=display.TextStats().redraws;
    for(unsigned i=0;i<=24;++i) Check(display.DrawLatest(view,1200+i*20,240,334),"real shared woodfish animation");
    Check(display.TextStats().redraws==beforeAnimation && display.BackendStats().diagnosticReadbacks==0,
        "animation reuses all text and has no GPU readback");
    view.action.active=false;
    view.text.pixelScale=.75f;
    Check(display.DrawLatest(view,1700,180,251),"DPI geometry and text change together");
    Check(display.RecreateDevice() && display.DrawLatest(view,1701,180,251) &&
        display.BackendStats().textureCount==6,"explicit recreation restores latest resources without asset IO");
    std::unique_ptr<PreparedAppearanceScene> missing;
    const auto* previous=display.scene();
    Check(!display.SetScene(missing) && display.scene()==previous,"invalid switch preserves current scene");
    loader.Stop(0);
    deadline=GetTickCount64()+5000;
    while(!loader.Stop(0).stopped && GetTickCount64()<deadline) Sleep(1);
    Check(loader.Snapshot().stopped,"worker exits before HWND and GDI teardown");
    std::printf("PASS full display: real builtin worker, idle, second-only updates, animation, DPI, explicit device recovery; adapter=%s; CPU scene=%llu; text=%llu\n",
        display.Adapter().kind.c_str(),static_cast<unsigned long long>(display.scene()->memory.residentBytes()),
        static_cast<unsigned long long>(display.TextStats().pixelBytes));
    display.Shutdown();
  }
  DestroyWindow(window); UnregisterClassW(cls.lpszClassName,cls.hInstance);
  Gdiplus::GdiplusShutdown(gdi); CoUninitialize();
}
