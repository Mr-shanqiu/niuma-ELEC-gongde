#pragma once
#include "appearance_scene.h"
#include "composition_presenter.h"
#include "widget_text_cache.h"

namespace niuma::windows::runtime {
struct ClientDisplayState {
  niuma::client::core::AnimationAction action;
  niuma::runtime::WidgetTextInput text;
};
struct ClientDisplayFrameTiming {
  double sceneMs = 0, textMs = 0, texturesMs = 0, assemblyMs = 0, presenterMs = 0;
  niuma::runtime::WidgetTextTiming text;
};
// UI-owned composition of already prepared resources. Asset verification,
// decoding and alpha preparation happen on the asset worker, never here.
class ClientDisplay final {
 public:
  bool Initialize(HWND window, int width, int height, bool softwareForTest = false, bool layeredForTest = false);
  bool SetScene(std::unique_ptr<PreparedAppearanceScene>& candidate);
  bool DrawLatest(const ClientDisplayState& state, std::uint64_t now, int width, int height,
                  niuma::runtime::PixelImage* diagnosticCapture = nullptr);
  bool RecreateDevice();  // An explicit caller action; no hidden retry loop.
  void Invalidate() noexcept { presenter_.Invalidate(); player_.Invalidate(); }
  void Shutdown();
  bool layered() const { return presenter_.layered(); }
  bool ready() const { return initialized_; }
  const PreparedAppearanceScene* scene() const { return scene_.get(); }
  const niuma::runtime::CompositionStats& Stats() const { return presenter_.Stats(); }
  const niuma::runtime::RendererStats& BackendStats() const { return presenter_.BackendStats(); }
  bool EnableDiagnosticGpuTiming() { return presenter_.EnableDiagnosticGpuTiming(); }
  niuma::runtime::GpuTimingRead ReadDiagnosticGpuTiming(niuma::runtime::GpuTimingSample& sample) {
    return presenter_.ReadDiagnosticGpuTiming(sample);
  }
  const niuma::runtime::GpuTimingStats& DiagnosticGpuTimingStats() const {
    return presenter_.DiagnosticGpuTimingStats();
  }
  const niuma::runtime::WidgetTextCacheStats& TextStats() const { return text_.Stats(); }
  void EnableDiagnosticFrameTiming(bool enabled) {
    timingEnabled_ = enabled; timing_ = {}; text_.EnableDiagnosticTiming(enabled);
  }
  const ClientDisplayFrameTiming& DiagnosticFrameTiming() const { return timing_; }
  const niuma::runtime::AdapterInfo& Adapter() const { return presenter_.Adapter(); }
  const std::string& LastErrorMessage() const { return error_; }
#if defined(NIUMA_LEGACY_DIAGNOSTICS)
  HRESULT DiagnosticLastError() const { return presenter_.LastError(); }
#endif
 private:
  bool InstallTextures(const PreparedAppearanceScene* scene, std::uint64_t sceneVersion);
  HWND window_ = nullptr;
  int width_ = 0, height_ = 0;
  bool initialized_ = false, softwareForTest_ = false, layeredForTest_ = false;
  std::uint64_t sceneVersion_ = 0;
  std::unique_ptr<PreparedAppearanceScene> scene_;
  niuma::client::core::AnimationPlayer player_;
  niuma::runtime::CompositionPresenter presenter_;
  niuma::runtime::WidgetTextCache text_;
  std::string error_;
  bool timingEnabled_ = false;
  ClientDisplayFrameTiming timing_;
};
}  // namespace niuma::windows::runtime
