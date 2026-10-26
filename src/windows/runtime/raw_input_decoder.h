#pragma once
#include "../../client/core/input_state.h"
#include <windows.h>
#include <array>

namespace niuma::windows::runtime {
// Prototype adapter: retains operation categories only, never key values,
// coordinates, device identities or window/application information.
struct DecodedRawInput {
  std::array<client::core::InputKind, 7> events{};
  unsigned count = 0;
  // A null device cannot be used as evidence of physical reminder activity.
  // A non-null handle also needs real-input validation before production use.
  bool hasDevice = false;
};
inline DecodedRawInput DecodeRawInput(const RAWINPUT& packet) noexcept {
  using client::core::InputKind;
  DecodedRawInput result;
  result.hasDevice = packet.header.hDevice != nullptr;
  if (packet.header.dwType == RIM_TYPEKEYBOARD) {
    const auto& keyboard = packet.data.keyboard;
    if (keyboard.VKey == 0xff || keyboard.MakeCode == KEYBOARD_OVERRUN_MAKE_CODE) return result;
    result.events[result.count++] = (keyboard.Flags & RI_KEY_BREAK) ? InputKind::KeyUp : InputKind::KeyDown;
  } else if (packet.header.dwType == RIM_TYPEMOUSE) {
    const auto flags = packet.data.mouse.usButtonFlags;
    for (const USHORT button : {RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN,
         RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_5_DOWN})
      if (flags & button) result.events[result.count++] = InputKind::Click;
    if (flags & RI_MOUSE_WHEEL) result.events[result.count++] = InputKind::Scroll;
    if (flags & RI_MOUSE_HWHEEL) result.events[result.count++] = InputKind::Scroll;
  }
  return result;
}
}  // namespace niuma::windows::runtime
