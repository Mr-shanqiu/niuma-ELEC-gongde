// A CI-only input-chain probe. It sends tagged F24 pairs, never records raw keys.
#include <atomic>
#include <thread>

namespace keyboard_probe {
constexpr unsigned kKeys = 200;
constexpr ULONG_PTR kTag = 0x4e4d0000;
std::array<std::atomic<LONGLONG>, kKeys> sent{}, entered{}, witnessed{}, completed{}, callbackEnd{}, sendReturned{};
std::array<unsigned, kKeys> pending{};
unsigned pendingRead = 0, pendingWrite = 0;
std::atomic<unsigned> hookCount{0}, witnessCount{0}, completedCount{0}, acceptedEvents{0};
std::atomic<bool> finished{false}, stop{false}, witnessReady{false};
std::atomic<DWORD> sourceError{0}, witnessError{0}, witnessThreadId{0};
LARGE_INTEGER frequency{};
HANDLE readyEvent = nullptr;

bool Known(int code, WPARAM message, LPARAM data, unsigned* index) {
  if (code != HC_ACTION || !data || (message != WM_KEYDOWN && message != WM_KEYUP &&
      message != WM_SYSKEYDOWN && message != WM_SYSKEYUP)) return false;
  const auto* key = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
  const ULONG_PTR tag = key->dwExtraInfo;
  const auto sequence = static_cast<unsigned>(tag & 0xffff);
  if ((tag & ~static_cast<ULONG_PTR>(0xffff)) != kTag || sequence == 0 || sequence > kKeys) return false;
  *index = sequence - 1;
  return true;
}
LONGLONG Tick() { LARGE_INTEGER value{}; QueryPerformanceCounter(&value); return value.QuadPart; }
LRESULT CALLBACK Witness(int code, WPARAM message, LPARAM data) {
  unsigned index = 0;
  if (Known(code, message, data, &index) && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
    witnessed[index].store(Tick()); ++witnessCount;
  }
  return CallNextHookEx(nullptr, code, message, data);
}
LRESULT CALLBACK ApplicationHook(int code, WPARAM message, LPARAM data) {
  unsigned index = 0;
  if (!Known(code, message, data, &index)) return CallNextHookEx(nullptr, code, message, data);
  const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
  if (down) {
    entered[index].store(Tick()); ++hookCount;
    if (pendingWrite < kKeys) pending[pendingWrite++] = index;
  }
  // This is the actual product callback, including its real CallNextHookEx.
  const auto result = KeyboardHook(code, message, data);
  if (down) callbackEnd[index].store(Tick());
  return result;
}
LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == kCountMessage) {
    if (pendingRead >= pendingWrite) return 0;
    const auto index = pending[pendingRead++];
    CountGlobalDelivery(false, lp, wp);
    completed[index].store(Tick()); ++completedCount;
    return 0;
  }
  if (message == WM_TIMER && (wp == kAnimationTimer || wp == kOffworkTimer))
    return WindowProcedure(window, message, wp, lp);
  return DefWindowProcW(window, message, wp, lp);
}
void WriteTiming(std::ostream& output, const std::array<std::atomic<LONGLONG>,kKeys>& ends,
    const std::array<std::atomic<LONGLONG>,kKeys>& starts) {
  std::vector<double> values;
  for (unsigned i = 0; i < kKeys; ++i) {
    const auto a = starts[i].load(), b = ends[i].load();
    if (a && b >= a) values.push_back(static_cast<double>(b-a)*1000/frequency.QuadPart);
  }
  std::sort(values.begin(), values.end()); double sum = 0;
  for (const auto value : values) sum += value;
  output << "{\"samples\":" << values.size() << ",\"meanMs\":" << (values.empty()?0:sum/values.size())
      << ",\"p95Ms\":" << (values.empty()?0:values[(values.size()-1)*95/100])
      << ",\"maxMs\":" << (values.empty()?0:values.back()) << '}';
}
}

