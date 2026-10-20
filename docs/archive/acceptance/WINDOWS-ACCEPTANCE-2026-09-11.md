# Windows 0.3 multi-scene build

## Build result

- Source commit: `eeeceeb` (the following workflow-only commit enabled the branch trigger).
- GitHub Actions run: `34581423770`.
- Runner/toolchain: `windows-2022`, Visual Studio 2022, x64 MSVC Release.
- Result: PASS.
- Executable: `2,118,656` bytes.
- ZIP: `1,958,309` bytes.
- ZIP contains one portable file: `niuma-merit.exe`.
- SHA-256 executable: `867607c05732304e97d1f6a50055970300ceefa7d9ebd24c4b8d61842d313abf`.
- SHA-256 ZIP: `548deb49b1e93d27a234884f3babfd1aa39e6f6ef4cf97a514d203e94066499f`.
- PE inspection: x86-64 GUI executable. Imported DLLs are SHELL32, gdiplus, ole32, KERNEL32, USER32, GDI32 and ADVAPI32. No network DLL is imported.

## Implemented behavior

- Global keyboard down, left/right/middle/X mouse down, vertical/horizontal wheel gesture counting.
- Immediate 64-bit total updates with bounded animation and no animation debt.
- Default woodfish, lucky cat, chick pecking and hamster wheel scenes embedded in the single executable.
- One native four-card appearance picker; selection applies only after Confirm and persists locally.
- About, login startup toggle, appearance picker and Quit context-menu commands.
- Transparent always-on-top desktop-pet window and local state storage.

## Acceptance boundary

- Real MSVC compilation and packaging passed.
- The resulting executable has not yet been run on a Windows machine in this build cycle.
- Required real-machine checks: all global input categories, four appearance previews and animations, Confirm/Cancel behavior, persistence after restart, startup toggle, dragging, DPI scaling and idle/active performance.
- This development executable is unsigned, so Windows may show an unknown-publisher warning.
