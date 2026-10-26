#pragma once
#include <windows.h>
#include <optional>
#include <string>

namespace niuma::installation {
// The production entry always obtains these from Windows known folders. Tests
// supply their own directory and HKCU namespace; no runtime path override exists.
struct Locations {
  std::wstring directory, desktopLink, startMenuLink;
  std::wstring runKey, classesKey, uninstallKey, applicationMutex, setupMutex;
};
struct Options { bool startAtLogin = false; bool desktopShortcut = true; };
struct Result {
  bool success = false;
  std::wstring error;
  std::wstring shortcutNotice;
};
struct LaunchResult {
  bool handled = false;
  int exitCode = 0;
  std::optional<bool> startupChoice;
};
// Explicit product targets: Win7 SP1, Win8/8.1 and Win10/11 (x64 build).
constexpr bool SupportsSystemVersion(DWORD major, DWORD minor, DWORD build) {
  return (major == 6 && ((minor == 1 && build >= 7601) ||
      minor == 2 || minor == 3)) || (major == 10 && build >= 10240);
}
Locations CurrentUserLocations();
std::wstring Executable(const Locations& locations);
bool FilesEqual(const std::wstring& left, const std::wstring& right);
Result Install(const Locations&, const std::wstring& source, const std::wstring& version,
               Options options);
Result Remove(const Locations&, const std::wstring& expectedImage);
LaunchResult PrepareLaunch(HINSTANCE instance, const wchar_t* version);
}  // namespace niuma::installation
