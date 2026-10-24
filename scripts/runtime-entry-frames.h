#pragma once
// Included inside app namespace, only by the private complete-entry probe.
// One fixed buffer, no GPU query/readback, per-frame IO, polling, or input data.
#if !defined(NIUMA_RUNTIME_ENTRY_PROBE)
#error Frame observations are private-probe only
#endif
#if defined(NIUMA_INPUT_SERVICE_DIAGNOSTICS)
#error Complete-entry timing must not enable the input-service diagnostic adapter
#endif
struct RuntimeEntryFrame {
  std::uint64_t serial = 0, relativeMs = 0;
  double wallMs = 0, workMs = 0, presentMs = 0, readbackMs = 0;
  double drawMs = 0, regionMs = 0, installMs = 0;
  niuma::runtime::PreparedAlphaRegionStats region;
  input_runtime::ClientDisplayFrameTiming display;
};
struct RuntimeEntryFrames {
  std::array<RuntimeEntryFrame, 8192> samples{};
  std::size_t count = 0;
  std::uint64_t overflow = 0, startedMs = 0, stoppedMs = 0;
  std::uint64_t startFrames = 0, endFrames = 0, startCpu = 0, endCpu = 0;
  bool started = false, active = false, stopped = false, cpuValid = false;
  bool identityValid = true;
  unsigned dpi = 0;
  int width = 0, height = 0;
  std::string scene, fingerprint, adapter;
  unsigned vendor = 0, device = 0;
} gRuntimeEntryFrames;

