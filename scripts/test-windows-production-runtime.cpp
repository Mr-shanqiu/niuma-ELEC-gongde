// Exercise the real app adapter with production display selection, but an
// isolated data root and explicitly permitted CI software graphics. No hook,
// install, startup registration or real user profile is opened.
#define wWinMain NiuMaUnusedProductionEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <fstream>
#include <iostream>
#include <stdexcept>
#define CHECK(x) do { if (!(x)) throw std::runtime_error("line " + std::to_string(__LINE__) + ": " #x); } while(false)
int wmain(int argc,wchar_t** argv) {
  ULONG_PTR gdi=0;
  try {
    CHECK(argc==2); CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)));
    Gdiplus::GdiplusStartupInput options;
    CHECK(Gdiplus::GdiplusStartup(&gdi,&options,nullptr)==Gdiplus::Ok);
    EnableBestDpiAwareness();
    const auto root=std::filesystem::absolute(argv[1]);
    CHECK(!std::filesystem::exists(root)); CHECK(std::filesystem::create_directory(root));
    CHECK(InitializeAcceptanceMode(true,true,false,false,root.wstring()));
    CHECK(!IsRuntimeCandidate() && UsesCompositionRuntime());
    gReminderPreviewAcceptance=false; gDisplay.allowSoftwareForTest=true;
    // Reuse the existing supported INI format; verify the production display
    // route doesn't reset a pre-existing count or unrelated setting.
    CHECK(WritePrivateProfileStringW(L"state",L"total",L"12345",DataPath().c_str()));
    CHECK(WritePrivateProfileStringW(L"custom",L"keep",L"original",DataPath().c_str()));
    WritePrivateProfileStringW(nullptr,nullptr,nullptr,DataPath().c_str());
    CHECK(InitializeDataStorage()); gState.total=ReadIniTotal(); CHECK(gState.total==12345);
    CHECK(EnsureCurrentDay()); gState.windowWidth=240;gState.windowHeight=250;
    WNDCLASSEXW wc{};wc.cbSize=sizeof(wc);wc.lpfnWndProc=WindowProcedure;
    wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"NiuMaProductionRouteTest";
    CHECK(RegisterClassExW(&wc));
    HWND window=CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP|WS_EX_NOACTIVATE,
        wc.lpszClassName,L"Production route CI",WS_POPUP,20,20,240,250,nullptr,nullptr,wc.hInstance,nullptr);
    CHECK(window && gState.window==window);
    ShowWindow(window,SW_SHOWNOACTIVATE);
    CHECK(RequestCurrentAppearance({},false));
    const auto pump=[] { MSG message{};while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
      if(message.message!=WM_QUIT){TranslateMessage(&message);DispatchMessageW(&message);}}
      if(gDataStorage.service) PumpDataStorage(); };
    const auto until=GetTickCount64()+15000;
    while(gAppearance.currentRequest && GetTickCount64()<until){pump();Sleep(5);}
    CHECK(!gAppearance.currentRequest && gDisplay.display && gDisplay.display->ready() && !gDisplay.failed);
    CHECK(gDisplay.display->scene() && gDisplay.display->scene()->kind==input_runtime::AppearanceSceneKind::Woodfish);
    RenderLayeredWindow(GetTickCount64());
    CHECK(gDisplay.display->Stats().framesPresented>0 && gLayeredSurface.bytes()==0);
    const auto frames=gDisplay.display->Stats().framesPresented;
    RenderLayeredWindow(GetTickCount64());
    CHECK(gDisplay.display->Stats().framesPresented==frames);
    CHECK(gDataStorage.model->current().counts.total==12345);
    BeginClientClose(window);
    const auto closing=GetTickCount64()+10000;
    while(IsWindow(window) && GetTickCount64()<closing){pump();Sleep(5);}
    CHECK(!IsWindow(window));
    gInput.service.reset();gDataStorage.service.reset();gAppearance=AppearanceAdapter{};gDisplay=DisplayAdapter{};
    wchar_t kept[32]{};
    GetPrivateProfileStringW(L"custom",L"keep",L"missing",kept,32,(root/L"data.ini").c_str());
    CHECK(std::wstring(kept)==L"original");
    std::cout<<"PRODUCTION_RUNTIME=PASS privateCandidate=false composition=true noGdiFallback=true "
        <<"existingTotal=12345 unknownIniPreserved=true idleNoPresent=true normalClose=true "
        <<"scope=CI-software-not-hardware\n";
    Gdiplus::GdiplusShutdown(gdi);CoUninitialize();return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
