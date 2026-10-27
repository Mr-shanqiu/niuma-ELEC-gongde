#pragma once
// Enabled only in the separate legacy diagnostic build. No frame/input logging.
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
#include <windows.h>
#include <array>
#include <atomic>
#include <mutex>
#include <string>
#include <cstdio>
#include <cstdint>
namespace niuma::legacy_diag {
struct Context {
  unsigned resource = 0, width = 0, height = 0, frames = 0;
  std::uint64_t budget = 0;
  GUID format{}, clsid{};
  unsigned vendorId=0,deviceId=0,featureLevel=0;
};
inline std::mutex mutex;
inline std::wstring directory;
inline std::array<std::string,32> keys;
inline unsigned count = 0;
inline std::atomic<unsigned> pending{0};
#if defined(NIUMA_LEGACY_DIAGNOSTICS_TEST)
inline std::string forcedStage;
#endif
inline std::string Safe(const char* text) {
  std::string out;
  if(text) for(; *text && out.size()<160; ++text) {
    const unsigned char c=static_cast<unsigned char>(*text);
    out += (c>=32 && c<=126 && c!='"' && c!='\\' && c!='/') ? char(c) : '_';
  }
  return out;
}
inline std::string Guid(const GUID& g) {
  char b[40]{};
  std::snprintf(b,sizeof(b),"%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X",
    static_cast<unsigned long>(g.Data1),unsigned(g.Data2),unsigned(g.Data3),
    unsigned(g.Data4[0]),unsigned(g.Data4[1]),unsigned(g.Data4[2]),unsigned(g.Data4[3]),
    unsigned(g.Data4[4]),unsigned(g.Data4[5]),unsigned(g.Data4[6]),unsigned(g.Data4[7]));
  return b;
}
inline bool Configure(const std::wstring& privateRoot) {
  const DWORD saved=GetLastError();
  std::lock_guard<std::mutex> lock(mutex);
  directory=privateRoot+L"\\legacy-diagnostics";
  const DWORD attrs=GetFileAttributesW(directory.c_str());
  bool okay=attrs==INVALID_FILE_ATTRIBUTES ? CreateDirectoryW(directory.c_str(),nullptr)!=FALSE :
      (attrs&FILE_ATTRIBUTE_DIRECTORY) && !(attrs&FILE_ATTRIBUTE_REPARSE_POINT);
  if(!okay) directory.clear();
  SetLastError(saved); return okay;
}
inline unsigned Failure(const char* scope,const char* stage,HRESULT hr,
                        const Context& c={},const char* detail="",bool check=false) {
  const DWORD saved=GetLastError();
  std::lock_guard<std::mutex> lock(mutex);
  const auto a=Safe(scope),b=Safe(stage),d=Safe(detail);
  const auto key=a+":"+std::to_string(c.resource)+":"+b+":"+std::to_string(static_cast<unsigned long>(hr));
  for(unsigned i=0;i<count;++i) if(keys[i]==key) {pending=i+1;SetLastError(saved);return i+1;}
  if(directory.empty() || count>=keys.size()) {SetLastError(saved);return 0;}
  const std::wstring path=directory+L"\\failures.jsonl";
  const DWORD attrs=GetFileAttributesW(path.c_str());
  if(attrs!=INVALID_FILE_ATTRIBUTES && (attrs&FILE_ATTRIBUTE_REPARSE_POINT)) {SetLastError(saved);return 0;}
  HANDLE file=CreateFileW(path.c_str(),GENERIC_READ|FILE_APPEND_DATA,FILE_SHARE_READ,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE) {SetLastError(saved);return 0;}
  LARGE_INTEGER size{};char line[2048]{};
  const unsigned id=count+1;
  const int n=std::snprintf(line,sizeof(line),
    "{\"id\":%u,\"pid\":%lu,\"tickMs\":%llu,\"scope\":\"%s\",\"stage\":\"%s\",\"kind\":\"%s\",\"hr\":\"0x%08lX\",\"resourceId\":%u,\"width\":%u,\"height\":%u,\"frames\":%u,\"remainingBytes\":%llu,\"format\":\"%s\",\"requestedClsid\":\"%s\",\"vendorId\":%u,\"deviceId\":%u,\"featureLevel\":%u,\"detail\":\"%s\"}\n",
    id,static_cast<unsigned long>(GetCurrentProcessId()),static_cast<unsigned long long>(GetTickCount64()),
    a.c_str(),b.c_str(),check?"check":"hresult",static_cast<unsigned long>(hr),c.resource,c.width,c.height,c.frames,
    static_cast<unsigned long long>(c.budget),Guid(c.format).c_str(),Guid(c.clsid).c_str(),c.vendorId,c.deviceId,c.featureLevel,d.c_str());
  DWORD written=0;
  const bool okay=n>0 && n<int(sizeof(line)) && GetFileSizeEx(file,&size) && size.QuadPart+n<=65536 &&
    WriteFile(file,line,static_cast<DWORD>(n),&written,nullptr) && written==static_cast<DWORD>(n);
  CloseHandle(file);
  if(okay) {keys[count++]=key;pending=id;}
  SetLastError(saved);return okay?id:0;
}
inline bool Hr(const Context& c,const char* stage,HRESULT hr) {
#if defined(NIUMA_LEGACY_DIAGNOSTICS_TEST)
  if(forcedStage==stage) hr=E_ACCESSDENIED;
#endif
  if(SUCCEEDED(hr)) return true;
  Failure("wic",stage,hr,c);return false;
}
inline bool Check(const Context& c,const char* stage,bool okay) {
#if defined(NIUMA_LEGACY_DIAGNOSTICS_TEST)
  if(forcedStage==stage) okay=false;
#endif
  if(okay) return true;
  Failure("wic",stage,E_INVALIDARG,c,"validation failure, not an API HRESULT",true);return false;
}
inline unsigned TakeNotice() {return pending.exchange(0);}
} // namespace niuma::legacy_diag
#endif