static int RunKeyboardChainProbe(const std::filesystem::path& root, const std::filesystem::path& report) {
  using namespace keyboard_probe;
  for (unsigned i = 0; i < kKeys; ++i) {
    sent[i]=0; entered[i]=0; witnessed[i]=0; completed[i]=0; callbackEnd[i]=0; sendReturned[i]=0;
  }
  std::filesystem::create_directories(report.parent_path() / "keyboard-data");
  gIsolatedAcceptance = true; gAcceptanceRoot = (report.parent_path() / "keyboard-data").wstring();
  Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "keyboard probe COM");
  Gdiplus::GdiplusStartupInput startup;
  Check(Gdiplus::GdiplusStartup(&gState.gdiplusToken, &startup, nullptr)==Gdiplus::Ok, "keyboard probe GDI+");
  Check(LoadAllPngResources(), "keyboard probe resources");
  niuma::AppearancePack pack; LoadFixture(root / L"assets/appearance-packs/offwork-button",pack);
  gProfileFixturePack = &pack;
  SYSTEMTIME date{}; GetLocalTime(&date); gState.currentDay=DateKey(date);
  gOffwork.enabled=true; gState.dpi=192;
  gState.windowWidth=ScaleDip(kWindowDipWidth,gState.dpi);
  gState.windowHeight=ScaleDip(MainWindowDipHeight(),gState.dpi);
  WNDCLASSW wc{}; wc.lpfnWndProc=Procedure; wc.hInstance=GetModuleHandleW(nullptr);
  wc.lpszClassName=L"NiuMaKnownKeyboardProbe";
  Check(RegisterClassW(&wc)!=0,"keyboard probe window class");
  gState.window=CreateWindowExW(WS_EX_LAYERED|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,wc.lpszClassName,
      L"Known input-chain test",WS_POPUP,0,0,gState.windowWidth,gState.windowHeight,nullptr,nullptr,wc.hInstance,nullptr);
  Check(gState.window!=nullptr,"keyboard probe window");
  RefreshOffwork(false); Check(SyncOffworkTimer(),"keyboard probe clock");
  RenderLayeredWindow(GetTickCount64()); ShowWindow(gState.window,SW_SHOWNOACTIVATE);
  const bool visible=IsWindowVisible(gState.window)!=FALSE;
  QueryPerformanceFrequency(&frequency);
  readyEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr); Check(readyEvent!=nullptr,"witness ready event");
  std::thread observer([] {
    witnessThreadId=GetCurrentThreadId(); MSG message{};
    PeekMessageW(&message,nullptr,0,0,PM_NOREMOVE);
    HHOOK hook=SetWindowsHookExW(WH_KEYBOARD_LL,Witness,GetModuleHandleW(nullptr),0);
    witnessError=hook?0:GetLastError(); witnessReady=hook!=nullptr; SetEvent(readyEvent);
    if (!hook) return;
    while (GetMessageW(&message,nullptr,0,0)>0) DispatchMessageW(&message);
    UnhookWindowsHookEx(hook);
  });
  const bool ready=WaitForSingleObject(readyEvent,5000)==WAIT_OBJECT_0;
  DWORD appError=0;
  if (ready && witnessReady) {
    gState.keyboardHook=SetWindowsHookExW(WH_KEYBOARD_LL,ApplicationHook,GetModuleHandleW(nullptr),0);
    if(!gState.keyboardHook) appError=GetLastError();
  }
  const bool installed=gState.keyboardHook!=nullptr;
  const auto initialTotal=gState.total;
  perf::soakMode=true; perf::soakFrames={};
  const auto started=std::chrono::steady_clock::now();
  std::thread sender;
  if(installed) sender=std::thread([&] {
    for(unsigned i=0;i<kKeys && !stop;++i) {
      INPUT keys[2]{};
      for(auto& key:keys) {key.type=INPUT_KEYBOARD;key.ki.wVk=VK_F24;key.ki.dwExtraInfo=kTag|(i+1);}
      keys[1].ki.dwFlags=KEYEVENTF_KEYUP;
      sent[i]=Tick(); SetLastError(0);
      const auto accepted=SendInput(2,keys,sizeof(INPUT));
      sendReturned[i]=Tick(); acceptedEvents+=accepted;
      if(accepted!=2) {sourceError=GetLastError();break;}
      std::this_thread::sleep_until(started+std::chrono::milliseconds((i+1)*50));
    }
    finished=true;
  }); else finished=true;
  while(installed) {
    MSG message{};
    const auto batchStarted=std::chrono::steady_clock::now();
    for(unsigned batch=0;batch<16 && PeekMessageW(&message,gState.window,0,0,PM_REMOVE);++batch) {
      DispatchMessageW(&message);
      if(std::chrono::steady_clock::now()-batchStarted>=std::chrono::milliseconds(20))break;
    }
    if(finished && completedCount==kKeys && witnessCount==kKeys)break;
    if((finished && acceptedEvents!=kKeys*2) || std::chrono::steady_clock::now()-started>std::chrono::seconds(60))break;
    MsgWaitForMultipleObjectsEx(0,nullptr,5,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
  }
  stop=true;
  if(gState.keyboardHook) {UnhookWindowsHookEx(gState.keyboardHook);gState.keyboardHook=nullptr;}
  if(sender.joinable())sender.join();
  if(witnessThreadId)PostThreadMessageW(witnessThreadId,WM_QUIT,0,0);
  observer.join(); CloseHandle(readyEvent);
  perf::soakMode=false;
  const auto elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();
  const auto countDelta=gState.total-initialTotal;
  const bool passed=installed && hookCount==kKeys && witnessCount==kKeys && completedCount==kKeys &&
      acceptedEvents==kKeys*2 && countDelta==kKeys;
  std::ofstream output(report); Check(output.good(),"keyboard probe report");
  output<<std::fixed<<std::setprecision(6)<<"{\"version\":\""<<NIUMA_PROFILE_VERSION
      <<"\",\"status\":\""<<(passed?"passed":"blocked-or-failed")<<"\",\"knownKeydowns\":"<<kKeys
      <<",\"acceptedInjectedEvents\":"<<acceptedEvents.load()<<",\"hookKeydowns\":"<<hookCount.load()
      <<",\"witnessKeydowns\":"<<witnessCount.load()<<",\"countedKeydowns\":"<<completedCount.load()
      <<",\"countDelta\":"<<countDelta<<",\"elapsedSeconds\":"<<elapsed
      <<",\"windowVisible\":"<<(visible?"true":"false")<<",\"appHookInstalled\":"<<(installed?"true":"false")
      <<",\"witnessHookInstalled\":"<<(witnessReady?"true":"false")
      <<",\"applicationHookError\":"<<appError<<",\"witnessHookError\":"<<witnessError.load()
      <<",\"sendInputError\":"<<sourceError.load()<<",\"sourceToApplicationHook\":";
  WriteTiming(output,entered,sent); output<<",\"sourceToIndependentWitness\":";WriteTiming(output,witnessed,sent);
  output<<",\"sourceToCountCompletion\":";WriteTiming(output,completed,sent);
  output<<",\"applicationCallbackDuration\":";WriteTiming(output,callbackEnd,entered);
  output<<",\"sendInputCallDuration\":";WriteTiming(output,sendReturned,sent);
  output<<",\"frames\":"<<perf::soakFrames.count<<",\"meanFrameMs\":"
      <<(perf::soakFrames.count?perf::soakFrames.total/perf::soakFrames.count:0)
      <<",\"realHardwareInput\":false,\"realWindowsHookChain\":true,\"productMainEntryRun\":false,"
        "\"scope\":\"tagged injected F24 on a dedicated CI desktop; actual product keyboard callback and count/timer handlers; independent witness thread; no user input collection\"}";
  output.close();
  KillTimer(gState.window,kAnimationTimer);KillTimer(gState.window,kOffworkTimer);
  gProfileFixturePack=nullptr;
  // Keep fixture images alive only until GDI+ cleanup, as in normal shutdown.
  pack.layers.clear();ReleaseAllPngResources();DestroyWindow(gState.window);gState.window=nullptr;
  Gdiplus::GdiplusShutdown(gState.gdiplusToken);CoUninitialize();
  return passed?0:1;
}
