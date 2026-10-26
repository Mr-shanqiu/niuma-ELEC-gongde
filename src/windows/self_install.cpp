#include "self_install.h"
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <vector>

namespace niuma::installation {
namespace {
namespace fs = std::filesystem;
constexpr char kOwner[] = "NIUMA_SINGLE_FILE_INSTALL_V1\n";
struct Failure { std::wstring message; };
void Require(bool ok, const wchar_t* message) { if (!ok) throw Failure{message}; }
const wchar_t* Text(const wchar_t* zh, const wchar_t* en) {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE ? zh : en;
}
[[noreturn]] void FileFailure(const wchar_t* action, DWORD error) {
  throw Failure{std::wstring(action) + Text(L"（系统错误码：", L" (Windows error: ") +
      std::to_wstring(error) + Text(L"）。原有功德记录和素材未改动。", L"). Existing counts and packs were not changed.")};
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Mutex {
  Handle handle;
  bool held = false;
  explicit Mutex(const std::wstring& name) : handle(CreateMutexW(nullptr, FALSE, name.c_str())) {
    if (handle.value) {
      const auto wait = WaitForSingleObject(handle.value, 0);
      held = wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED;
    }
  }
  ~Mutex() { if (held) ReleaseMutex(handle.value); }
};
struct Com {
  HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  ~Com() { if (SUCCEEDED(result)) CoUninitialize(); }
};
template<class T> struct Interface {
  T* value = nullptr;
  ~Interface() { if (value) value->Release(); }
  T** address() { return &value; }
  T* operator->() const { return value; }
};
std::wstring UniqueName() {
  GUID id{}; Require(SUCCEEDED(CoCreateGuid(&id)), L"Could not create installation identity.");
  wchar_t text[40]{}; StringFromGUID2(id, text, 40); return text;
}
bool SamePath(const std::wstring& a, const std::wstring& b) {
  const auto normalized = [](const std::wstring& value) {
    if (value.empty()) return value;
    wchar_t full[MAX_PATH]{}, expanded[MAX_PATH]{};
    const auto fullLength = GetFullPathNameW(value.c_str(), MAX_PATH, full, nullptr);
    const std::wstring absolute = fullLength && fullLength < MAX_PATH ? full : value;
    const auto longLength = GetLongPathNameW(absolute.c_str(), expanded, MAX_PATH);
    return longLength && longLength < MAX_PATH ? std::wstring(expanded) : absolute;
  };
  auto left = normalized(a), right = normalized(b);
  while (left.size() > 3 && (left.back() == L'\\' || left.back() == L'/')) left.pop_back();
  while (right.size() > 3 && (right.back() == L'\\' || right.back() == L'/')) right.pop_back();
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool PlainPath(const fs::path& path) {
  // Setup owns local per-user files only. Never traverse a junction/symlink.
  const auto full = fs::absolute(path).lexically_normal();
  const auto name = full.wstring();
  if (name.size() >= MAX_PATH || name.size() < 3 || name[1] != L':' ||
      name[2] != L'\\' || name.find(L':', 2) != std::wstring::npos) return false;
  for (auto current = full; !current.empty();) {
    const auto attributes = GetFileAttributesW(current.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
      return false;
    const auto parent = current.parent_path(); if (parent == current) break;
    current = parent;
  }
  return true;
}
std::wstring KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR name = nullptr;
  Require(SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &name)), L"User folder unavailable.");
  std::wstring result(name); CoTaskMemFree(name); return result;
}
std::vector<char> ReadSmall(const fs::path& path) {
  const auto size = fs::file_size(path);
  Require(size <= 65536, L"Installation metadata is too large.");
  std::ifstream in(path, std::ios::binary);
  Require(in.good(), L"Installation metadata cannot be read.");
  std::vector<char> result{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
  Require(!in.bad() && result.size() == size, L"Installation metadata read was incomplete.");
  return result;
}
bool WriteBytes(const fs::path& path, const std::vector<char>& bytes) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                          FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  return WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
      written == bytes.size() && FlushFileBuffers(file.value);
}
void CopyAndFlush(const std::wstring& source, const fs::path& stage) {
  Handle input(CreateFileW(source.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (input.value == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    FileFailure(Text(L"无法读取安装包", L"Cannot read the installer"), error);
  }
  // Keep the writable handle from creation through FlushFileBuffers. Closing a
  // CopyFile handle and reopening it for write races scanners that open the new
  // file with read-only sharing. Readers may inspect this file during the copy.
  Handle output(CreateFileW(stage.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (output.value == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    FileFailure(Text(L"无法创建安装临时文件", L"Cannot create the installation file"), error);
  }
  std::array<char, 65536> buffer{};
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(input.value, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      const DWORD error = GetLastError();
      FileFailure(Text(L"读取安装包失败", L"Could not read the installer"), error);
    }
    if (!read) break;
    DWORD offset = 0;
    while (offset < read) {
      DWORD written = 0;
      if (!WriteFile(output.value, buffer.data() + offset, read - offset, &written, nullptr)) {
        const DWORD error = GetLastError();
        FileFailure(Text(L"写入安装临时文件失败", L"Could not write the installation file"), error);
      }
      if (!written) FileFailure(Text(L"安装文件写入不完整", L"Incomplete installation write"), ERROR_WRITE_FAULT);
      offset += written;
    }
  }
  if (!FlushFileBuffers(output.value)) {
    const DWORD error = GetLastError();
    FileFailure(Text(L"安装临时文件未能写入磁盘", L"Could not flush the installation file"), error);
  }
}
bool OwnerMatches(const Locations& l) {
  try {
    const auto bytes = ReadSmall(fs::path(l.directory) / L"install.owner");
    return bytes == std::vector<char>(kOwner, kOwner + sizeof(kOwner) - 1);
  } catch (...) { return false; }
}
std::wstring Quote(const std::wstring& text) {
  // All paths come from Windows, whose filenames cannot contain a quote.
  Require(text.find(L'"') == std::wstring::npos, L"Invalid path.");
  return L"\"" + text + L"\"";
}
std::wstring CommandImage(const std::wstring& command) {
  int count = 0; auto arguments = CommandLineToArgvW(command.c_str(), &count);
  if (!arguments) return {};
  std::wstring image = count ? arguments[0] : L""; LocalFree(arguments); return image;
}
std::wstring RegistryText(const std::wstring& key, const wchar_t* name) {
  DWORD bytes = 0, type = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, RRF_RT_REG_SZ,
      &type, nullptr, &bytes) != ERROR_SUCCESS || bytes > 65536) return {};
  std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1);
  if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), name, RRF_RT_REG_SZ,
      nullptr, value.data(), &bytes) != ERROR_SUCCESS) return {};
  return value.data();
}
struct RegistryJournal {
  struct Value { std::wstring key, name; bool existed; DWORD type; std::vector<BYTE> bytes; };
  std::vector<Value> saved;
  void Set(const std::wstring& key, const wchar_t* name, DWORD type, const void* data, DWORD bytes) {
    Value previous{key, name, false, 0, {}};
    HKEY opened = nullptr;
    const auto openStatus = RegOpenKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, KEY_QUERY_VALUE, &opened);
    Require(openStatus == ERROR_SUCCESS || openStatus == ERROR_FILE_NOT_FOUND || openStatus == ERROR_PATH_NOT_FOUND,
        L"Cannot inspect existing registration.");
    if (openStatus == ERROR_SUCCESS) {
      DWORD size = 0;
      const auto status = RegQueryValueExW(opened, name, nullptr, &previous.type, nullptr, &size);
      if (status == ERROR_SUCCESS && size <= 65536) {
        previous.bytes.resize(size); previous.existed = true;
        const auto read = RegQueryValueExW(opened, name, nullptr, &previous.type,
            previous.bytes.data(), &size);
        RegCloseKey(opened); opened = nullptr;
        Require(read == ERROR_SUCCESS, L"Cannot preserve existing registration.");
      } else {
        RegCloseKey(opened); opened = nullptr;
        Require(status == ERROR_FILE_NOT_FOUND, L"Cannot preserve existing registration.");
      }
    }
    saved.push_back(std::move(previous));
    Require(RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_SET_VALUE,
        nullptr, &opened, nullptr) == ERROR_SUCCESS, L"Cannot create per-user registration.");
    const auto status = RegSetValueExW(opened, name, 0, type,
        static_cast<const BYTE*>(data), bytes);
    RegCloseKey(opened);
    Require(status == ERROR_SUCCESS, L"Cannot write per-user registration.");
  }
  void String(const std::wstring& key, const wchar_t* name, const std::wstring& value) {
    Set(key, name, REG_SZ, value.c_str(), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  }
  void Number(const std::wstring& key, const wchar_t* name, DWORD value) {
    Set(key, name, REG_DWORD, &value, sizeof(value));
  }
  bool Restore() noexcept {
    bool ok = true;
    for (auto it = saved.rbegin(); it != saved.rend(); ++it) {
      HKEY key = nullptr;
      if (it->existed) {
        if (RegCreateKeyExW(HKEY_CURRENT_USER, it->key.c_str(), 0, nullptr, 0,
            KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) { ok = false; continue; }
        ok = (RegSetValueExW(key, it->name.c_str(), 0, it->type, it->bytes.data(),
            static_cast<DWORD>(it->bytes.size())) == ERROR_SUCCESS) && ok;
        RegCloseKey(key);
      } else {
        if (RegOpenKeyExW(HKEY_CURRENT_USER, it->key.c_str(), 0, KEY_SET_VALUE, &key) == ERROR_SUCCESS) {
          const auto result = RegDeleteValueW(key, it->name.c_str());
          ok = (result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND) && ok;
          RegCloseKey(key); RegDeleteKeyW(HKEY_CURRENT_USER, it->key.c_str()); // only if empty
        }
      }
    }
    return ok;
  }
};
struct FileJournal {
  struct Item { fs::path path; bool existed; std::vector<char> bytes; };
  std::vector<Item> items;
  void Save(const fs::path& path) {
    const bool existed = fs::exists(path);
    items.push_back({path, existed, existed ? ReadSmall(path) : std::vector<char>{}});
  }
  bool Restore() noexcept {
    bool ok = true;
    for (auto it = items.rbegin(); it != items.rend(); ++it) {
      if (it->existed) ok = WriteBytes(it->path, it->bytes) && ok;
      else {
        const bool removed = DeleteFileW(it->path.c_str()) != FALSE;
        ok = (removed || GetLastError() == ERROR_FILE_NOT_FOUND) && ok;
      }
    }
    return ok;
  }
};
std::wstring LinkTarget(const std::wstring& link) {
  Interface<IShellLinkW> shell; Interface<IPersistFile> persist;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(shell.address()))) || FAILED(shell->QueryInterface(IID_PPV_ARGS(persist.address()))) ||
      FAILED(persist->Load(link.c_str(), STGM_READ))) return {};
  wchar_t path[MAX_PATH]{};
  if (FAILED(shell->GetPath(path, MAX_PATH, nullptr, SLGP_RAWPATH))) return {};
  wchar_t expanded[MAX_PATH]{};
  const auto length = ExpandEnvironmentStringsW(path, expanded, MAX_PATH);
  return length && length <= MAX_PATH ? std::wstring(expanded) : std::wstring(path);
}
std::vector<std::wstring> LinkNames(const std::wstring& preferred) {
  std::vector<std::wstring> result{preferred};
  const fs::path path(preferred);
  // A finite set, shared with uninstall; no desktop scanning or user files are
  // renamed/deleted to make room. Existing foreign or unreadable links survive.
  for (unsigned i = 1; i <= 16; ++i) {
    const auto suffix = i == 1 ? L"（新版）" : L"（新版 " + std::to_wstring(i) + L"）";
    result.push_back((path.parent_path() / (path.stem().wstring() + suffix + path.extension().wstring())).wstring());
  }
  return result;
}
std::wstring ChooseLink(const std::wstring& preferred, const std::wstring& image) {
  std::wstring vacant;
  for (const auto& link : LinkNames(preferred)) {
    if (!PlainPath(link)) continue;
    std::error_code error;
    const bool exists = fs::exists(link, error);
    if (error) continue;
    if (!exists) { if (vacant.empty()) vacant = link; continue; }
    if (fs::is_regular_file(link, error) && !error && SamePath(LinkTarget(link), image)) return link;
  }
  // A name collision is not a failed installation. The installed executable
  // and system uninstall entry remain available even when all links are taken.
  return vacant;
}
void WriteLink(const std::wstring& link, const std::wstring& image) {
  Interface<IShellLinkW> shell; Interface<IPersistFile> persist;
  Require(SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(shell.address()))), L"Cannot create shortcut.");
  Require(SUCCEEDED(shell->SetPath(image.c_str())) &&
      SUCCEEDED(shell->SetWorkingDirectory(fs::path(image).parent_path().c_str())) &&
      SUCCEEDED(shell->SetIconLocation(image.c_str(), 0)) &&
      SUCCEEDED(shell->QueryInterface(IID_PPV_ARGS(persist.address()))), L"Cannot prepare shortcut.");
  const auto temporary = link + UniqueName() + L".new";
  const auto result = persist->Save(temporary.c_str(), TRUE);
  const bool moved = SUCCEEDED(result) && MoveFileExW(temporary.c_str(), link.c_str(),
      MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  if (!moved) DeleteFileW(temporary.c_str());
  Require(moved, L"Cannot save shortcut.");
}
bool DeleteValue(const std::wstring& path, const wchar_t* name) {
  HKEY key = nullptr;
  const auto open = RegOpenKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, KEY_SET_VALUE, &key);
  if (open == ERROR_FILE_NOT_FOUND) return true;
  if (open != ERROR_SUCCESS) return false;
  const auto result = RegDeleteValueW(key, name); RegCloseKey(key);
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND;
}
bool DeleteTree(const std::wstring& path) {
  const auto result = RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str());
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND;
}
void Register(const Locations& l, const std::wstring& version, Options options, RegistryJournal& journal) {
  const auto image = Executable(l), command = Quote(image) + L" \"%1\"";
  const std::array<std::pair<const wchar_t*, const wchar_t*>, 3> associations{{
      {L".nmgpack", L"NiuMaMerit.AppearancePack"},
      {L".nmgpacks", L"NiuMaMerit.AppearanceBatch"},
      {L".nmgtext", L"NiuMaMerit.MessageCatalog"}}};
  for (const auto& association : associations) {
    journal.String(l.classesKey + L"\\" + association.first, L"", association.second);
    journal.String(l.classesKey + L"\\" + association.second + L"\\shell\\open\\command", L"", command);
  }
  journal.String(l.uninstallKey, L"DisplayName", L"牛马电子功德");
  journal.String(l.uninstallKey, L"DisplayVersion", version);
  journal.String(l.uninstallKey, L"Publisher", L"牛马电子功德");
  journal.String(l.uninstallKey, L"InstallLocation", l.directory);
  journal.String(l.uninstallKey, L"DisplayIcon", image);
  journal.String(l.uninstallKey, L"UninstallString", Quote(image) + L" --uninstall");
  journal.Number(l.uninstallKey, L"NoModify", 1); journal.Number(l.uninstallKey, L"NoRepair", 1);
  journal.Number(l.uninstallKey, L"EstimatedSize", static_cast<DWORD>((fs::file_size(image) + 1023) / 1024));
  if (options.startAtLogin) journal.String(l.runKey, L"NiuMaMerit", Quote(image) + L" --autostart");
  // An unchecked option is applied through the normal storage owner at launch.
  // Do not delete a Run value that belongs to a different retained installation.
}
bool Start(const std::wstring& image, const std::wstring& args) {
  std::wstring command = Quote(image) + (args.empty() ? L"" : L" " + args);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
  if (!CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE, 0,
      nullptr, fs::path(image).parent_path().c_str(), &startup, &process)) return false;
  CloseHandle(process.hThread); CloseHandle(process.hProcess); return true;
}
std::wstring OwnImage() {
  wchar_t path[MAX_PATH]{}; const auto length = GetModuleFileNameW(nullptr, path, MAX_PATH);
  Require(length && length < MAX_PATH, L"Executable path unavailable."); return path;
}
bool SupportedSystem() {
  using ReadVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
  const auto function = reinterpret_cast<ReadVersion>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW version{}; version.dwOSVersionInfoSize = sizeof(version);
  return function && function(&version) == 0 && SupportsSystemVersion(version.dwMajorVersion, version.dwBuildNumber);
}
void CleanRetiredWorkers() {
  // No recursion: only our two known files, with a matching ownership marker.
  // A running worker's image cannot be deleted, so leave it untouched.
  try {
    wchar_t temporary[MAX_PATH]{}; if (!GetTempPathW(MAX_PATH, temporary)) return;
    for (const auto& item : fs::directory_iterator(temporary)) {
      if (item.path().filename().wstring().find(L"NiuMaMerit-remove-") != 0 ||
          !PlainPath(item.path())) continue;
      try {
        const auto bytes = ReadSmall(item.path() / L"remove.owner");
        if (bytes != std::vector<char>(kOwner, kOwner + sizeof(kOwner) - 1)) continue;
        if (DeleteFileW((item.path() / L"niuma-merit.exe").c_str())) {
          DeleteFileW((item.path() / L"remove.owner").c_str());
          RemoveDirectoryW(item.path().c_str());
        }
      } catch (...) {}
    }
  } catch (...) {}
}
}  // namespace

