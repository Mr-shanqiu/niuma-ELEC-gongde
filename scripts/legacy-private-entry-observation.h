#pragma once
// Injected only into an archived, hash-checked e566 source copy by the fixed
// preparation script. Never included by the current or formal client.
std::uint64_t gLegacyEntryFrames=0,gLegacyEntrySubmitFailures=0;
bool PrepareLegacyEntryScenario() {
  if(!gIsolatedAcceptance) return false;
  const auto marker=gAcceptanceRoot+L"\\runtime-candidate.owner";
  FILE* owner=_wfopen(marker.c_str(),L"wb");
  if(!owner) return false;
  std::fputs("NIUMA_LEGACY_PRIVATE_ENTRY_ONLY\n",owner);
  if(std::fclose(owner)!=0) return false;
  wchar_t mode[32]{};const DWORD length=GetEnvironmentVariableW(L"NIUMA_ENTRY_SCENE",mode,32);
  if(!length) return true;
  if(length>=32 || wcscmp(mode,L"offwork")!=0) return false;
  wchar_t directory[MAX_PATH]{};const DWORD size=GetEnvironmentVariableW(L"NIUMA_RUNTIME_FIXTURE_DIR",directory,MAX_PATH);
  if(!size || size>=MAX_PATH) return false;
  std::string id;std::wstring error;
  if(!gAppearanceCatalog.Install((std::filesystem::path(directory)/L"offwork-button.nmgpack").wstring(),
      AppearanceDirectory(),&id,&error) || id!="runtime.fixture.offwork-button") return false;
  const auto data=DataPath();
  if(!WritePrivateProfileStringW(L"state",L"selected_pack_id",L"runtime.fixture.offwork-button",data.c_str()) ||
      !WritePrivateProfileStringW(L"state",L"total",L"0",data.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"enabled",L"1",data.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"hour",L"18",data.c_str()) ||
      !WritePrivateProfileStringW(L"offwork",L"minute",L"0",data.c_str())) return false;
  WritePrivateProfileStringW(nullptr,nullptr,nullptr,data.c_str());
  return GetFileAttributesW(data.c_str())!=INVALID_FILE_ATTRIBUTES;
}
void WriteLegacyEntryObservation(bool terminal=false) {
  if(!gIsolatedAcceptance || !gLegacyEntryFrames || !gState.keyboardHook) return;
  const auto* pack=gState.selectedPackId.empty()?nullptr:gAppearanceCatalog.Find(gState.selectedPackId);
  const auto id=pack?pack->id:std::string("builtin.woodfish");
  if(id!="runtime.fixture.offwork-button" && id!="builtin.woodfish") return;
  const auto path=gAcceptanceRoot+(terminal?L"\\runtime-entry-display.json":L"\\runtime-entry-ready.json");
  FILE* file=_wfopen(path.c_str(),L"wb");if(!file)return;
  std::fprintf(file,"{\"scene\":\"%s\",\"dpi\":%u,\"countdown\":%s,\"framesPresented\":%llu,"
      "\"nativeSubmitFailures\":%llu,\"keyboardAvailable\":true,\"total\":%llu,"
      "\"adapterKind\":\"legacy-gdi\",\"vendorId\":null,\"deviceId\":null,\"privateLegacyHarness\":true}\n",
      id.c_str(),gState.dpi,gOffwork.enabled?"true":"false",static_cast<unsigned long long>(gLegacyEntryFrames),
      static_cast<unsigned long long>(gLegacyEntrySubmitFailures),static_cast<unsigned long long>(gState.total));
  std::fclose(file);
}
