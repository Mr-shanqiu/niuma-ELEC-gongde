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
    CHECK(!setup::SupportsSystemVersion(6, 7601));
    CHECK(!setup::SupportsSystemVersion(10, 19040));
    for (DWORD build : {19041u, 19042u, 19044u, 19045u, 22000u, 26100u})
      CHECK(setup::SupportsSystemVersion(10, build));
    std::cout<<"PASS Windows 10 2004 boundary and Windows 11 version policy\n";
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


    // Old custom-path and unreadable shortcuts are not grounds to block upgrade.
    auto compatibility=locations;
    compatibility.directory=(root/L"compat-app").wstring();
    compatibility.desktopLink=(root/L"compat-desktop.lnk").wstring();
    compatibility.startMenuLink=(root/L"compat-start.lnk").wstring();
    compatibility.uninstallKey=registryRoot+L"\\CompatUninstall";
    const auto retired=(root/L"old-custom-folder"/L"niuma-merit.exe").wstring();
    Link(compatibility.desktopLink,&retired);
    Put(compatibility.startMenuLink,"broken legacy shortcut");
    const auto foreignDesktop=Get(compatibility.desktopLink),foreignStart=Get(compatibility.startMenuLink);
    const auto alternativeDesktop=root/L"compat-desktop（新版）.lnk";
    const auto alternativeStart=root/L"compat-start（新版）.lnk";
    result=setup::Install(compatibility,source.wstring(),L"0.9.5",{true,true});
    CHECK(result.success && !result.shortcutNotice.empty());
    CHECK(Get(compatibility.desktopLink)==foreignDesktop && Get(compatibility.startMenuLink)==foreignStart);
    CHECK(SameFile(Link(alternativeDesktop),setup::Executable(compatibility)));
    CHECK(SameFile(Link(alternativeStart),setup::Executable(compatibility)));
    result=setup::Install(compatibility,newer.wstring(),L"0.9.6",{true,true});
    CHECK(result.success && !fs::exists(root/L"compat-desktop（新版 2）.lnk"));
    CHECK(Get(compatibility.desktopLink)==foreignDesktop && Get(compatibility.startMenuLink)==foreignStart);
    CHECK(setup::Remove(compatibility,newer.wstring()).success);
    CHECK(!fs::exists(alternativeDesktop) && !fs::exists(alternativeStart));
    CHECK(Get(compatibility.desktopLink)==foreignDesktop && Get(compatibility.startMenuLink)==foreignStart);
    std::cout<<"PASS old custom-path and broken shortcuts preserved; deterministic replacement reused and removed\n";

    // Occupying every bounded name must not prevent the executable installation.
    for(const auto& preferred:{compatibility.desktopLink,compatibility.startMenuLink}) {
      const fs::path path(preferred);
      for(unsigned i=1;i<=16;++i) {
        const std::wstring suffix=i==1 ? L"（新版）" : L"（新版 "+std::to_wstring(i)+L"）";
        Put(path.parent_path()/(path.stem().wstring()+suffix+path.extension().wstring()),"keep occupied shortcut");
      }
    }
    result=setup::Install(compatibility,source.wstring(),L"0.9.5",{});
    CHECK(result.success && !result.shortcutNotice.empty());
    CHECK(setup::Remove(compatibility,source.wstring()).success);
    CHECK(Get(alternativeDesktop)=="keep occupied shortcut" && Get(alternativeStart)=="keep occupied shortcut");
    std::cout<<"PASS all shortcut names occupied still installs; unrelated files survive uninstall\n";

    // CopyFile inherits a read-only download attribute, making the old reopen
    // fail. The new single writable handle must preserve every payload byte.
    const auto readonly=root/L"readonly-download.exe",legacyCopy=root/L"legacy-copy.new";
    wchar_t ownImage[MAX_PATH]{};
    CHECK(GetModuleFileNameW(nullptr,ownImage,MAX_PATH)>0);
    Put(readonly,Get(ownImage)+std::string(196731,'p')+"\0certificate-trailer"s);
    CHECK(SetFileAttributesW(readonly.c_str(),FILE_ATTRIBUTE_READONLY));
    CHECK(CopyFileW(readonly.c_str(),legacyCopy.c_str(),TRUE));
    HANDLE oldReopen=CreateFileW(legacyCopy.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr);
    CHECK(oldReopen==INVALID_HANDLE_VALUE && GetLastError()==ERROR_ACCESS_DENIED);
    auto readOnlyLocations=locations;
    readOnlyLocations.directory=(root/L"readonly-app").wstring();
    readOnlyLocations.startMenuLink=(root/L"readonly-start.lnk").wstring();
    readOnlyLocations.desktopLink=(root/L"readonly-desktop.lnk").wstring();
    result=setup::Install(readOnlyLocations,readonly.wstring(),L"0.9.5",{});
    if (!result.success) std::wcerr<<L"Read-only install: "<<result.error<<L"\n";
    CHECK(result.success && setup::FilesEqual(readonly.wstring(),setup::Executable(readOnlyLocations)));
    CHECK(!(GetFileAttributesW(setup::Executable(readOnlyLocations).c_str())&FILE_ATTRIBUTE_READONLY));
    CHECK(setup::Remove(readOnlyLocations,readonly.wstring()).success);
    CHECK(SetFileAttributesW(readonly.c_str(),FILE_ATTRIBUTE_NORMAL));
    CHECK(SetFileAttributesW(legacyCopy.c_str(),FILE_ATTRIBUTE_NORMAL));
    std::cout<<"PASS reproduced old read-only flush-reopen failure; new chunked copy is exact and writable\n";

    auto environmentLocations=readOnlyLocations;
    environmentLocations.directory=(root/L"env-app").wstring();
    environmentLocations.startMenuLink=(root/L"env-start.lnk").wstring();
    environmentLocations.desktopLink=(root/L"env-desktop.lnk").wstring();
    CHECK(SetEnvironmentVariableW(L"NIUMA_SELF_INSTALL_TEST_DIR",environmentLocations.directory.c_str()));
    const std::wstring environmentTarget=L"%NIUMA_SELF_INSTALL_TEST_DIR%\\niuma-merit.exe";
    Link(environmentLocations.startMenuLink,&environmentTarget);
    result=setup::Install(environmentLocations,source.wstring(),L"0.9.5",{});
    CHECK(result.success && result.shortcutNotice.empty());
    CHECK(SameFile(Link(environmentLocations.startMenuLink),setup::Executable(environmentLocations)));
    CHECK(setup::Remove(environmentLocations,source.wstring()).success);
    CHECK(SetEnvironmentVariableW(L"NIUMA_SELF_INSTALL_TEST_DIR",nullptr));
    std::cout<<"PASS environment-variable shortcut target belongs to the same installation\n";

    HANDLE blocked=CreateFileW(source.c_str(),GENERIC_READ,0,nullptr,OPEN_EXISTING,0,nullptr);
    CHECK(blocked!=INVALID_HANDLE_VALUE);
    result=setup::Install(readOnlyLocations,source.wstring(),L"0.9.5",{});
    CloseHandle(blocked);
    CHECK(!result.success && result.error.find(L"32")!=std::wstring::npos);
    CHECK(!fs::exists(setup::Executable(readOnlyLocations)));
    CHECK(Get(data)=="total=12345\nkeep=user records\n");
    std::cout<<"PASS copy sharing failure reports system code, cleans staging and preserves records\n";

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
