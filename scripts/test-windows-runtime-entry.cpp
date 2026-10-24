// Automation-only lifecycle driver for the real isolated application entry.
// No application adapter functions or counting shortcuts are called here.
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void Require(bool okay, const char* message) { if (!okay) throw std::runtime_error(message); }
struct WindowSearch { DWORD pid; HWND main = nullptr; };
BOOL CALLBACK FindOwned(HWND window, LPARAM context) {
  auto& search = *reinterpret_cast<WindowSearch*>(context);
  DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
  if (pid != search.pid) return TRUE;
  wchar_t name[128]{}; GetClassNameW(window,name,128);
  if (wcscmp(name,L"NiuMaMeritWindow.RuntimeCandidate")==0) search.main=window;
  return TRUE;
}
HWND MainWindow(DWORD pid) { WindowSearch search{pid}; EnumWindows(FindOwned,reinterpret_cast<LPARAM>(&search)); return search.main; }
struct Child {
  PROCESS_INFORMATION process{};
  ~Child() {
    if (!process.hProcess) return;
    // Only our exact child, normal close only. Never kill a failed process.
    if (WaitForSingleObject(process.hProcess,0)==WAIT_TIMEOUT) {
      if (auto window=MainWindow(process.dwProcessId)) PostMessageW(window,WM_CLOSE,0,0);
      WaitForSingleObject(process.hProcess,5000);
    }
    CloseHandle(process.hThread);CloseHandle(process.hProcess);
  }
  void Start(const std::filesystem::path& exe,const std::wstring& arguments) {
    auto command=L"\""+exe.wstring()+L"\" "+arguments;
    std::vector<wchar_t> mutableCommand(command.begin(),command.end());mutableCommand.push_back(0);
    STARTUPINFOW startup{};startup.cb=sizeof(startup);
    Require(CreateProcessW(exe.c_str(),mutableCommand.data(),nullptr,nullptr,FALSE,0,nullptr,
        exe.parent_path().c_str(),&startup,&process)!=FALSE,"create owned test process");
  }
  DWORD Wait(DWORD milliseconds) {
    Require(WaitForSingleObject(process.hProcess,milliseconds)==WAIT_OBJECT_0,"owned child did not exit within its deadline");
    DWORD code=0;Require(GetExitCodeProcess(process.hProcess,&code)!=FALSE,"read child exit");return code;
  }
};
std::uint64_t CreatedMs(const Child& child) {
  FILETIME created{},exited{},kernel{},user{};
  Require(GetProcessTimes(child.process.hProcess,&created,&exited,&kernel,&user)!=FALSE,"bind child creation time");
  ULARGE_INTEGER time{};time.LowPart=created.dwLowDateTime;time.HighPart=created.dwHighDateTime;
  return (time.QuadPart-116444736000000000ULL)/10000;
}
int Run(const std::filesystem::path& candidate,const std::filesystem::path& receiver,
        const std::filesystem::path& evidence,unsigned pairs) {
  Require(std::filesystem::is_regular_file(candidate) && std::filesystem::is_regular_file(receiver),"bound executable paths required");
  Require(std::filesystem::is_directory(evidence) && !std::filesystem::exists(evidence/L"entry-result.json"),"new evidence directory required");
  wchar_t temporary[MAX_PATH]{};Require(GetTempPathW(MAX_PATH,temporary)>0,"Temp root");
  const auto profile=std::filesystem::path(temporary)/(L"niuma-entry-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64()));
  Require(CreateDirectoryW(profile.c_str(),nullptr)!=FALSE,"exclusive private Temp profile");
  Require(SetEnvironmentVariableW(L"NIUMA_ACCEPTANCE_ROOT",profile.c_str())!=FALSE,"child private profile environment");
  { Child invalid;invalid.Start(candidate,L"");Require(invalid.Wait(5000)==2,"probe rejects implicit normal profile"); }
  Require(std::filesystem::is_empty(profile),"rejected entry must not write profile");
  { Child invalid;invalid.Start(candidate,L"--runtime-candidate --autostart");Require(invalid.Wait(5000)==2,"probe rejects automatic startup"); }
  Require(std::filesystem::is_empty(profile),"automatic entry must not write profile");
  Child client;client.Start(candidate,L"--runtime-candidate");
  const auto deadline=GetTickCount64()+15000;
  HWND window=nullptr;
  while(!(window=MainWindow(client.process.dwProcessId)) && GetTickCount64()<deadline) {
    Require(WaitForSingleObject(client.process.hProcess,0)==WAIT_TIMEOUT,"candidate exited before main window");Sleep(20);
  }
  Require(window!=nullptr,"private main window ready");
  // Startup is excluded from input timing. Final persisted count witnesses that
  // the ordinary real hook path actually received the receiver's F24 events.
  Sleep(1000);
  const auto inputReport=evidence/L"input-delivery.json";
  Child input;input.Start(receiver,L"\""+inputReport.wstring()+L"\" "+std::to_wstring(pairs)+L" "+std::to_wstring(client.process.dwProcessId));
  {
    std::ofstream live(evidence/L"entry-live.json");
    live<<"{\"clientPid\":"<<client.process.dwProcessId<<",\"clientCreatedUtcUnixMs\":"<<CreatedMs(client)
        <<",\"receiverPid\":"<<input.process.dwProcessId<<",\"receiverCreatedUtcUnixMs\":"<<CreatedMs(input)
        <<",\"privateRoot\":\""<<profile.generic_u8string()<<"\",\"noticeOmittedInSeparateProbe\":true}\n";
    live.close();Require(live.good(),"write live process binding");
  }
  const auto inputExit=input.Wait(pairs*100+30000);
  Require(PostMessageW(window,WM_CLOSE,0,0)!=FALSE,"normal close of exact child window");
  const auto clientExit=client.Wait(15000);
  wchar_t total[64]{};
  const auto data=profile/L"data.ini";
  GetPrivateProfileStringW(L"state",L"total",L"missing",total,64,data.c_str());
  Require(std::filesystem::is_regular_file(profile/L"runtime-candidate.owner"),"path-bound candidate marker retained");
  std::ofstream report(evidence/L"entry-result.json");
  const bool okay=inputExit==0 && clientExit==0 && std::wstring(total)==std::to_wstring(pairs);
  report<<"{\"executionComplete\":"<<(okay?"true":"false")<<",\"inputExitCode\":"<<inputExit
      <<",\"clientExitCode\":"<<clientExit<<",\"expectedCount\":"<<pairs<<",\"savedCount\":\"";
  for(const auto* p=total;*p;++p) report<<static_cast<char>(*p);
  report<<"\",\"privateRoot\":\""<<profile.generic_u8string()<<"\",\"realEntryUsed\":true,"
      "\"ordinaryNoticeOmittedInSeparateProbe\":true,\"physicalTypingMeasured\":false,\"normalDeveloperCandidateChanged\":false}\n";
  report.close();Require(report.good(),"write terminal report");
  Require(okay,"delivery or actual hook persistence did not match");
  std::cout<<"PASS private full-entry lifecycle: rejected unsafe entries, independent receiver delivered "<<pairs
      <<" inputs, actual hooks persisted the exact count, normal exit\n";
  return 0;
}
}
int wmain(int argc,wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);
  try {
    Require(argc==4 || argc==5,"usage: entry-check absolute-probe absolute-receiver evidence [pairs]");
    const auto pairs=argc==5?std::stoul(argv[4]):30;
    Require(pairs>=20 && pairs<=600,"pairs outside test bound");
    return Run(std::filesystem::absolute(argv[1]),std::filesystem::absolute(argv[2]),std::filesystem::absolute(argv[3]),static_cast<unsigned>(pairs));
  }catch(const std::exception& error){std::cerr<<"FAIL full entry: "<<error.what()<<'\n';return 1;}
}
