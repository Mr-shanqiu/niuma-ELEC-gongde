// Isolated Raw Input feasibility probe. Never installs, hooks, reads/writes user
// data, changes startup settings, or stores input payloads. Not the client backend.
#include "../src/windows/runtime/raw_input_decoder.h"
#include <algorithm>
#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace core = niuma::client::core;
namespace input = niuma::windows::runtime;
#define CHECK(x) do { if (!(x)) throw std::runtime_error("line " + std::to_string(__LINE__) + ": " #x); } while(false)
struct Probe {
  HWND window = nullptr;
  core::InputCore counts;
  std::uint64_t packets = 0, keys = 0, keyUps = 0, clicks = 0, wheels = 0;
  std::uint64_t ignoredMouseMoves = 0, noDevicePackets = 0, errors = 0, lateMessages = 0;
  DWORD maximumMessageDelayMs = 0;
  bool registered = false, observeLegacy = false;
  unsigned legacyKeyDowns = 0, hardwareOrigins = 0, injectedOrigins = 0, unavailableOrigins = 0;
  void Observe(const RAWINPUT& packet, ULONGLONG now) {
    ++packets;
    const auto operations = input::DecodeRawInput(packet);
    if (!operations.hasDevice) ++noDevicePackets;
    if (packet.header.dwType == RIM_TYPEMOUSE && !operations.count) ++ignoredMouseMoves;
    for (unsigned i = 0; i < operations.count; ++i) {
      const auto kind = operations.events[i];
      if (kind == core::InputKind::KeyDown) ++keys;
      else if (kind == core::InputKind::KeyUp) ++keyUps;
      else if (kind == core::InputKind::Click) ++clicks;
      else ++wheels;
      SYSTEMTIME date{}; GetLocalTime(&date);
      const auto day = core::LocalDate(date.wYear * 10000u + date.wMonth * 100u + date.wDay);
      counts.AdvanceAnimation(now);
      // This is a count-only probe. Device presence cannot classify injection:
      // precision touchpads legitimately supply a null handle. Never feed
      // unverified activity into the reminder sampler.
      counts.Observe({kind, true, now, day});
    }
  }
  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    auto* self = reinterpret_cast<Probe*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      self = static_cast<Probe*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    if (self && self->observeLegacy &&
        (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) && wp == VK_F24) ++self->legacyKeyDowns;
    if (self && message == WM_INPUT) {
      RAWINPUT packet{}; UINT bytes = sizeof(packet);
      const auto size = GetRawInputData(reinterpret_cast<HRAWINPUT>(lp), RID_INPUT,
          &packet, &bytes, sizeof(RAWINPUTHEADER));
      if (size == UINT(-1) || size < sizeof(RAWINPUTHEADER) ||
          (packet.header.dwType == RIM_TYPEKEYBOARD && size < offsetof(RAWINPUT, data) + sizeof(RAWKEYBOARD)) ||
          (packet.header.dwType == RIM_TYPEMOUSE && size < offsetof(RAWINPUT, data) + sizeof(RAWMOUSE))) ++self->errors;
      else {
        INPUT_MESSAGE_SOURCE source{};
        if (GetCurrentInputMessageSource(&source) && source.originId == IMO_HARDWARE) ++self->hardwareOrigins;
        else if (source.originId == IMO_INJECTED) ++self->injectedOrigins;
        else ++self->unavailableOrigins;
        const DWORD delay = static_cast<DWORD>(GetTickCount64()) - static_cast<DWORD>(GetMessageTime());
        self->maximumMessageDelayMs = std::max(self->maximumMessageDelayMs, delay);
        if (delay > 16) ++self->lateMessages;
        self->Observe(packet, GetTickCount64());
      }
    }
    return DefWindowProcW(window, message, wp, lp);
  }
  void Start() {
    SYSTEMTIME date{}; GetLocalTime(&date);
    CHECK(counts.Initialize(0, date.wYear * 10000u + date.wMonth * 100u + date.wDay, nullptr, 0, false));
    // RegisterRawInputDevices is process-wide per class. This executable owns
    // its whole process; refuse any existing registration rather than stealing it.
    UINT existing = 0;
    CHECK(GetRegisteredRawInputDevices(nullptr, &existing, sizeof(RAWINPUTDEVICE)) != UINT(-1));
    CHECK(existing == 0);
    WNDCLASSW type{}; type.lpfnWndProc = Procedure; type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"NiuMaIsolatedRawInputProbe";
    CHECK(RegisterClassW(&type));
    window = CreateWindowExW(0, type.lpszClassName, L"", 0, 0, 0, 0, 0,
        HWND_MESSAGE, nullptr, type.hInstance, this);
    CHECK(window);
    const RAWINPUTDEVICE devices[] = {{1, 6, RIDEV_INPUTSINK, window}, {1, 2, RIDEV_INPUTSINK, window}};
    CHECK(RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE)));
    registered = true;
    RAWINPUTDEVICE readback[2]{}; UINT count = 2;
    CHECK(GetRegisteredRawInputDevices(readback, &count, sizeof(RAWINPUTDEVICE)) == 2);
    for (const auto& device : readback) CHECK(device.hwndTarget == window && device.dwFlags == RIDEV_INPUTSINK);
    counts.SetListenerHealth(true, true);
  }
  void Stop() {
    if (registered) {
      const RAWINPUTDEVICE devices[] = {{1, 6, RIDEV_REMOVE, nullptr}, {1, 2, RIDEV_REMOVE, nullptr}};
      CHECK(RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE)));
      registered = false;
      UINT count = 0;
      CHECK(GetRegisteredRawInputDevices(nullptr, &count, sizeof(RAWINPUTDEVICE)) != UINT(-1) && count == 0);
    }
    if (window) { CHECK(DestroyWindow(window)); window = nullptr; }
    UnregisterClassW(L"NiuMaIsolatedRawInputProbe", GetModuleHandleW(nullptr));
  }
  ~Probe() { if (window) DestroyWindow(window); }
};
void SelfTest() {
  using core::InputKind;
  Probe probe; probe.Start();
  RAWINPUT packet{}; packet.header.dwType = RIM_TYPEKEYBOARD;
  packet.header.hDevice = reinterpret_cast<HANDLE>(1); packet.data.keyboard.VKey = 'A';
  for (unsigned i = 0; i < 3; ++i) probe.Observe(packet, 1000 + i * 10);
  packet.data.keyboard.Flags = RI_KEY_BREAK; probe.Observe(packet, 1031);
  CHECK(probe.counts.snapshot().total == 3 && probe.keyUps == 1);
  packet.data.keyboard.VKey = 0xff; CHECK(input::DecodeRawInput(packet).count == 0);
  packet.data.keyboard.VKey = 'A'; packet.data.keyboard.MakeCode = KEYBOARD_OVERRUN_MAKE_CODE;
  CHECK(input::DecodeRawInput(packet).count == 0);
  std::cout << "PASS repeat makes count, breaks and keyboard overrun do not count\n";
  packet = {}; packet.header.dwType = RIM_TYPEMOUSE;
  packet.data.mouse.usButtonFlags = RI_MOUSE_LEFT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_DOWN |
      RI_MOUSE_MIDDLE_BUTTON_DOWN | RI_MOUSE_BUTTON_4_DOWN | RI_MOUSE_BUTTON_5_DOWN;
  probe.Observe(packet, 1100); CHECK(probe.counts.snapshot().total == 8 && probe.clicks == 5);
  packet.data.mouse.usButtonFlags = RI_MOUSE_WHEEL; probe.Observe(packet, 1200); probe.Observe(packet, 1210);
  packet.data.mouse.usButtonFlags = RI_MOUSE_HWHEEL; probe.Observe(packet, 1800);
  CHECK(probe.counts.snapshot().total == 10 && probe.wheels == 3);
  packet.data.mouse.usButtonFlags = 0;
  for (unsigned i = 0; i < 8000; ++i) probe.Observe(packet, 1900);
  CHECK(probe.counts.snapshot().total == 10 && probe.ignoredMouseMoves == 8000);
  CHECK(!input::DecodeRawInput(packet).hasDevice);
  std::cout << "PASS five buttons, wheel gesture semantics, null devices and 8000 ignored movements\n";
  probe.Stop();
  std::cout << "PASS real background registration and cleanup; no low-level hooks\n";
  std::cout << "RAW_INPUT_PROTOTYPE=PASS physicalInputTested=false productionBackendChanged=false\n";
}
void InjectionCheck() {
  wchar_t ci[16]{};
  CHECK(GetEnvironmentVariableW(L"GITHUB_ACTIONS", ci, 16) && std::wstring(ci) == L"true");
  Probe probe; probe.Start(); probe.observeLegacy = true;
  HWND peer = CreateWindowExW(0, L"NiuMaIsolatedRawInputProbe", L"Owned F24 injection check", WS_POPUP,
      0, 0, 160, 80, nullptr, nullptr, GetModuleHandleW(nullptr), &probe);
  CHECK(peer); ShowWindow(peer, SW_SHOW); SetForegroundWindow(peer); SetFocus(peer);
  CHECK(GetForegroundWindow() == peer);
  INPUT events[6]{};
  for (unsigned i = 0; i < 6; ++i) {
    events[i].type = INPUT_KEYBOARD;
    events[i].ki.wVk = VK_F24;
    events[i].ki.dwExtraInfo = 0x4e4d5241;
    if (i % 2) events[i].ki.dwFlags = KEYEVENTF_KEYUP;
  }
  CHECK(SendInput(6, events, sizeof(INPUT)) == 6);
  const auto deadline = GetTickCount64() + 1000;
  do {
    MSG message{};
    for (unsigned n = 0; n < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++n)
      DispatchMessageW(&message);
    Sleep(5);
  } while (GetTickCount64() < deadline);
  CHECK(probe.legacyKeyDowns == 3 && probe.errors == 0);
  CHECK(DestroyWindow(peer)); probe.Stop();
  std::cout << "{\"sentKeyDowns\":3,\"ownedWindowKeyDowns\":" << probe.legacyKeyDowns
      << ",\"rawKeyDowns\":" << probe.keys << ",\"rawKeyUps\":" << probe.keyUps
      << ",\"rawHardwareOrigins\":" << probe.hardwareOrigins
      << ",\"rawInjectedOrigins\":" << probe.injectedOrigins
      << ",\"rawUnavailableOrigins\":" << probe.unavailableOrigins
      << ",\"readErrors\":" << probe.errors
      << ",\"syntheticInputParity\":" << (probe.keys == 3 ? "true" : "false")
      << ",\"physicalInputTested\":false,\"productionBackendChanged\":false}\n";
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") { SelfTest(); return 0; }
    if (argc == 2 && std::wstring(argv[1]) == L"--injection-check") { InjectionCheck(); return 0; }
    CHECK(argc == 2);
    const std::wstring argument = argv[1]; CHECK(argument.find(L"--seconds=") == 0);
    const auto seconds = std::stoul(argument.substr(10)); CHECK(seconds >= 5 && seconds <= 120);
    Probe probe; probe.Start();
    const auto deadline = GetTickCount64() + seconds * 1000;
    while (GetTickCount64() < deadline) {
      MSG message{};
      for (unsigned n = 0; n < 64 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++n)
        DispatchMessageW(&message);
      MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_RAWINPUT, MWMO_INPUTAVAILABLE);
    }
    probe.Stop();
    std::cout << "{\"seconds\":" << seconds << ",\"packets\":" << probe.packets
      << ",\"keyDowns\":" << probe.keys << ",\"keyUps\":" << probe.keyUps
      << ",\"clicks\":" << probe.clicks << ",\"wheelPackets\":" << probe.wheels
      << ",\"counted\":" << probe.counts.snapshot().total << ",\"ignoredMouseMoves\":" << probe.ignoredMouseMoves
      << ",\"noDevicePackets\":" << probe.noDevicePackets << ",\"readErrors\":" << probe.errors
      << ",\"messageDelayMaxMs\":" << probe.maximumMessageDelayMs << ",\"messagesOver16ms\":" << probe.lateMessages
      << ",\"physicalInputConfirmed\":false,\"userDataAccessed\":false,\"lowLevelHooksInstalled\":false}\n";
    return probe.errors ? 1 : 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
