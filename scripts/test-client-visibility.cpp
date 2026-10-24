#include "../src/client/core/visibility_state.h"
#include <iostream>
#include <stdexcept>
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while(false)
using namespace niuma::client::core;
int main() { try {
  VisibilityState state;
  state.manualHidden = true; state.fullscreen = true;
  CHECK(!state.hidden());  // Cannot strand the user without a recovery entry.
  state.recoveryAvailable = true; CHECK(state.hidden());
  state.fullscreen = false; CHECK(state.hidden());  // Manual hide survives fullscreen exit.
  state.manualHidden = false; CHECK(!state.hidden());
  state.fullscreen = true; CHECK(state.hidden());
  state.autoHideFullscreen = false; CHECK(!state.hidden());
  state.autoHideFullscreen = true; state.showDuringFullscreen = true; CHECK(!state.hidden());
  state.manualHidden = true; CHECK(state.hidden());
  CHECK(CoversFullscreenMonitor({-1920,0,0,1080},{-1920,0,0,1080}));
  CHECK(CoversFullscreenMonitor({0,-1,1920,1081},{0,0,1920,1080}));
  CHECK(!CoversFullscreenMonitor({0,0,1920,1040},{0,0,1920,1080}));
  CHECK(!CoversFullscreenMonitor({0,0,1920,1080},{-1920,0,0,1080}));
  CHECK(!CoversFullscreenMonitor({0,0,0,0},{0,0,0,0}));
  std::cout << "VISIBILITY_POLICY=PASS recovery/manual/auto/override/negative-monitor/taskbar\n";
  return 0;
} catch (const std::exception& e) { std::cerr<<e.what()<<"\n";return 1; } }
