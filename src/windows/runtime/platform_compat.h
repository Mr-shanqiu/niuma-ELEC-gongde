#pragma once
#include <windows.h>
#include <string>

namespace niuma::runtime {
// Full system-directory paths avoid loading optional graphics DLLs beside a
// downloaded installer. Missing components select the compatibility renderer.
inline HMODULE LoadSystemComponent(const wchar_t* name) {
  wchar_t directory[MAX_PATH]{};
  const UINT size = GetSystemDirectoryW(directory, MAX_PATH);
  if (!size || size >= MAX_PATH) return nullptr;
  const std::wstring path = std::wstring(directory) + L"\\" + name;
  return LoadLibraryW(path.c_str());
}
inline bool HasCompositionSystem() {
  using Version = LONG(WINAPI*)(OSVERSIONINFOW*);
  const auto read = reinterpret_cast<Version>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW v{}; v.dwOSVersionInfoSize = sizeof(v);
  return read && read(&v) == 0 && (v.dwMajorVersion > 6 ||
      (v.dwMajorVersion == 6 && v.dwMinorVersion >= 2));
}
} // namespace niuma::runtime
