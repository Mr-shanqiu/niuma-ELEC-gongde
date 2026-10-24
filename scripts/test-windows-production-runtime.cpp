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
int FullscreenPeer() {
  EnableBestDpiAwareness();
  WNDCLASSW wc{};wc.lpfnWndProc=DefWindowProcW;wc.hInstance=GetModuleHandleW(nullptr);
  wc.lpszClassName=L"NiuMaVisibilityFullscreenPeer";
  if(!RegisterClassW(&wc)) return 2;
  MONITORINFO monitor{};monitor.cbSize=sizeof(monitor);
  if(!GetMonitorInfoW(MonitorFromPoint({0,0},MONITOR_DEFAULTTOPRIMARY),&monitor)) return 3;
  RECT r=monitor.rcMonitor;
  HWND window=CreateWindowExW(WS_EX_TOPMOST,wc.lpszClassName,L"Isolated fullscreen peer",WS_POPUP,
      r.left,r.top,r.right-r.left,r.bottom-r.top,nullptr,nullptr,wc.hInstance,nullptr);
  if(!window) return 4;
  ShowWindow(window,SW_SHOW);SetForegroundWindow(window);
  MSG message{};
  while(IsWindow(window) && GetMessageW(&message,nullptr,0,0)>0) {
    TranslateMessage(&message);DispatchMessageW(&message);
  }
  return 0;
}
int wmain(int argc,wchar_t** argv) {
  if(argc==2 && std::wstring(argv[1])==L"--fullscreen-peer") return FullscreenPeer();
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
    // CI exercises actual HWND hiding, no frame submissions, independent input
    // owner and durable storage. It does not stand in for human typing on Win10.
    gVisibility.recoveryAvailable=true; // Shell may not run on a hosted runner.
    gVisibility.manualHidden=true; ApplyWindowVisibility();
    CHECK(!IsWindowVisible(window) && !gState.timerRunning);
    const auto hiddenFrames=gDisplay.display->Stats().framesPresented;
    gInput.diagnostic.tagMask=0xffff0000; gInput.diagnostic.tagValue=0x4e4d0000;
    gInput.diagnostic.maximumSequence=16;
    RestartGlobalListeners();
    CHECK(gInput.service && gInput.service->running());
    const auto inputReady=GetTickCount64()+5000;
    while(!gInput.latest.input.keyboardAvailable && GetTickCount64()<inputReady){pump();Sleep(5);}
    CHECK(gInput.latest.input.keyboardAvailable);
    const auto beforeHidden=gState.total;
    for(unsigned i=1;i<=12;++i) {
      INPUT pair[2]{}; pair[0].type=pair[1].type=INPUT_KEYBOARD;
      pair[0].ki.wVk=pair[1].ki.wVk=VK_F24;
      pair[0].ki.dwExtraInfo=pair[1].ki.dwExtraInfo=0x4e4d0000|i;
      pair[1].ki.dwFlags=KEYEVENTF_KEYUP;
      CHECK(SendInput(2,pair,sizeof(INPUT))==2);
      pump();Sleep(5);
    }
    const auto delivered=GetTickCount64()+5000;
    while(gState.total<beforeHidden+12 && GetTickCount64()<delivered){pump();Sleep(5);}
    CHECK(gState.total==beforeHidden+12);
    CHECK(!IsWindowVisible(window) && !gState.timerRunning);
    CHECK(gDisplay.display->Stats().framesPresented==hiddenFrames);
    // Countdown and explicit repaint requests also submit no hidden frames.
    SendMessageW(window,WM_TIMER,kOffworkTimer,0); RenderLayeredWindow(GetTickCount64());
    CHECK(gDisplay.display->Stats().framesPresented==hiddenFrames);
    const auto durable=GetTickCount64()+8000;
    while(GetTickCount64()<durable) {
      RequestInputLedger();pump();PumpDataStorage(true);
      if(gDataStorage.model->current().counts.total==beforeHidden+12 && DataStorageIdle()) break;
      Sleep(5);
    }
    CHECK(gDataStorage.model->current().counts.total==beforeHidden+12 && DataStorageIdle());
    gVisibility.manualHidden=false; ApplyWindowVisibility();
    CHECK(IsWindowVisible(window) && !gState.striking && !gState.timerRunning);
    CHECK(gDisplay.display->Stats().framesPresented>hiddenFrames);
    // Inspect a real foreign foreground window, not a copied detector implementation.
    wchar_t executable[32768]{};CHECK(GetModuleFileNameW(nullptr,executable,32768));
    std::wstring peerCommand=L"\""+std::wstring(executable)+L"\" --fullscreen-peer";
    STARTUPINFOW peerStartup{};peerStartup.cb=sizeof(peerStartup);PROCESS_INFORMATION peer{};
    CHECK(CreateProcessW(executable,peerCommand.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&peerStartup,&peer));
    HWND peerWindow=nullptr;
    const auto peerReady=GetTickCount64()+5000;
    while(!peerWindow && GetTickCount64()<peerReady) {
      peerWindow=FindWindowW(L"NiuMaVisibilityFullscreenPeer",nullptr);pump();Sleep(10);
    }
    CHECK(peerWindow); SetForegroundWindow(peerWindow);
    const auto foregroundReady=GetTickCount64()+2000;
    while(GetForegroundWindow()!=peerWindow && GetTickCount64()<foregroundReady){pump();Sleep(10);}
    CHECK(GetForegroundWindow()==peerWindow && ForegroundIsFullscreen());
    RefreshFullscreenVisibility(); CHECK(!IsWindowVisible(window));
    // Explicit Show overrides just this fullscreen session, without changing the preference.
    SetManualHidden(false); CHECK(IsWindowVisible(window) && gVisibility.autoHideFullscreen);
    ShowWindow(peerWindow,SW_MINIMIZE);RefreshFullscreenVisibility();CHECK(!gVisibility.fullscreen);
    ShowWindow(peerWindow,SW_RESTORE);SetForegroundWindow(peerWindow);RefreshFullscreenVisibility();
    CHECK(gVisibility.fullscreen && !IsWindowVisible(window));
    SetWindowPos(peerWindow,nullptr,30,30,640,480,SWP_NOZORDER|SWP_NOACTIVATE);
    RefreshFullscreenVisibility();CHECK(!gVisibility.fullscreen && IsWindowVisible(window));
    DWORD_PTR peerClosed=0;SendMessageTimeoutW(peerWindow,WM_CLOSE,0,0,SMTO_ABORTIFHUNG,2000,&peerClosed);
    CHECK(WaitForSingleObject(peer.hProcess,3000)==WAIT_OBJECT_0);
    CloseHandle(peer.hThread);CloseHandle(peer.hProcess);
    // Automatic hide cannot override manual hide, and no recovery keeps it visible.
    gVisibility.fullscreen=true; ApplyWindowVisibility(); CHECK(!IsWindowVisible(window));
    gVisibility.manualHidden=true; gVisibility.fullscreen=false; ApplyWindowVisibility(); CHECK(!IsWindowVisible(window));
    gVisibility.recoveryAvailable=false; ApplyWindowVisibility(); CHECK(IsWindowVisible(window));
    gVisibility.manualHidden=false; gVisibility.fullscreen=false; ApplyWindowVisibility();
    ToggleAutoHideFullscreen(); CHECK(!gVisibility.autoHideFullscreen);
    CHECK(!gDataStorage.model->current().autoHideFullscreen);
    BeginClientClose(window);
    const auto closing=GetTickCount64()+10000;
    while(IsWindow(window) && GetTickCount64()<closing){pump();Sleep(5);}
    CHECK(!IsWindow(window));
    gInput.service.reset();gDataStorage.service.reset();gAppearance=AppearanceAdapter{};gDisplay=DisplayAdapter{};
    wchar_t kept[32]{};
    GetPrivateProfileStringW(L"custom",L"keep",L"missing",kept,32,(root/L"data.ini").c_str());
    CHECK(std::wstring(kept)==L"original");
    CHECK(GetPrivateProfileIntW(L"state",L"auto_hide_fullscreen",1,(root/L"data.ini").c_str())==0);
    CHECK(GetPrivateProfileIntW(L"state",L"total",0,(root/L"data.ini").c_str())==12357);
    std::cout<<"PRODUCTION_RUNTIME=PASS privateCandidate=false composition=true noGdiFallback=true "
        <<"existingTotal=12345 hiddenInput=12 savedTotal=12357 hiddenNoPresent=true nativeFullscreen=true explicitShowOverride=true restoredLatest=true autoHideSaved=true unknownIniPreserved=true idleNoPresent=true normalClose=true "
        <<"scope=CI-software-not-hardware\n";
    Gdiplus::GdiplusShutdown(gdi);CoUninitialize();return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