bool EntryThreadCpu(std::uint64_t& result) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if(!GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user)) return false;
  ULARGE_INTEGER k{}, u{};
  k.LowPart=kernel.dwLowDateTime; k.HighPart=kernel.dwHighDateTime;
  u.LowPart=user.dwLowDateTime; u.HighPart=user.dwHighDateTime;
  result=k.QuadPart+u.QuadPart;
  return true;
}
bool StartRuntimeEntryFrames() {
  auto& f=gRuntimeEntryFrames;
  if(f.started || !IsRuntimeCandidate() || !gIsolatedAcceptance || !gRuntimeEntryReady ||
      !gDisplay.display || !gDisplay.display->scene() || gDataStorage.closing || gDisplay.failed) return false;
  auto& display=*gDisplay.display;
  display.EnableDiagnosticFrameTiming(true);
  f.scene=display.scene()->source.id;
  f.fingerprint=display.scene()->source.contentFingerprint;
  f.adapter=display.Adapter().kind;
  f.vendor=display.Adapter().vendorId; f.device=display.Adapter().deviceId;
  f.dpi=gState.dpi; f.width=gState.windowWidth; f.height=gState.windowHeight;
  f.startFrames=display.Stats().framesPresented;
  f.cpuValid=EntryThreadCpu(f.startCpu);
  f.startedMs=GetTickCount64(); f.started=true; f.active=true;
  return true;
}
bool StopRuntimeEntryFrames() {
  auto& f=gRuntimeEntryFrames;
  if(!f.active) return false;
  f.active=false; f.stopped=true; f.stoppedMs=GetTickCount64();
  f.cpuValid=EntryThreadCpu(f.endCpu) && f.cpuValid && f.endCpu>=f.startCpu;
  if(gDisplay.display) {
    f.endFrames=gDisplay.display->Stats().framesPresented;
    gDisplay.display->EnableDiagnosticFrameTiming(false);
  }
  return true;
}
void CaptureRuntimeEntryFrame(std::chrono::steady_clock::time_point started, std::uint64_t before) {
  auto& f=gRuntimeEntryFrames;
  if(!f.active || !gDisplay.display) return;
  const auto& display=*gDisplay.display;
  const auto& s=display.Stats();
  if(s.framesPresented==before) return; // Unchanged display calls are not frames.
  const double wall=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
  f.identityValid=f.identityValid && display.scene() && display.scene()->source.id==f.scene &&
      display.scene()->source.contentFingerprint==f.fingerprint && display.Adapter().kind==f.adapter &&
      display.Adapter().vendorId==f.vendor && display.Adapter().deviceId==f.device &&
      gState.dpi==f.dpi && gState.windowWidth==f.width && gState.windowHeight==f.height;
  if(f.count==f.samples.size()) { ++f.overflow; return; }
  auto& sample=f.samples[f.count++];
  sample.serial=s.framesPresented; sample.relativeMs=GetTickCount64()-f.startedMs;
  sample.wallMs=wall; sample.presentMs=s.lastPresentWallMs; sample.readbackMs=s.lastReadbackWallMs;
  sample.workMs=wall-sample.presentMs-sample.readbackMs; // Preserve invalid negatives, never clamp them.
  sample.drawMs=s.lastDrawSubmitWallMs; sample.regionMs=s.lastRegionMs;
  sample.installMs=s.lastRegionInstallWallMs; sample.region=s.lastRegionDetails;
  sample.display=display.DiagnosticFrameTiming();
}
void WriteRuntimeEntryFrames() {
  const auto& f=gRuntimeEntryFrames;
  if(!f.started) return;
  FILE* file=_wfopen((gAcceptanceRoot+L"\\runtime-entry-frames.json").c_str(),L"wb");
  if(!file) return; // Driver requires a complete final JSON; failure is not success.
  const bool healthy=!gDisplay.failed && f.identityValid && f.stopped && !f.overflow &&
      f.count>0 && f.endFrames>=f.startFrames && f.endFrames-f.startFrames==f.count;
  std::fprintf(file,"{\"schema\":2,\"captureComplete\":%s,\"capacity\":%zu,\"bufferBytes\":%zu,"
      "\"samplesCount\":%zu,\"overflow\":%llu,\"identityValid\":%s,\"scene\":\"%s\",\"fingerprint\":\"%s\","
      "\"dpi\":%u,\"width\":%d,\"height\":%d,\"adapterKind\":\"%s\",\"vendorId\":%u,\"deviceId\":%u,"
      "\"startedMonotonicMs\":%llu,\"stoppedMonotonicMs\":%llu,\"startFramesPresented\":%llu,\"endFramesPresented\":%llu,"
      "\"gpuQueriesEnabled\":false,\"readbackRequested\":false,\"inputServiceDiagnostics\":false,"
      "\"timingMeaning\":\"CPU-side elapsed calls; work excludes Present and readback, not CPU execution or physical display latency\","
      "\"uiThreadCpuMs\":",
      healthy?"true":"false",f.samples.size(),sizeof(f.samples),f.count,
      static_cast<unsigned long long>(f.overflow),f.identityValid?"true":"false",f.scene.c_str(),f.fingerprint.c_str(),
      f.dpi,f.width,f.height,f.adapter.c_str(),f.vendor,f.device,
      static_cast<unsigned long long>(f.startedMs),static_cast<unsigned long long>(f.stoppedMs),
      static_cast<unsigned long long>(f.startFrames),static_cast<unsigned long long>(f.endFrames));
  if(f.cpuValid) std::fprintf(file,"%.6f",(f.endCpu-f.startCpu)/10000.0); else std::fprintf(file,"null");
  std::fprintf(file,",\"fields\":[\"serial\",\"relativeMs\",\"wallMs\",\"workMs\",\"presentMs\",\"readbackMs\","
      "\"drawMs\",\"regionMs\",\"mathMs\",\"supportAllMs\",\"supportStrongMs\",\"weakResolveMs\","
      "\"serializeMs\",\"nativeCreateMs\",\"installMs\",\"reuseComparisonMs\",\"nativeRegionReused\","
      "\"sceneMs\",\"textMs\",\"texturesMs\",\"assemblyMs\",\"presenterMs\",\"textChangedMask\","
      "\"meritBuildMs\",\"meritRasterMs\",\"meritMaskMs\",\"plusBuildMs\",\"plusRasterMs\",\"plusMaskMs\","
      "\"clockBuildMs\",\"clockRasterMs\",\"clockMaskMs\"],\"samples\":[");
  for(std::size_t i=0;i<f.count;++i) {
    const auto& v=f.samples[i]; const auto& r=v.region;
    std::fprintf(file,"%s[%llu,%llu,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%s",
        i?",":"",static_cast<unsigned long long>(v.serial),static_cast<unsigned long long>(v.relativeMs),
        v.wallMs,v.workMs,v.presentMs,v.readbackMs,v.drawMs,v.regionMs,r.mathMs,r.supportAllMs,r.supportStrongMs,
        r.weakResolveMs,r.serializeMs,r.nativeCreateMs,v.installMs,r.reuseComparisonMs,r.nativeRegionReused?"true":"false");
    const auto& d=v.display; const auto& t=d.text;
    std::fprintf(file,",%.6f,%.6f,%.6f,%.6f,%.6f,%u,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f,%.6f]",
        d.sceneMs,d.textMs,d.texturesMs,d.assemblyMs,d.presenterMs,static_cast<unsigned>(t.changedMask),
        t.buildMs[0],t.rasterMs[0],t.maskMs[0],t.buildMs[1],t.rasterMs[1],t.maskMs[1],
        t.buildMs[2],t.rasterMs[2],t.maskMs[2]);
  }
  std::fprintf(file,"]}\n");
  std::fclose(file);
}
