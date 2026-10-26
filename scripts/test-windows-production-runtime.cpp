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
bool sawHiddenTrayMenu = false;
constexpr UINT kPeerModeMessage = WM_APP + 1;
void CALLBACK CancelHiddenTrayMenu(HWND, UINT, UINT_PTR timer, DWORD) {
  static unsigned attempts=0;
  if (FindWindowW(L"#32768", nullptr)) sawHiddenTrayMenu=true;
  if (sawHiddenTrayMenu || ++attempts >= 30) { KillTimer(nullptr,timer);EndMenu(); }
}
int FullscreenPeer() {
  EnableBestDpiAwareness();
  WNDCLASSW wc{};wc.lpfnWndProc=[](HWND window,UINT message,WPARAM mode,LPARAM value)->LRESULT {
    if(message!=kPeerModeMessage) return DefWindowProcW(window,message,mode,value);
    MONITORINFO monitor{};monitor.cbSize=sizeof(monitor);
    if(!GetMonitorInfoW(MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST),&monitor)) return 0;
    ShowWindow(window,SW_RESTORE);
    const bool titled=mode==1 || mode==2;
    SetWindowLongPtrW(window,GWL_STYLE,WS_VISIBLE | (titled ? WS_OVERLAPPEDWINDOW : WS_POPUP));
    const auto r=monitor.rcMonitor;
    const int border=mode==3 ? 8 : 0;
    if(titled) SetWindowPos(window,nullptr,r.left+30,r.top+30,640,480,SWP_NOZORDER|SWP_FRAMECHANGED);
    else SetWindowPos(window,nullptr,r.left-border,r.top-border,
        r.right-r.left+border*2,r.bottom-r.top+border*2,SWP_NOZORDER|SWP_FRAMECHANGED);
    if(mode==2) ShowWindow(window,SW_MAXIMIZE);
    return 1;
  };wc.hInstance=GetModuleHandleW(nullptr);
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
    const bool layered = argc==3 && std::wstring(argv[2])==L"--layered";
    CHECK(argc==2 || layered); CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)));
    Gdiplus::GdiplusStartupInput options;
    CHECK(Gdiplus::GdiplusStartup(&gdi,&options,nullptr)==Gdiplus::Ok);
    EnableBestDpiAwareness();
    const auto root=std::filesystem::absolute(argv[1]);
    CHECK(!std::filesystem::exists(root)); CHECK(std::filesystem::create_directory(root));
    CHECK(InitializeAcceptanceMode(true,true,false,false,root.wstring()));
    CHECK(!IsRuntimeCandidate() && UsesCompositionRuntime());
    gReminderPreviewAcceptance=false; gDisplay.allowSoftwareForTest=true; gDisplay.layeredForTest=layered;
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
    CHECK(gDisplay.display->layered()==layered);
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
    const UINT_PTR menuTimer=SetTimer(nullptr,0,100,CancelHiddenTrayMenu);CHECK(menuTimer);
    ShowContextMenu(window,{50,50});KillTimer(nullptr,menuTimer);
    CHECK(sawHiddenTrayMenu && !IsWindowVisible(window));
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
    // Exercise automatic WM_TIMER delivery, not a direct call to the detector.
    gState.reminderClockGuard.Start(static_cast<std::int64_t>(std::time(nullptr)),GetTickCount64(),false);
    CHECK(SetTimer(window,kReminderTimer,1000,nullptr));
    const auto awaitVisibility=[&](bool hidden) {
      const auto deadline=GetTickCount64()+3500;
      do { pump(); if(gVisibility.fullscreen==hidden &&
          (IsWindowVisible(window)!=FALSE)==!hidden) return; Sleep(10); } while(GetTickCount64()<deadline);
      throw std::runtime_error(hidden ? "automatic hide timed out" : "automatic restore timed out");
    };
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
    awaitVisibility(true);
    // Explicit Show overrides just this fullscreen session, without changing the preference.
    SetManualHidden(false); CHECK(IsWindowVisible(window) && gVisibility.autoHideFullscreen);
    ShowWindow(peerWindow,SW_MINIMIZE);awaitVisibility(false);
    ShowWindow(peerWindow,SW_RESTORE);SetForegroundWindow(peerWindow);awaitVisibility(true);
    CHECK(SendMessageW(peerWindow,kPeerModeMessage,1,0)==1);awaitVisibility(false);
    CHECK(!ForegroundIsFullscreen());
    CHECK(SendMessageW(peerWindow,kPeerModeMessage,2,0)==1);
    CHECK(IsZoomed(peerWindow));awaitVisibility(true);
    CHECK(SendMessageW(peerWindow,kPeerModeMessage,1,0)==1);awaitVisibility(false);
    CHECK(SendMessageW(peerWindow,kPeerModeMessage,3,0)==1);awaitVisibility(true);
    CHECK(SendMessageW(peerWindow,kPeerModeMessage,1,0)==1);awaitVisibility(false);
    KillTimer(window,kReminderTimer);
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
    std::cout<<"PRODUCTION_RUNTIME=PASS privateCandidate=false layered="<<layered<<" "
        <<"existingTotal=12345 hiddenInput=12 savedTotal=12357 hiddenNoPresent=true nativeFullscreen=true automaticTimer=true maximizedAutoHide=true overscanAutoHide=true windowedRestore=true explicitShowOverride=true restoredLatest=true autoHideSaved=true unknownIniPreserved=true idleNoPresent=true normalClose=true "
        <<"scope=CI-software-not-hardware\n";
    Gdiplus::GdiplusShutdown(gdi);CoUninitialize();return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
