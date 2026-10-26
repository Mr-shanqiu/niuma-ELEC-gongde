#pragma once
#include <cstdint>

namespace niuma::client::core {
// Display policy only. Never owns or pauses accounting, listeners, or saving.
struct VisibilityState {
  bool manualHidden = false;
  bool autoHideFullscreen = true;
  bool fullscreen = false;
  bool recoveryAvailable = false;
  bool showDuringFullscreen = false;  // Explicit Show lasts until fullscreen ends.
  bool hidden() const noexcept {
    return recoveryAvailable && (manualHidden || (autoHideFullscreen && fullscreen && !showDuringFullscreen));
  }
};
struct ScreenRect { std::int64_t left, top, right, bottom; };
inline bool CoversFullscreenMonitor(ScreenRect window, ScreenRect monitor) noexcept {
  if (monitor.right <= monitor.left || monitor.bottom <= monitor.top ||
      window.right <= window.left || window.bottom <= window.top) return false;
  // Fullscreen content may extend beyond a monitor (borderless applications,
  // overscan). Coverage matters; matching all four edges misses those windows.
  return window.left <= monitor.left + 1 && window.top <= monitor.top + 1 &&
      window.right >= monitor.right - 1 && window.bottom >= monitor.bottom - 1;
}
}  // namespace niuma::client::core