Locations CurrentUserLocations() {
  const auto local = KnownFolder(FOLDERID_LocalAppData);
  return {(fs::path(local) / L"Programs" / L"NiumaMerit").wstring(),
      (fs::path(KnownFolder(FOLDERID_Desktop)) / L"牛马电子功德.lnk").wstring(),
      (fs::path(KnownFolder(FOLDERID_Programs)) / L"牛马电子功德.lnk").wstring(),
      L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", L"Software\\Classes",
      L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{D1B9D81E-13A1-45E2-9B8F-33C9C7A06F27}_is1",
      L"Local\\NiuMaMeritCounter", L"Local\\NiuMaMerit.Setup"};
}
std::wstring Executable(const Locations& locations) {
  return (fs::path(locations.directory) / L"niuma-merit.exe").wstring();
}
bool FilesEqual(const std::wstring& left, const std::wstring& right) {
  try {
    if (fs::file_size(left) != fs::file_size(right)) return false;
    std::ifstream a(fs::path(left), std::ios::binary), b(fs::path(right), std::ios::binary);
    if (!a || !b) return false;
    std::array<char, 65536> x{}, y{};
    do {
      a.read(x.data(), x.size()); b.read(y.data(), y.size());
      if (a.gcount() != b.gcount() || !std::equal(x.begin(), x.begin() + a.gcount(), y.begin())) return false;
    } while (a.gcount());
    return a.eof() && b.eof();
  } catch (...) { return false; }
}

