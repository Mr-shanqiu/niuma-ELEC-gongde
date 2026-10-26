// Test only. Reuse the real adapter/private profile and existing sampler helpers.
// Never call SendInput: only owner-local commands, tagged hooks exclude real input.
#define wmain NiuMaUnusedAdapterMain
#include "test-windows-runtime-app.cpp"
#undef wmain
#include <iomanip>
#include <numeric>
#include <psapi.h>

namespace {
std::uint64_t CpuTime100ns(bool) {
  FILETIME created{},exited{},kernel{},user{};
  CHECK(GetProcessTimes(GetCurrentProcess(),&created,&exited,&kernel,&user));
  ULARGE_INTEGER k{},u{};k.LowPart=kernel.dwLowDateTime;k.HighPart=kernel.dwHighDateTime;
  u.LowPart=user.dwLowDateTime;u.HighPart=user.dwHighDateTime;return k.QuadPart+u.QuadPart;
}
double Percentile(std::array<double,1024> values,std::size_t count,double fraction) {
  CHECK(count>0&&count<=values.size());std::sort(values.begin(),values.begin()+count);
  return values[static_cast<size_t>(std::ceil(count*fraction))-1];
}
struct CpuScene { std::string id, file; };
struct CpuStage { std::string id, phase; double mean=0; };
unsigned gLogicalCpu=1;
std::vector<CpuStage> gCpuStages;
std::uint64_t gOperations=0;

double Quantile(std::vector<double> values,double fraction) {
  CHECK(!values.empty()); std::sort(values.begin(),values.end());
  return values[static_cast<size_t>(std::ceil(values.size()*fraction))-1];
}
void PrivateClick() {
  input_runtime::InputCommand c;
  c.kind=input_runtime::InputCommandKind::LocalFallbackClick;
  c.expectedEpoch=gInput.latest.input.epoch; c.capturedMs=GetTickCount64();
  c.capturedDate=input_runtime::InputService::CaptureLocalDate();
  CHECK(SendInputCommand(c)); ++gOperations;
}
void SelectCpuScene(Fixture& fixture,const CpuScene& scene,bool countdown=false,bool hidden=false) {
  gVisibility.autoHideFullscreen=false; gVisibility.fullscreen=false;
  gVisibility.manualHidden=false; ApplyWindowVisibility();
  gOffwork.enabled=countdown; gOffwork.hour=18; gOffwork.minute=0;
  CHECK(RequestCurrentAppearance(scene.id,false));
  fixture.Await([]{return !gAppearance.currentRequest && gDisplay.display && gDisplay.display->scene();},20000);
  CHECK(!gDisplay.failed);
  RefreshOffwork(false); CHECK(SyncOffworkTimer()); ResizeOffworkWindow();
  // Finish previous action and uploads outside the measurement interval.
  fixture.Until(GetTickCount64()+2000);
  gVisibility.manualHidden=hidden; ApplyWindowVisibility();
  fixture.Until(GetTickCount64()+300);
}
CpuStage MeasureCpu(Fixture& fixture,const CpuScene& scene,const std::string& phase,
                    unsigned seconds,bool active,bool hidden,std::ofstream& samples,std::ofstream& summary) {
  fixture.Await([]{return gState.total==1000+gOperations;});
  const auto initialCount=gState.total, initialOperations=gOperations;
  const auto start=GetTickCount64(),end=start+seconds*1000ULL;
  auto lastTime=start,lastCpu=CpuTime100ns(false),firstCpu=lastCpu;
  auto nextSample=start+1000,nextInput=start;
  const auto firstFrames=gDisplay.display->Stats().framesPresented;
  std::vector<double> cpu;
  PROCESS_MEMORY_COUNTERS_EX firstMemory{};firstMemory.cb=sizeof(firstMemory);
  CHECK(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&firstMemory),sizeof(firstMemory)));
  DWORD firstHandles=0;CHECK(GetProcessHandleCount(GetCurrentProcess(),&firstHandles));
  const auto firstGdi=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
  gDisplay.measuredFrames=0;
  while(GetTickCount64()<end) {
    auto now=GetTickCount64();
    if(active && now>=nextInput && nextInput<end) {PrivateClick();nextInput+=200;}
    if(now>=nextSample) {
      const auto time=GetTickCount64(),currentCpu=CpuTime100ns(false);
      const double core=double(currentCpu-lastCpu)/100.0/double(time-lastTime);
      cpu.push_back(core/gLogicalCpu);
      PROCESS_MEMORY_COUNTERS_EX memory{};memory.cb=sizeof(memory);
      DWORD handles=0;CHECK(GetProcessHandleCount(GetCurrentProcess(),&handles));
      CHECK(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory)));
      const auto& stats=gDisplay.display->Stats();
      const auto& backend=gDisplay.display->BackendStats();
      samples<<"{\"id\":\""<<scene.id<<"\",\"phase\":\""<<phase<<"\",\"elapsedMs\":"<<time-start
        <<",\"intervalMs\":"<<time-lastTime<<",\"cpuTime100ns\":"<<currentCpu-lastCpu
        <<",\"cpuOneCorePercent\":"<<core<<",\"cpuWholeMachinePercent\":"<<core/gLogicalCpu
        <<",\"privateBytes\":"<<memory.PrivateUsage<<",\"workingSetBytes\":"<<memory.WorkingSetSize
        <<",\"handles\":"<<handles<<",\"gdiObjects\":"<<GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS)
        <<",\"presents\":"<<stats.framesPresented<<",\"textures\":"<<backend.textureCount
        <<",\"textureBytes\":"<<backend.textureBytes<<",\"sceneBytes\":"<<gDisplay.display->scene()->memory.residentBytes()
        <<",\"frameSamples\":"<<gDisplay.measuredFrames;
      if(gDisplay.measuredFrames) samples<<",\"frameWallMeanMs\":"
        <<std::accumulate(gDisplay.frameWorkMs.begin(),gDisplay.frameWorkMs.begin()+gDisplay.measuredFrames,0.0)/gDisplay.measuredFrames
        <<",\"frameWallP95Ms\":"<<Percentile(gDisplay.frameWorkMs,gDisplay.measuredFrames,.95)
        <<",\"regionWallMeanMs\":"<<std::accumulate(gDisplay.regionWorkMs.begin(),gDisplay.regionWorkMs.begin()+gDisplay.measuredFrames,0.0)/gDisplay.measuredFrames;
      samples<<"}\n";samples.flush();CHECK(samples.good());gDisplay.measuredFrames=0;
      lastTime=time;lastCpu=currentCpu;nextSample+=1000;
    }
    CHECK(!gDisplay.failed && gInput.service->running());
    // Bounded message wait, not a busy-loop benchmark.
    now=GetTickCount64();auto deadline=std::min(end,nextSample);
    if(active) deadline=std::min(deadline,nextInput);
    fixture.Pump(static_cast<DWORD>(deadline>now?std::min<ULONGLONG>(50,deadline-now):0));
  }
  const auto stop=GetTickCount64(),finalCpu=CpuTime100ns(false);
  // Include the final interval in aggregate; per-second percentiles use full intervals.
  if(cpu.empty()) cpu.push_back(double(finalCpu-firstCpu)/100.0/double(stop-start)/gLogicalCpu);
  const double mean=double(finalCpu-firstCpu)/100.0/double(stop-start)/gLogicalCpu;
  fixture.Await([&]{return gState.total==initialCount+gOperations-initialOperations;});
  const auto presented=gDisplay.display->Stats().framesPresented-firstFrames;
  if(hidden) CHECK(presented==0);
  PROCESS_MEMORY_COUNTERS_EX memory{};memory.cb=sizeof(memory);
  DWORD handles=0;CHECK(GetProcessHandleCount(GetCurrentProcess(),&handles));
  CHECK(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory)));
  summary<<scene.id<<','<<phase<<','<<stop-start<<','<<gOperations-initialOperations<<','<<gLogicalCpu<<','
    <<mean<<','<<Quantile(cpu,.95)<<','<<*std::max_element(cpu.begin(),cpu.end())<<','
    <<firstMemory.PrivateUsage<<','<<memory.PrivateUsage<<','<<firstHandles<<','<<handles<<','
    <<firstGdi<<','<<GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS)<<','<<presented<<'\n';
  summary.flush();CHECK(summary.good());
  std::cout<<scene.id<<" "<<phase<<" CPU="<<mean<<"% count="<<gOperations-initialOperations<<std::endl;
  return {scene.id,phase,mean};
}
void RunCpu(const std::filesystem::path& parent,const std::filesystem::path& packs,bool smoke,bool software) {
  CHECK(std::filesystem::is_directory(parent) && std::filesystem::is_directory(packs));
  CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)));
  Gdiplus::GdiplusStartupInput startup;ULONG_PTR gdi=0;
  CHECK(Gdiplus::GdiplusStartup(&gdi,&startup,nullptr)==Gdiplus::Ok);
  SYSTEM_INFO system{};GetSystemInfo(&system);gLogicalCpu=system.dwNumberOfProcessors;CHECK(gLogicalCpu>0);
  {
    Fixture fixture(parent,L"appearance-cpu",true,false);
    CHECK(SetWindowPos(fixture.window,nullptr,60,60,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE));
    gVisibility={};gVisibility.autoHideFullscreen=false;gVisibilityHidden=false;
    gState.dpi=SystemDpi();
    gState.windowWidth=ScaleDip(kWindowDipWidth,gState.dpi);
    gState.windowHeight=ScaleDip(MainWindowDipHeight(),gState.dpi);
    CHECK(SetWindowPos(fixture.window,nullptr,0,0,gState.windowWidth,gState.windowHeight,SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE));
    std::vector<CpuScene> scenes{{"","builtin-woodfish"}};
    std::vector<std::filesystem::path> files;
    for(const auto& e:std::filesystem::directory_iterator(packs)) if(e.path().extension()==L".nmgpack")files.push_back(e.path());
    std::sort(files.begin(),files.end());CHECK(!files.empty());
    std::ofstream inventory(fixture.directory/L"inventory.csv");inventory<<"id,file\n";
    for(const auto& file:files) {
      std::string id;std::wstring error;
      if(!gAppearanceCatalog.Install(file.wstring(),AppearanceDirectory(),&id,&error)) {
        std::wcerr<<L"fixture rejected "<<file.filename().wstring()<<L": "<<error<<L'\n';CHECK(false);
      }
      CHECK(std::none_of(scenes.begin(),scenes.end(),[&](const CpuScene& s){return s.id==id;}));
      scenes.push_back({id,file.filename().string()});inventory<<id<<','<<file.filename().string()<<'\n';
    }
    inventory.close();CHECK(inventory.good());
    if(smoke) scenes.resize(std::min<size_t>(2,scenes.size()));
    fixture.Start(true); // Force local-fallback input; no physical event admission.
    input_runtime::InputCommand consumed;consumed.kind=input_runtime::InputCommandKind::RestoreReminderSegmentConsumed;consumed.enabled=true;CHECK(SendInputCommand(consumed));
    std::ofstream samples(fixture.directory/L"samples.jsonl"),summary(fixture.directory/L"summary.csv");
    CHECK(samples.good()&&summary.good());samples<<std::setprecision(8);summary<<std::setprecision(8);
    summary<<"id,phase,elapsedMs,inputCount,logicalCpu,cpuWholeMachineMeanPercent,cpuWholeMachineP95Percent,cpuWholeMachineMaxPercent,privateBytesFirst,privateBytesLast,handlesFirst,handlesLast,gdiFirst,gdiLast,presents\n";
    const unsigned idle=smoke?2:30,active=smoke?3:60;
    std::vector<CpuStage> activeStages;
    for(const auto& scene:scenes) {
      SelectCpuScene(fixture,scene);
      if(!software) CHECK(!gDisplay.display->Adapter().software && gDisplay.display->Adapter().kind=="hardware");
      gCpuStages.push_back(MeasureCpu(fixture,scene,"idle",idle,false,false,samples,summary));
      const auto result=MeasureCpu(fixture,scene,"active-5hz",active,true,false,samples,summary);
      gCpuStages.push_back(result);activeStages.push_back(result);
    }
    const auto low=std::min_element(activeStages.begin(),activeStages.end(),[](auto& a,auto& b){return a.mean<b.mean;})->id;
    const auto high=std::max_element(activeStages.begin(),activeStages.end(),[](auto& a,auto& b){return a.mean<b.mean;})->id;
    // Reverse the original order for extrema, excluding initialization/warm-up.
    std::vector<CpuScene> repeat;
    for(const auto& scene:scenes)if(scene.id==low||scene.id==high)repeat.push_back(scene);
    std::reverse(repeat.begin(),repeat.end());
    for(const auto& scene:repeat) {SelectCpuScene(fixture,scene);gCpuStages.push_back(MeasureCpu(fixture,scene,"active-repeat",active,true,false,samples,summary));}
    const auto worst=*std::find_if(scenes.begin(),scenes.end(),[&](auto& s){return s.id==high;});
    SelectCpuScene(fixture,worst,true);gCpuStages.push_back(MeasureCpu(fixture,worst,"active-countdown",active,true,false,samples,summary));
    SelectCpuScene(fixture,worst,true,true);gCpuStages.push_back(MeasureCpu(fixture,worst,"hidden-countdown",active,true,true,samples,summary));
    samples.close();summary.close();CHECK(samples.good()&&summary.good());
    fixture.DrainStorage();CHECK(ProfileCount(std::filesystem::path(DataPath()),L"state",L"total")==1000+gOperations);
    std::ofstream result(fixture.directory/L"result.json");
    result<<"{\"status\":\"PASS\",\"smokeOnly\":"<<(smoke?"true":"false")
      <<",\"testedScenes\":"<<scenes.size()<<",\"availableScenes\":"<<files.size()+1
      <<",\"logicalCpu\":"<<gLogicalCpu<<",\"dpi\":"<<gState.dpi<<",\"width\":"<<gState.windowWidth<<",\"height\":"<<gState.windowHeight
      <<",\"adapterKind\":\""<<gDisplay.display->Adapter().kind<<"\",\"vendorId\":"<<gDisplay.display->Adapter().vendorId
      <<",\"deviceId\":"<<gDisplay.display->Adapter().deviceId<<",\"commands\":"<<gOperations
      <<",\"countAndSaveCorrect\":true,\"globalInputInjected\":false,\"realProfileAccessed\":false,\"ordinaryExecutableMeasured\":false,\"physicalTypingLatencyMeasured\":false,\"scope\":\"same-source real production adapter, diagnostic private input; sampler overhead included\"}\n";
    result.close();CHECK(result.good());
    WindowProcedure(fixture.window,WM_CLOSE,0,0);fixture.Await([&]{return !IsWindow(fixture.window);},10000);
    CHECK(gDataStorage.readyToDestroy && gAppearance.service->Snapshot().stopped);
  }
  gDisplay=DisplayAdapter{};gAppearanceCatalog=niuma::AppearanceCatalog{};gRuntimeCandidate=false;
  Gdiplus::GdiplusShutdown(gdi);CoUninitialize();
}
}
int wmain(int argc,wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
  try {
    CHECK(argc>=3&&argc<=5);bool smoke=false,software=false;
    for(int i=3;i<argc;++i) {if(std::wstring(argv[i])==L"--smoke")smoke=true;
      else if(std::wstring(argv[i])==L"--allow-software")software=true;else CHECK(false);}
    CHECK(SetProcessDPIAware());
    HANDLE mutex=CreateMutexW(nullptr,FALSE,L"Local\\NiuMaMeritAppearanceCpuProbe");
    CHECK(mutex&&GetLastError()!=ERROR_ALREADY_EXISTS);
    WNDCLASSW cls{};cls.hInstance=GetModuleHandleW(nullptr);cls.lpfnWndProc=FixtureProcedure;cls.lpszClassName=kFixtureClass;CHECK(RegisterClassW(&cls));
    cls.lpfnWndProc=ReminderWindowProcedure;cls.lpszClassName=kReminderClass;CHECK(RegisterClassW(&cls));
    RunCpu(argv[1],argv[2],smoke,software);CloseHandle(mutex);return 0;
  }catch(const std::exception& e){std::cerr<<"CPU_PROBE_FAILED "<<e.what()<<" Win32="<<GetLastError()<<'\n';return 1;}
}
