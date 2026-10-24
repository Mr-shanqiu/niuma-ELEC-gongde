#include "../src/windows/self_install.h"
#include <shobjidl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <future>

namespace fs = std::filesystem;
namespace setup = niuma::installation;
using namespace std::string_literals;
#define CHECK(x) do { if (!(x)) throw std::runtime_error("line " + std::to_string(__LINE__) + ": " #x); } while(false)
void Put(const fs::path& path, const std::string& value) {
  std::ofstream stream(path, std::ios::binary | std::ios::trunc); stream << value;
  CHECK(stream.good());
}
std::string Get(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary); CHECK(stream.good());
  return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void RegText(const std::wstring& key, const wchar_t* name, const std::wstring& value) {
  HKEY handle = nullptr;
  CHECK(RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_SET_VALUE,
      nullptr, &handle, nullptr) == ERROR_SUCCESS);
  CHECK(RegSetValueExW(handle, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
      static_cast<DWORD>((value.size()+1)*sizeof(wchar_t))) == ERROR_SUCCESS);
  RegCloseKey(handle);
}
std::wstring RegText(const std::wstring& key, const wchar_t* name) {
  wchar_t value[4096]{}; DWORD bytes = sizeof(value);
  const auto status = RegGetValueW(HKEY_CURRENT_USER,key.c_str(),name,RRF_RT_REG_SZ,
      nullptr,value,&bytes);
  return status == ERROR_SUCCESS ? value : L"";
}
std::wstring Link(const fs::path& path, const std::wstring* set = nullptr) {
  IShellLinkW* link = nullptr; IPersistFile* file = nullptr;
  CHECK(SUCCEEDED(CoCreateInstance(CLSID_ShellLink,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&link))));
  CHECK(SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file))));
  wchar_t target[MAX_PATH]{};
  if (set) {
    CHECK(SUCCEEDED(link->SetPath(set->c_str())));
    CHECK(SUCCEEDED(file->Save(path.c_str(),TRUE)));
  } else {
    CHECK(SUCCEEDED(file->Load(path.c_str(),STGM_READ)));
    CHECK(SUCCEEDED(link->GetPath(target,MAX_PATH,nullptr,SLGP_RAWPATH)));
  }
  file->Release(); link->Release(); return target;
}
bool SameFile(const std::wstring& left,const std::wstring& right) {
  HANDLE a=CreateFileW(left.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
      nullptr,OPEN_EXISTING,0,nullptr);
  HANDLE b=CreateFileW(right.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
      nullptr,OPEN_EXISTING,0,nullptr);
  BY_HANDLE_FILE_INFORMATION x{},y{};
  const bool ok=a!=INVALID_HANDLE_VALUE && b!=INVALID_HANDLE_VALUE && GetFileInformationByHandle(a,&x) &&
      GetFileInformationByHandle(b,&y) && x.dwVolumeSerialNumber==y.dwVolumeSerialNumber &&
      x.nFileIndexHigh==y.nFileIndexHigh && x.nFileIndexLow==y.nFileIndexLow;
  if(a!=INVALID_HANDLE_VALUE)CloseHandle(a);if(b!=INVALID_HANDLE_VALUE)CloseHandle(b);return ok;
}
int wmain() {
  fs::path root; std::wstring registryRoot;
  try {
    CHECK(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)));
    GUID guid{}; CHECK(SUCCEEDED(CoCreateGuid(&guid))); wchar_t id[40]{}; StringFromGUID2(guid,id,40);
    wchar_t temporary[MAX_PATH]{}; CHECK(GetTempPathW(MAX_PATH,temporary));
    root = fs::path(temporary)/(std::wstring(L"niuma-self-install-test-")+id);
    CHECK(fs::create_directory(root));
    registryRoot=std::wstring(L"Software\\NiuMaMeritSelfInstallTests\\")+id;
    setup::Locations locations{(root/L"app").wstring(),(root/L"desktop.lnk").wstring(),
        (root/L"start.lnk").wstring(),registryRoot+L"\\Run",registryRoot+L"\\Classes",
        registryRoot+L"\\Uninstall",std::wstring(L"Local\\NiuMaSetupTest.client.")+id,
        std::wstring(L"Local\\NiuMaSetupTest.setup.")+id};
    const auto source=root/L"download.exe", newer=root/L"new-download.exe";
    // Bytes beyond the image body must survive too: installer never repacks or
    // patches a certificate table. This is byte preservation, not signing proof.
    Put(source,"MZ-fixture-image\0trailer-and-certificate-bytes"s);
    Put(newer,"MZ-new-fixture-image\0different-trailer"s);
    const auto data=root/L"user-data.ini"; Put(data,"total=12345\nkeep=user records\n");
    auto result=setup::Install(locations,source.wstring(),L"0.9.5",{true,true});
    CHECK(result.success); CHECK(setup::FilesEqual(source.wstring(),setup::Executable(locations)));
    CHECK(SameFile(Link(locations.desktopLink),setup::Executable(locations)));
    CHECK(SameFile(Link(locations.startMenuLink),setup::Executable(locations)));
    CHECK(RegText(locations.uninstallKey,L"DisplayVersion")==L"0.9.5");
    CHECK(RegText(locations.uninstallKey,L"UninstallString")==L"\""+setup::Executable(locations)+L"\" --uninstall");
    CHECK(Get(data)=="total=12345\nkeep=user records\n");
    std::cout<<"PASS exact single-file install, shortcuts, per-user registration and untouched data\n";

    const auto installed=setup::Executable(locations);
    HANDLE locked=CreateFileW(installed.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr);
    CHECK(locked!=INVALID_HANDLE_VALUE);
    result=setup::Install(locations,newer.wstring(),L"0.9.6",{});
    CloseHandle(locked);
    CHECK(!result.success && setup::FilesEqual(source.wstring(),installed));
    CHECK(RegText(locations.uninstallKey,L"DisplayVersion")==L"0.9.5");
    std::cout<<"PASS image in use fails without overwriting the old client\n";

    const auto oldDesktop=Get(locations.desktopLink),oldStart=Get(locations.startMenuLink);
    const auto oldRun=RegText(locations.runKey,L"NiuMaMerit");
    auto failing=locations; failing.uninstallKey+=L"\\"+std::wstring(300,L'x');
    result=setup::Install(failing,newer.wstring(),L"0.9.6",{true,true});
    CHECK(!result.success && setup::FilesEqual(source.wstring(),installed));
    CHECK(Get(locations.desktopLink)==oldDesktop && Get(locations.startMenuLink)==oldStart);
    CHECK(RegText(locations.runKey,L"NiuMaMerit")==oldRun);
    CHECK(RegText(locations.uninstallKey,L"DisplayVersion")==L"0.9.5");
    for(const auto& file:fs::directory_iterator(locations.directory))
      CHECK(file.path().filename().wstring().find(L".install-")!=0 && file.path().filename().wstring().find(L".previous-")!=0);
    std::cout<<"PASS real late registry failure rolls back image, shortcuts and registrations\n";

    CHECK(!setup::Remove(locations,newer.wstring()).success);
    CHECK(fs::exists(installed) && fs::exists(locations.startMenuLink));
    std::cout<<"PASS mismatched uninstall identity removes nothing\n";

    std::promise<void> ready,finish; auto done=finish.get_future();
    std::thread owner([&]{HANDLE held=CreateMutexW(nullptr,TRUE,locations.applicationMutex.c_str());
      ready.set_value(); done.wait(); ReleaseMutex(held); CloseHandle(held);});
    ready.get_future().wait();
    result=setup::Install(locations,newer.wstring(),L"0.9.6",{});
    finish.set_value(); owner.join();
    CHECK(!result.success && setup::FilesEqual(source.wstring(),installed));
    std::cout<<"PASS running client is refused without force termination\n";

    result=setup::Install(locations,newer.wstring(),L"0.9.6",{true,true}); CHECK(result.success);
    CHECK(setup::FilesEqual(newer.wstring(),installed));
    CHECK(RegText(locations.uninstallKey,L"DisplayVersion")==L"0.9.6");
    const auto foreign=(root/L"retained-client.exe").wstring(); Put(foreign,"retained other installation");
    RegText(locations.runKey,L"NiuMaMerit",L"\""+foreign+L"\" --autostart");
    const auto classKey=locations.classesKey+L"\\NiuMaMerit.AppearancePack\\shell\\open\\command";
    RegText(classKey,L"",L"\""+foreign+L"\" \"%1\"");
    Link(locations.desktopLink,&foreign);
    Put(fs::path(locations.directory)/L"unrelated.txt","keep");
    result=setup::Remove(locations,newer.wstring()); CHECK(result.success);
    CHECK(!fs::exists(installed) && !fs::exists(locations.startMenuLink));
    CHECK(SameFile(Link(locations.desktopLink),foreign));
    CHECK(RegText(locations.runKey,L"NiuMaMerit")==L"\""+foreign+L"\" --autostart");
    CHECK(RegText(classKey,L"")==L"\""+foreign+L"\" \"%1\"");
    CHECK(Get(fs::path(locations.directory)/L"unrelated.txt")=="keep");
    CHECK(Get(data)=="total=12345\nkeep=user records\n");
    CHECK(RegText(locations.uninstallKey,L"DisplayName").empty());
    std::cout<<"PASS update and owned uninstall preserve retained-copy entries, unrelated files and user records\n";
    CHECK(setup::Install(locations,source.wstring(),L"0.9.5",{false,false}).success);
    Put(fs::path(locations.directory)/L"install.owner","foreign marker");
    CHECK(!setup::Install(locations,newer.wstring(),L"0.9.6",{}).success);
    CHECK(setup::FilesEqual(source.wstring(),installed));
    std::cout<<"PASS foreign ownership marker is preserved and blocks replacement\n";

    RegDeleteTreeW(HKEY_CURRENT_USER,registryRoot.c_str()); fs::remove_all(root);
    CoUninitialize(); std::cout<<"SELF_INSTALL_CONTRACTS=PASS\n"; return 0;
  } catch(const std::exception& error) {
    std::cerr<<error.what()<<"\n";
    // These are the unique test-owned namespace and directory, never the
    // production location. Keep files on failure to diagnose the real state.
    if(!registryRoot.empty()) RegDeleteTreeW(HKEY_CURRENT_USER,registryRoot.c_str());
    return 1;
  }
}
