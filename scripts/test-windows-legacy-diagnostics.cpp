#include "../src/windows/runtime/legacy_diagnostics.h"
#include "../src/windows/runtime/appearance_scene.h"
#include "../src/windows/runtime/client_display.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include <cassert>
namespace niuma::windows::runtime { bool DiagnosticDecodeForTest(unsigned); }
namespace diag=niuma::legacy_diag;
static std::filesystem::path Fresh(const std::filesystem::path& root,unsigned index) {
  auto p=root/std::to_wstring(index); assert(std::filesystem::create_directory(p));
  std::lock_guard<std::mutex> lock(diag::mutex);
  diag::count=0;diag::keys={};diag::pending=0;diag::directory.clear();diag::forcedStage.clear();
  return p;
}
static std::string Log(const std::filesystem::path& p) {
  std::ifstream f(p/L"legacy-diagnostics"/L"failures.jsonl");
  return std::string(std::istreambuf_iterator<char>(f),{});
}
int wmain(int argc,wchar_t** argv) {
  assert(argc==2);
  const auto root=std::filesystem::absolute(argv[1]);
  assert(std::filesystem::create_directory(root));
  assert(SUCCEEDED(CoInitializeEx(nullptr,COINIT_MULTITHREADED)));
  unsigned caseIndex=0,cases=0;
  const std::vector<std::string> stages={"CoCreateInstance","CreateStream","InitializeFromMemory",
    "CreateDecoderFromStream","GetContainerFormat","PNG format","GetFrameCount","Single frame",
    "GetFrame","GetSize","Image dimensions","Pixel byte budget","CreateFormatConverter","Initialize","CopyPixels"};
  for(unsigned id:{101u,102u}) {
    auto clean=Fresh(root,++caseIndex); assert(diag::Configure(clean.wstring()));
    assert(niuma::windows::runtime::DiagnosticDecodeForTest(id)); assert(Log(clean).empty());
    ++cases;
    for(const auto& stage:stages) {
      auto p=Fresh(root,++caseIndex); assert(diag::Configure(p.wstring()));diag::forcedStage=stage;
      assert(!niuma::windows::runtime::DiagnosticDecodeForTest(id));
      const auto log=Log(p);assert(log.find("\"stage\":\""+stage+"\"")!=std::string::npos);
      assert(log.find("\"resourceId\":"+std::to_string(id))!=std::string::npos);
      assert(log.find("\"requestedClsid\":\"00000000-")==std::string::npos);
      assert(log.size()<2048 && diag::count==1);++cases;
    }
  }
  for(unsigned id:{101u,102u}) for(const char* stage:{"FindResourceW","LoadResource","SizeofResource","LockResource","Resource byte budget"}) {
    auto q=Fresh(root,++caseIndex);assert(diag::Configure(q.wstring()));diag::forcedStage=stage;
    assert(!niuma::windows::runtime::DiagnosticDecodeForTest(id));
    assert(Log(q).find(std::string("\"stage\":\"")+stage+"\"")!=std::string::npos);++cases;
  }
  auto missing=Fresh(root,++caseIndex);assert(diag::Configure(missing.wstring()));
  assert(!niuma::windows::runtime::DiagnosticDecodeForTest(999));
  assert(Log(missing).find("FindResourceW")!=std::string::npos);++cases;
  auto bounded=Fresh(root,++caseIndex);assert(diag::Configure(bounded.wstring()));
  const auto first=diag::Failure("test","one",E_FAIL);
  for(int i=0;i<100;++i) assert(diag::Failure("test","one",E_FAIL)==first);
  assert(diag::count==1);
  assert(diag::TakeNotice()==first && diag::TakeNotice()==0);
  for(int i=0;i<100;++i) diag::Failure("test",("unique"+std::to_string(i)).c_str(),E_FAIL);
  assert(diag::count==32 && Log(bounded).size()<=65536);++cases;
  auto cap=Fresh(root,++caseIndex);assert(diag::Configure(cap.wstring()));
  {std::ofstream f(cap/L"legacy-diagnostics"/L"failures.jsonl");f<<std::string(65536,'x');}
  assert(diag::Failure("test","over-cap",E_FAIL)==0 && Log(cap).size()==65536);++cases;
  auto redacted=Fresh(root,++caseIndex);assert(diag::Configure(redacted.wstring()));
  SetLastError(1234);diag::Failure("test","safe",E_FAIL,{},"quote\" slash/ back\\\n");
  assert(GetLastError()==1234);assert(Log(redacted).find("quote_ slash_ back__")!=std::string::npos);++cases;
  auto display=Fresh(root,++caseIndex);assert(diag::Configure(display.wstring()));
  niuma::windows::runtime::ClientDisplay invalidWindow;
  assert(!invalidWindow.Initialize(nullptr,240,250));
  assert(invalidWindow.DiagnosticLastError()==E_INVALIDARG);
  diag::Failure("display","Initialize",invalidWindow.DiagnosticLastError(),{},invalidWindow.LastErrorMessage().c_str());
  assert(Log(display).find("0x80070057")!=std::string::npos);++cases;
  niuma::windows::runtime::ClientDisplay invalidScene;
  std::unique_ptr<niuma::windows::runtime::PreparedAppearanceScene> none;
  assert(!invalidScene.SetScene(none));
  diag::Failure("display","SetScene",invalidScene.DiagnosticLastError(),{},invalidScene.LastErrorMessage().c_str(),true);
  assert(Log(display).find("\"kind\":\"check\"")!=std::string::npos);++cases;
  CoUninitialize();
  std::cout<<"{\"status\":\"PASS\",\"cases\":"<<cases
    <<",\"actualWicResourceDecode\":true,\"failureInjectionTestOnly\":true,\"maxRecords\":32,\"maxBytes\":65536,\"globalInputInjected\":false}\n";
}

