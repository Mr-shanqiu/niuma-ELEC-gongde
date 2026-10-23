// Reuse the exact private app fixture and real adapter. No SendInput is used:
// synthetic local-fallback commands exercise the owner while other apps remain usable.
#define wmain NiuMaUnusedShortAdapterMain
#include "test-windows-runtime-app.cpp"
#undef wmain
#include <psapi.h>
#include <tlhelp32.h>

namespace {
std::uint64_t ProcessThreads() {
  HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD,0);
  CHECK(snapshot!=INVALID_HANDLE_VALUE);
  THREADENTRY32 entry{}; entry.dwSize=sizeof(entry); std::uint64_t count=0;
  if(Thread32First(snapshot,&entry)) do {
    if(entry.th32OwnerProcessID==GetCurrentProcessId()) ++count;
  } while(Thread32Next(snapshot,&entry));
  CloseHandle(snapshot); return count;
}
bool InputDesktopAvailable() {
  HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
  if(!desktop) return false;
  CloseDesktop(desktop); return true;
}
std::uint64_t CpuTime100ns(bool uiThread) {
  FILETIME created{}, exited{}, kernel{}, user{};
  CHECK(uiThread ? GetThreadTimes(GetCurrentThread(),&created,&exited,&kernel,&user)
                 : GetProcessTimes(GetCurrentProcess(),&created,&exited,&kernel,&user));
  ULARGE_INTEGER k{},u{};
  k.LowPart=kernel.dwLowDateTime; k.HighPart=kernel.dwHighDateTime;
  u.LowPart=user.dwLowDateTime; u.HighPart=user.dwHighDateTime;
  return k.QuadPart+u.QuadPart;
}
double Percentile(std::array<double,1024> values,std::size_t count,double fraction) {
  CHECK(count>0 && count<=values.size());
  std::sort(values.begin(),values.begin()+count);
  return values[static_cast<std::size_t>(std::ceil(count*fraction))-1];
}
void RunDurability(const std::filesystem::path& parent,unsigned seconds,unsigned activeFirstSeconds,unsigned mixedPeriodSeconds) {
  CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)));
  Gdiplus::GdiplusStartupInput startup; ULONG_PTR gdi=0;
  CHECK(Gdiplus::GdiplusStartup(&gdi,&startup,nullptr)==Gdiplus::Ok);
  {
    Fixture fixture(parent,L"durability",true);
    // Exercise the planned 200% complex-scene budget without changing the
    // machine's actual display settings. Only this owned window is resized.
    gOffwork.enabled=true; gOffwork.hour=18; gOffwork.minute=0;
    gState.dpi=192;
    gState.windowWidth=ScaleDip(kWindowDipWidth,gState.dpi);
    gState.windowHeight=ScaleDip(MainWindowDipHeight(),gState.dpi);
    CHECK(SetWindowPos(fixture.window,nullptr,0,0,gState.windowWidth,gState.windowHeight,
        SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE));
    wchar_t fixtureRoot[MAX_PATH]{};
    CHECK(GetEnvironmentVariableW(L"NIUMA_RUNTIME_FIXTURE_DIR",fixtureRoot,MAX_PATH)>0);
    std::wstring error;
    CHECK(gAppearanceCatalog.ReloadMetadata(AppearanceDirectory(),&error));
    std::vector<std::string> ids;
    for(const wchar_t* name:{L"offwork-button.nmgpack",L"koi-bubbles.nmgpack"}) {
      std::string id;
      CHECK(gAppearanceCatalog.Install((std::filesystem::path(fixtureRoot)/name).wstring(),
          AppearanceDirectory(),&id,&error));
      ids.push_back(id);
    }
    CHECK(RequestCurrentAppearance(ids.front(),false));
    fixture.Await([] { return !gAppearance.currentRequest && gDisplay.display && gDisplay.display->scene(); },15000);
    CHECK(!gDisplay.failed);
    fixture.Start(true);  // Tagged diagnostic hooks ignore all physical user input.
    input_runtime::InputCommand consumed;
    consumed.kind=input_runtime::InputCommandKind::RestoreReminderSegmentConsumed;
    consumed.enabled=true;
    CHECK(SendInputCommand(consumed));
    RefreshOffwork(false); CHECK(SyncOffworkTimer()); ResizeOffworkWindow();
    std::ofstream samples(fixture.directory/L"samples.jsonl",std::ios::binary);
    CHECK(samples.good());
    const auto started=GetTickCount64();
    const auto end=started+std::uint64_t(seconds)*1000;
    auto nextOperation=started, nextSwitch=started+15000, nextSample=started;
    std::uint64_t operations=0,switches=0,sampleCount=0,interactiveSamples=0;
    unsigned selected=0;
    while(GetTickCount64()<end) {
      fixture.Pump(2);
      const auto now=GetTickCount64();
      const auto elapsed=(now-started)/1000;
      const bool continuous=elapsed<activeFirstSeconds;
      const bool active=continuous || ((elapsed-activeFirstSeconds)/mixedPeriodSeconds)%2==0;
      if(active && now>=nextOperation) {
        input_runtime::InputCommand command;
        command.kind=input_runtime::InputCommandKind::LocalFallbackClick;
        command.expectedEpoch=gInput.latest.input.epoch;
        command.capturedMs=now;
        command.capturedDate=input_runtime::InputService::CaptureLocalDate();
        CHECK(SendInputCommand(command)); ++operations;
        nextOperation=now+100;
      }
      if(active && now>=nextSwitch && !gAppearance.currentRequest) {
        selected=1-selected;
        CHECK(RequestCurrentAppearance(ids[selected],false)); ++switches;
        nextSwitch=now+15000;
        // Exercise the real thumbnail queue/cache without a focus-stealing picker.
        gAppearance.thumbnails.Clear();
        gPicker.window=fixture.window;
        QueueVisibleThumbnails();
      }
      CHECK(!gDisplay.failed && !gAppearance.stopping && gInput.service->running());
      if(now>=nextSample) {
        PROCESS_MEMORY_COUNTERS_EX memory{}; memory.cb=sizeof(memory);
        DWORD handles=0;
        MEMORYSTATUSEX systemMemory{}; systemMemory.dwLength=sizeof(systemMemory);
        CHECK(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory)));
        CHECK(GetProcessHandleCount(GetCurrentProcess(),&handles));
        CHECK(GlobalMemoryStatusEx(&systemMemory));
        const auto& backend=gDisplay.display->BackendStats();
        const auto worker=gAppearance.service->Snapshot();
        const bool interactive=InputDesktopAvailable();
        ++sampleCount; if(interactive) ++interactiveSamples;
        CHECK(backend.textureCount<=9 && gAppearance.thumbnails.size()<=12 &&
            gDisplay.display->scene()->memory.residentBytes()<=24*1024*1024);
        samples<<"{\"elapsedSeconds\":"<<elapsed<<",\"active\":"<<(active?"true":"false")<<
            ",\"inputDesktopAvailable\":"<<(interactive?"true":"false")<<
            ",\"privateBytes\":"<<memory.PrivateUsage<<",\"workingSetBytes\":"<<memory.WorkingSetSize<<
            ",\"systemAvailableBytes\":"<<systemMemory.ullAvailPhys<<
            ",\"systemCommitHeadroomBytes\":"<<systemMemory.ullAvailPageFile<<
            ",\"processCpuTime100ns\":"<<CpuTime100ns(false)<<",\"uiThreadCpuTime100ns\":"<<CpuTime100ns(true)<<
            ",\"handles\":"<<handles<<",\"gdiObjects\":"<<GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS)<<
            ",\"userObjects\":"<<GetGuiResources(GetCurrentProcess(),GR_USEROBJECTS)<<
            ",\"threads\":"<<ProcessThreads()<<",\"textures\":"<<backend.textureCount<<
            ",\"textureBytes\":"<<backend.textureBytes<<",\"sceneCpuBytes\":"<<gDisplay.display->scene()->memory.residentBytes()<<
            ",\"thumbnailBytes\":"<<gAppearance.thumbnails.bytes()<<",\"textBytes\":"<<gDisplay.display->TextStats().pixelBytes<<
            ",\"presents\":"<<backend.presents<<",\"assetPreparations\":"<<worker.completed<<
            ",\"syntheticCommands\":"<<operations<<",\"switches\":"<<switches<<
            ",\"dpi\":"<<gState.dpi<<",\"clientWidth\":"<<gState.windowWidth<<
            ",\"clientHeight\":"<<gState.windowHeight<<",\"frameSamples\":"<<gDisplay.measuredFrames;
        if(gDisplay.measuredFrames) {
          samples<<",\"frameWorkWallP95Ms\":"<<Percentile(gDisplay.frameWorkMs,gDisplay.measuredFrames,.95)<<
              ",\"frameWorkWallP99Ms\":"<<Percentile(gDisplay.frameWorkMs,gDisplay.measuredFrames,.99)<<
              ",\"regionWallP95Ms\":"<<Percentile(gDisplay.regionWorkMs,gDisplay.measuredFrames,.95);
        }
        samples<<"}\n";
        gDisplay.measuredFrames=0; // Fixed capacity, per-interval samples, no retained frame history.
        samples.flush(); CHECK(samples.good()); nextSample=now+15000;
      }
    }
    gPicker.window=nullptr;
    fixture.Await([&] { return gState.total>=1000+operations && !gAppearance.currentRequest; },15000);
    fixture.DrainStorage();
    const auto finalTotal=gState.total;
    CHECK(ProfileCount(std::filesystem::path(DataPath()),L"state",L"total")==finalTotal);
    const auto kind=gDisplay.display->Adapter().kind;
    WindowProcedure(fixture.window,WM_CLOSE,0,0);
    fixture.Await([&] { return !IsWindow(fixture.window); },10000);
    CHECK(gDataStorage.readyToDestroy && gAppearance.service->Snapshot().stopped && !gDisplay.display->ready());
    std::ofstream result(fixture.directory/L"durability-result.json");
    result<<"{\"executionComplete\":true,\"requestedSeconds\":"<<seconds<<
        ",\"elapsedSeconds\":"<<(GetTickCount64()-started)/1000<<
        ",\"continuousActivePhaseSeconds\":"<<std::min(seconds,activeFirstSeconds)<<
        ",\"mixedPhaseSeconds\":"<<(seconds>activeFirstSeconds?seconds-activeFirstSeconds:0)<<
        ",\"mixedPeriodSeconds\":"<<mixedPeriodSeconds<<",\"persistedTotal\":"<<finalTotal<<
        ",\"additionalLocalOperations\":"<<(finalTotal-1000-operations)<<",\"samples\":"<<sampleCount<<",\"interactiveSamples\":"<<interactiveSamples<<
        ",\"syntheticCommands\":"<<operations<<",\"switches\":"<<switches<<
        ",\"adapterKind\":\""<<kind<<"\",\"globalInputInjected\":false,\"physicalTypingMeasured\":false,"
        "\"diagnosticDpi\":192,\"frameTimingIncludesPresentWait\":true,\"gpuExecutionTimed\":false,"
        "\"memoryTrendReviewRequired\":true,\"scope\":\"real application adapter; private fixtures and data; synthetic local-fallback activity; no system security or installed profile changes\"}\n";
    result.close(); CHECK(result.good());
    std::wcout<<L"DURABILITY RESULT "<<fixture.directory.wstring()<<L"\n";
  }
  gDisplay=DisplayAdapter{}; gAppearanceCatalog=niuma::AppearanceCatalog{};
  gRuntimeCandidate=false;
  Gdiplus::GdiplusShutdown(gdi); CoUninitialize();
}
}
int wmain(int argc,wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
  try {
    CHECK(argc==5);
    const auto seconds=std::stoul(argv[2]), active=std::stoul(argv[3]), period=std::stoul(argv[4]);
    CHECK(seconds>=30 && seconds<=12*60*60 && active<=seconds && period>=5 && period<=3600);
    CHECK(std::filesystem::is_directory(argv[1]));
    WNDCLASSW cls{}; cls.hInstance=GetModuleHandleW(nullptr); cls.lpfnWndProc=FixtureProcedure;
    cls.lpszClassName=kFixtureClass; CHECK(RegisterClassW(&cls));
    cls.lpfnWndProc=ReminderWindowProcedure; cls.lpszClassName=kReminderClass; CHECK(RegisterClassW(&cls));
    RunDurability(std::filesystem::path(argv[1]),seconds,active,period);
    return 0;
  } catch(const std::exception& error) { std::cerr<<"FAILED durability: "<<error.what()<<"; Win32="<<GetLastError()<<"\n"; return 1; }
}