Result Install(const Locations& l, const std::wstring& source, const std::wstring& version, Options options) {
  RegistryJournal registry; FileJournal files;
  fs::path stage, backup; bool committedImage = false, hadImage = false;
  Mutex setup(l.setupMutex), application(l.applicationMutex);
  try {
    Require(setup.held, L"Another installation is running.");
    Require(application.held, L"Exit the running client before installing or updating.");
    Com com; Require(SUCCEEDED(com.result), L"Shortcut services unavailable.");
    Require(PlainPath(source) && PlainPath(l.directory) && PlainPath(Executable(l)) &&
        PlainPath(fs::path(l.directory) / L"install.owner"), L"Installation path contains a link or is unsupported.");
    Require(!SamePath(source, Executable(l)), L"The installation source must be a separate file.");
    const auto image = Executable(l);
    const auto startLink = ChooseLink(l.startMenuLink, image);
    const auto desktopLink = options.desktopShortcut ? ChooseLink(l.desktopLink, image) : std::wstring{};
    std::wstring shortcutNotice;
    if (startLink != l.startMenuLink || (options.desktopShortcut && desktopLink != l.desktopLink)) {
      shortcutNotice = Text(L"安装成功。同名旧快捷方式已保留。新版程序位置：\n",
          L"Installation succeeded. Existing shortcuts were preserved. Installed program:\n");
      shortcutNotice += image;
      if (!startLink.empty()) shortcutNotice += L"\n" + startLink;
      if (!desktopLink.empty()) shortcutNotice += L"\n" + desktopLink;
    }
    for (const auto& link : {startLink, desktopLink}) {
      if (link.empty()) continue;
      fs::create_directories(fs::path(link).parent_path()); files.Save(link);
    }
    fs::create_directories(l.directory);
    const auto marker = fs::path(l.directory) / L"install.owner";
    if (fs::exists(marker)) Require(OwnerMatches(l), L"Existing installation owner is invalid.");
    files.Save(marker);
    stage = fs::path(l.directory) / (L".install-" + UniqueName() + L".new");
    backup = fs::path(l.directory) / (L".previous-" + UniqueName());
    CopyAndFlush(source, stage);
    Require(FilesEqual(source, stage.wstring()), Text(L"安装文件校验失败，原有客户端未替换。",
        L"Installation file verification failed; the existing client was not replaced."));
    hadImage = fs::exists(image);
    if (hadImage) {
      const bool replaced = ReplaceFileW(image.c_str(), stage.c_str(), backup.c_str(), 0, nullptr, nullptr) != FALSE;
      if (!replaced && fs::exists(backup)) committedImage = true;
      Require(replaced, L"The installed executable is in use or cannot be replaced.");
    }
    else Require(MoveFileExW(stage.c_str(), image.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        L"The executable could not be installed.");
    committedImage = true;
    if (!startLink.empty()) WriteLink(startLink, image);
    if (!desktopLink.empty()) WriteLink(desktopLink, image);
    Register(l, version, options, registry);
    Require(WriteBytes(marker, {kOwner, kOwner + sizeof(kOwner) - 1}), L"Could not record installation ownership.");
    Require(FilesEqual(source, image), L"Installed executable verification failed.");
    if (hadImage) DeleteFileW(backup.c_str());
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return {true, {}, shortcutNotice};
  } catch (const Failure& error) {
    const bool registryRestored = registry.Restore();
    bool restored = files.Restore() && registryRestored;
    if (committedImage) {
      if (hadImage) restored = (MoveFileExW(backup.c_str(), Executable(l).c_str(),
          MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE) && restored;
      else restored = (DeleteFileW(Executable(l).c_str()) != FALSE) && restored;
    }
    if (!stage.empty()) DeleteFileW(stage.c_str());
    return {false, error.message + (restored ? L"" : L" Recovery incomplete; original files were retained for inspection.")};
  } catch (...) {
    // Run the same restoration for filesystem/allocator failures.
    registry.Restore(); files.Restore();
    if (committedImage) {
      if (hadImage) MoveFileExW(backup.c_str(), Executable(l).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
      else DeleteFileW(Executable(l).c_str());
    }
    if (!stage.empty()) DeleteFileW(stage.c_str());
    return {false, L"Installation could not complete. Check local file access and retry."};
  }
}

Result Remove(const Locations& l, const std::wstring& expectedImage) {
  try {
    Mutex setup(l.setupMutex), application(l.applicationMutex);
    Require(setup.held && application.held, L"Exit the client and any other installer before uninstalling.");
    Com com; Require(SUCCEEDED(com.result), L"Shortcut services unavailable.");
    Require(PlainPath(l.directory) && PlainPath(Executable(l)) &&
        PlainPath(fs::path(l.directory)/L"install.owner"), L"Uninstall path is unsafe.");
    Require(OwnerMatches(l) && FilesEqual(Executable(l), expectedImage), L"Installation identity changed; nothing was removed.");
    const auto image = Executable(l);
    for (const auto& preferred : {l.desktopLink, l.startMenuLink})
      for (const auto& link : LinkNames(preferred))
        if (PlainPath(link) && fs::is_regular_file(link) && SamePath(LinkTarget(link), image))
          Require(DeleteFileW(link.c_str()) != FALSE, L"Could not remove shortcut.");
    if (SamePath(CommandImage(RegistryText(l.runKey, L"NiuMaMerit")), image))
      Require(DeleteValue(l.runKey, L"NiuMaMerit"), L"Could not remove startup entry.");
    for (const auto& association : std::array<std::pair<const wchar_t*, const wchar_t*>, 3>{{
        {L".nmgpack", L"NiuMaMerit.AppearancePack"}, {L".nmgpacks", L"NiuMaMerit.AppearanceBatch"},
        {L".nmgtext", L"NiuMaMerit.MessageCatalog"}}}) {
      const auto cls = l.classesKey + L"\\" + association.second;
      if (!SamePath(CommandImage(RegistryText(cls + L"\\shell\\open\\command", L"")), image)) continue;
      const auto ext = l.classesKey + L"\\" + association.first;
      if (RegistryText(ext, L"") == association.second)
        Require(DeleteValue(ext, L""), L"Could not remove file association.");
      Require(DeleteTree(cls), L"Could not remove owned file association.");
    }
    if (SamePath(CommandImage(RegistryText(l.uninstallKey, L"UninstallString")), image))
      Require(DeleteTree(l.uninstallKey), L"Could not remove uninstall entry.");
    Require(DeleteFileW(image.c_str()) != FALSE, L"Could not remove installed executable.");
    DeleteFileW((fs::path(l.directory) / L"install.owner").c_str());
    RemoveDirectoryW(l.directory.c_str()); // preserve unrelated files and all user data
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return {true, {}};
  } catch (const Failure& error) { return {false, error.message}; }
  catch (...) { return {false, L"Uninstall could not complete. User records were not deleted."}; }
}

LaunchResult PrepareLaunch(HINSTANCE instance, const wchar_t* version) {
  try {
    Require(SupportedSystem(), Text(L"此版本需要 Windows 10 2004 或更新系统。", L"This version requires Windows 10 version 2004 or later."));
    const auto l = CurrentUserLocations();
    const auto image = OwnImage();
    int count = 0; auto raw = CommandLineToArgvW(GetCommandLineW(), &count);
    Require(raw != nullptr, L"Command line unavailable.");
    std::vector<std::wstring> args(raw + 1, raw + count); LocalFree(raw);
    const auto has = [&](const wchar_t* value) { return std::find(args.begin(), args.end(), value) != args.end(); };
    const auto inform = [&](const std::wstring& message, UINT flags = MB_OK | MB_ICONERROR) {
      return MessageBoxW(nullptr, message.c_str(), L"牛马电子功德", flags);
    };
    if (has(L"--uninstall-worker")) {
      const fs::path folder = fs::path(image).parent_path();
      wchar_t temp[MAX_PATH]{}; Require(GetTempPathW(MAX_PATH, temp) != 0, L"Temporary folder unavailable.");
      Require(SamePath(folder.parent_path().wstring(), fs::path(temp).lexically_normal().wstring()) &&
          folder.filename().wstring().find(L"NiuMaMerit-remove-") == 0 && PlainPath(folder) &&
          fs::exists(folder / L"remove.owner"), L"Invalid uninstall worker.");
      const auto owner = ReadSmall(folder / L"remove.owner");
      Require(owner == std::vector<char>(kOwner, kOwner + sizeof(kOwner) - 1), L"Invalid uninstall owner.");
      DWORD parentId = 0;
      for (const auto& argument : args) {
        constexpr wchar_t prefix[] = L"--uninstall-parent=";
        if (argument.find(prefix) != 0) continue;
        const auto digits = argument.substr(std::size(prefix) - 1);
        Require(!digits.empty() && digits.size() <= 10 &&
            digits.find_first_not_of(L"0123456789") == std::wstring::npos, L"Invalid uninstall parent.");
        const auto parsed = std::stoull(digits);
        Require(parsed && parsed <= MAXDWORD && parsed != GetCurrentProcessId(), L"Invalid uninstall parent.");
        parentId = static_cast<DWORD>(parsed);
      }
      Require(parentId != 0, L"Missing uninstall parent.");
      Handle parent(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentId));
      if (parent.value) {
        const auto state = WaitForSingleObject(parent.value, 0);
        Require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, L"Cannot observe uninstall parent.");
        if (state == WAIT_TIMEOUT) {
          wchar_t parentImage[MAX_PATH]{}; DWORD length = MAX_PATH;
          const bool identityMatches = QueryFullProcessImageNameW(parent.value, 0, parentImage, &length) &&
              SamePath(parentImage, Executable(l));
          // It can exit between the wait and image query. An exited process no
          // longer has to expose its image; a still-live different one is refused.
          Require(identityMatches || WaitForSingleObject(parent.value, 0) == WAIT_OBJECT_0,
              L"Uninstall parent changed.");
        }
        Require(WaitForSingleObject(parent.value, 30000) == WAIT_OBJECT_0, L"Uninstall parent is still running.");
      } else Require(GetLastError() == ERROR_INVALID_PARAMETER, L"Cannot confirm uninstall parent exit.");
      // Only the already-confirmed, short-lived copy enters this branch. It
      // removes the fixed install, never its own Temp image or any user data.
      const auto result = Remove(l, image);
      inform(result.success ? Text(L"卸载完成。功德记录和导入素材已保留。", L"Uninstalled. Counts and imported packs were retained.") : result.error,
          MB_OK | (result.success ? MB_ICONINFORMATION : MB_ICONERROR));
      return {true, result.success ? 0 : 1, {}};
    }
    if (has(L"--uninstall")) {
      Require(SamePath(image, Executable(l)) && OwnerMatches(l), L"This is not the installed application.");
      if (inform(Text(L"卸载牛马电子功德？功德记录和导入素材将保留。请先退出正在运行的客户端。",
          L"Uninstall NiuMa Merit? Counts and imported packs will be retained. Exit the running client first."),
          MB_OKCANCEL | MB_ICONQUESTION) != IDOK) return {true, 0, {}};
      wchar_t temp[MAX_PATH]{}; Require(GetTempPathW(MAX_PATH, temp) != 0, L"Temporary folder unavailable.");
      const auto folder = fs::path(temp) / (L"NiuMaMerit-remove-" + UniqueName());
      Require(PlainPath(folder), L"Temporary folder contains a link."); fs::create_directory(folder);
      const auto copy = folder / L"niuma-merit.exe";
      Require(CopyFileW(image.c_str(), copy.c_str(), TRUE) && FilesEqual(image, copy.wstring()) &&
          WriteBytes(folder / L"remove.owner", {kOwner, kOwner + sizeof(kOwner) - 1}), L"Could not prepare signed uninstall copy.");
      // Parent and worker must not race image deletion. The worker receives a
      // process id, waits for this instance to exit, then rechecks file identity.
      Require(Start(copy.wstring(), L"--uninstall-worker --uninstall-parent=" +
          std::to_wstring(GetCurrentProcessId())), L"Could not launch uninstall copy.");
      return {true, 0, {}};
    }
    CleanRetiredWorkers();
    if (SamePath(image, Executable(l))) {
      std::optional<bool> choice;
      if (has(L"--setup-startup=0")) choice = false;
      else if (has(L"--setup-startup=1")) choice = true;
      return {false, 0, choice};
    }
    Require(!has(L"--autostart"), L"Startup entry points outside the installed directory. Run the downloaded file normally to install.");
    TASKDIALOGCONFIG config{}; config.cbSize = sizeof(config); config.hInstance = instance;
    config.dwCommonButtons = TDCBF_CANCEL_BUTTON; config.pszWindowTitle = L"牛马电子功德";
    config.pszMainInstruction = Text(L"安装并启动牛马电子功德", L"Install and start NiuMa Merit");
    const auto content = std::wstring(Text(L"安装位置：\n", L"Install location:\n")) + l.directory +
        Text(L"\n\n已有功德记录和素材不会被删除。", L"\n\nExisting counts and packs will be retained.");
    config.pszContent = content.c_str();
    config.pszVerificationText = Text(L"登录后自动启动", L"Start automatically at login");
    if (SamePath(CommandImage(RegistryText(l.runKey, L"NiuMaMerit")), Executable(l))) config.dwFlags |= TDF_VERIFICATION_FLAG_CHECKED;
    const TASKDIALOG_BUTTON button{IDOK, Text(L"安装并启动", L"Install and start")};
    config.cButtons = 1; config.pButtons = &button; config.nDefaultButton = IDOK;
    int selected = IDCANCEL; BOOL startup = FALSE;
    Require(SUCCEEDED(TaskDialogIndirect(&config, &selected, nullptr, &startup)), L"Installation dialog unavailable.");
    if (selected != IDOK) return {true, 0, {}};
    const auto result = Install(l, image, version, {startup != FALSE, true});
    Require(result.success, result.error.c_str());
    std::wstring forwarded = startup ? L"--setup-startup=1" : L"--setup-startup=0";
    for (const auto& argument : args)
      if (!argument.empty() && argument[0] != L'-') forwarded += L" " + Quote(argument);
    Require(Start(Executable(l), forwarded), L"Installed successfully, but launch failed. Use the installed shortcut to retry.");
    if (!result.shortcutNotice.empty()) inform(result.shortcutNotice, MB_OK | MB_ICONINFORMATION);
    return {true, 0, {}};
  } catch (const Failure& error) {
    MessageBoxW(nullptr, error.message.c_str(), L"牛马电子功德", MB_OK | MB_ICONERROR);
  } catch (...) {
    MessageBoxW(nullptr, Text(L"安装或启动未完成，原有用户记录已保留。", L"Setup or launch could not complete. Existing user records were retained."),
        L"牛马电子功德", MB_OK | MB_ICONERROR);
  }
  return {true, 1, {}};
}
}  // namespace niuma::installation
