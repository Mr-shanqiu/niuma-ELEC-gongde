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
  const auto near = [](std::int64_t a, std::int64_t b) { return a >= b - 1 && a <= b + 1; };
  return near(window.left, monitor.left) && near(window.top, monitor.top) &&
      near(window.right, monitor.right) && near(window.bottom, monitor.bottom);
}
}  // namespace niuma::client::core
