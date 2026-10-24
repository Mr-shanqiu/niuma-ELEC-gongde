#pragma once
// Included inside the application's namespace, only in the private entry probe.
// No sampling loop or historical frame storage is added to the runtime.
#if !defined(NIUMA_RUNTIME_ENTRY_PROBE)
#error Entry observations are private-probe only
#endif

bool PrepareRuntimeEntryScenario() {
  wchar_t mode[32]{};
  const DWORD length=GetEnvironmentVariableW(L"NIUMA_ENTRY_SCENE",mode,32);
  if(!length) return true;
  if(length>=32 || wcscmp(mode,L"offwork")!=0 || !IsRuntimeCandidate() ||
      !gIsolatedAcceptance || GetFileAttributesW(DataPath().c_str())!=INVALID_FILE_ATTRIBUTES) return false;
  wchar_t directory[MAX_PATH]{};
  const DWORD count=GetEnvironmentVariableW(L"NIUMA_RUNTIME_FIXTURE_DIR",directory,MAX_PATH);
  if(!count || count>=MAX_PATH) return false;
  std::string id;std::wstring error;
  // Use the normal validator and installer, after COM/GDI+ initialization and
  // before the profile is handed to the storage worker.
  if(!gAppearanceCatalog.Install((std::filesystem::path(directory)/L"offwork-button.nmgpack").wstring(),
      AppearanceDirectory(),&id,&error) || id!="runtime.fixture.offwork-button") return false;
  const auto path=DataPath();
  if(!WritePrivateProfileStringW(L"state",L"selected_pack_id",L"runtime.fixture.offwork-button",path.c_str()) ||
      !WritePrivateProfileStringW(L"state",L"total",L"0",path.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"enabled",L"1",path.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"hour",L"18",path.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"minute",L"0",path.c_str())) return false;
  return WritePrivateProfileStringW(nullptr,nullptr,nullptr,path.c_str())!=FALSE;
}

void WriteRuntimeEntryObservation(bool terminal=false) {
  static bool readyWritten=false;
  if(!IsRuntimeCandidate() || (!terminal && readyWritten) || !gDisplay.display ||
      !gDisplay.display->scene() || !gDisplay.display->Stats().framesPresented) return;
  if(!terminal && (!gInput.authoritative || !gInput.latest.input.ready ||
      !gInput.latest.input.keyboardAvailable)) return;
  const auto& display=*gDisplay.display;
  const auto& source=display.scene()->source;
  // Package IDs and content fingerprints have already passed the ordinary
  // package validator; observation accepts only this known fixture or builtin.
  if(source.id!="runtime.fixture.offwork-button" && source.id!="builtin.woodfish") return;
  wchar_t scenario[32]{};
  GetEnvironmentVariableW(L"NIUMA_ENTRY_SCENE",scenario,32);
  if(wcscmp(scenario,L"offwork")==0 && source.id!="runtime.fixture.offwork-button") return;
  const auto filename=gAcceptanceRoot+(terminal?L"\\runtime-entry-display.json":L"\\runtime-entry-ready.json");
  FILE* file=_wfopen(filename.c_str(),L"wb");
  if(!file) return;
  const auto& stats=display.Stats();
  const int written=std::fprintf(file,
      "{\"scene\":\"%s\",\"fingerprint\":\"%s\",\"dpi\":%u,\"countdown\":%s,"
      "\"framesPresented\":%llu,\"textureUploads\":%llu,\"adapterKind\":\"%s\","
      "\"vendorId\":%u,\"deviceId\":%u,\"keyboardAvailable\":%s,\"total\":%llu}\n",
      source.id.c_str(),source.contentFingerprint.c_str(),gState.dpi,gOffwork.enabled?"true":"false",
      static_cast<unsigned long long>(stats.framesPresented),static_cast<unsigned long long>(stats.textureUploads),
      display.Adapter().kind.c_str(),display.Adapter().vendorId,display.Adapter().deviceId,
      gInput.latest.input.keyboardAvailable?"true":"false",static_cast<unsigned long long>(gState.total));
  const int closed=std::fclose(file);
  if(!terminal && written>0 && closed==0) readyWritten=true;
}
