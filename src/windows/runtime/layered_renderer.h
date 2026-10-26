#pragma once
#include "d3d11_renderer.h"
#include "../render_cache.h"
#include <unordered_map>

namespace niuma::runtime {
// Compatibility display only. The same scene/text owners prepare the pixels;
// no decoding, timers, GPU readbacks, disk access or historical frames here.
class LayeredRenderer final {
 public:
  bool Initialize(HWND window, int width, int height);
  bool Resize(int width, int height);
  std::uint32_t AddTexture(const PixelImage&, bool updatable);
  bool UpdateTexture(std::uint32_t, const PixelImage&);
  bool RemoveTexture(std::uint32_t);
  bool Draw(const std::vector<Quad>&);
  bool Present();
  bool Capture(PixelImage&);
  void Shutdown();
  const RendererStats& Stats() const { return stats_; }
  HRESULT LastError() const { return error_; }
  const std::string& LastErrorMessage() const { return detail_; }
 private:
  struct Texture {
    PixelImage pixels;
    std::unique_ptr<Gdiplus::Bitmap> bitmap;
    bool updatable = false;
  };
  bool Fail(HRESULT error, const char* detail);
  bool Ready();
  std::unique_ptr<Texture> Prepare(const PixelImage&, bool updatable);
  std::unordered_map<std::uint32_t, std::unique_ptr<Texture>> textures_;
  niuma::render::LayeredSurface surface_;
  HWND window_ = nullptr;
  DWORD owner_ = 0;
  std::uint32_t next_ = 1;
  bool pending_ = false;
  RendererStats stats_;
  HRESULT error_ = S_OK;
  std::string detail_;
};

// Keep the prepared-scene protocol and resource budgets for both backends.
// Normal builds select by OS/components; a forced path is test-only at callers.
class DisplayRenderer final {
 public:
  bool Initialize(HWND window, int width, int height, bool softwareTest = false,
                  bool layeredTest = false);
  bool Resize(int w, int h) { return layered_ ? legacy_.Resize(w,h) : modern_.Resize(w,h); }
  std::uint32_t AddTexture(const PixelImage& p, bool u = false) { return layered_ ? legacy_.AddTexture(p,u) : modern_.AddTexture(p,u); }
  bool UpdateTexture(std::uint32_t id, const PixelImage& p) { return layered_ ? legacy_.UpdateTexture(id,p) : modern_.UpdateTexture(id,p); }
  bool RemoveTexture(std::uint32_t id) { return layered_ ? legacy_.RemoveTexture(id) : modern_.RemoveTexture(id); }
  bool Draw(const std::vector<Quad>& q, bool present = true, const WeakAlphaOverrides* weak = nullptr) {
    return layered_ ? (legacy_.Draw(q) && (!present || legacy_.Present())) : modern_.Draw(q,present,weak);
  }
  bool Present() { return layered_ ? legacy_.Present() : modern_.Present(); }
  bool Capture(PixelImage& p) { return layered_ ? legacy_.Capture(p) : modern_.Capture(p); }
  void Shutdown() { legacy_.Shutdown(); modern_.Shutdown(); }
  bool layered() const { return layered_; }
  const RendererStats& Stats() const { return layered_ ? legacy_.Stats() : modern_.Stats(); }
  const AdapterInfo& Adapter() const { return layered_ ? compatibility_ : modern_.Adapter(); }
  HRESULT LastError() const { return layered_ ? legacy_.LastError() : modern_.LastError(); }
  const std::string& LastErrorMessage() const { return layered_ ? legacy_.LastErrorMessage() : modern_.LastErrorMessage(); }
  bool EnableDiagnosticGpuTiming() { return !layered_ && modern_.EnableDiagnosticGpuTiming(); }
  GpuTimingRead ReadDiagnosticGpuTiming(GpuTimingSample& s) { return layered_ ? GpuTimingRead::Disabled : modern_.ReadDiagnosticGpuTiming(s); }
  const GpuTimingStats& DiagnosticGpuTimingStats() const { return layered_ ? noTiming_ : modern_.DiagnosticGpuTimingStats(); }
  D3D11Renderer& ModernRendererForTest() { return modern_; }
 private:
  D3D11Renderer modern_;
  LayeredRenderer legacy_;
  bool layered_ = false;
  AdapterInfo compatibility_;
  GpuTimingStats noTiming_;
};
} // namespace niuma::runtime
