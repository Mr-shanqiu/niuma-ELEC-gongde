#pragma once
// Private entry probe / exact-child driver only. No normal client handler.
namespace niuma::entry_probe {
constexpr unsigned kFrameControlMessage = WM_APP + 73;
constexpr WPARAM kStartFrames = 1, kStopFrames = 2;
constexpr LRESULT kFrameControlAck = 0x4e46524d;
}
