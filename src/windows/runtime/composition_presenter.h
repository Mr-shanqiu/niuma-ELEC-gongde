#pragma once

#include "d3d11_renderer.h"
#include "prepared_alpha_region.h"

namespace niuma::runtime {

struct CompositionTexture {
  std::uint64_t key = 0, version = 0;
  const PixelImage* pixels = nullptr;  // Read only for this upload call.
};
struct CompositionQuad {
  std::uint64_t textureKey = 0;
  Quad geometry;  // textureId is filled by the presenter.
  const PreparedAlphaMask* mask = nullptr;  // Owned by the current scene/text cache.
};
struct CompositionStats {
  std::uint64_t textureUploads = 0, framesPresented = 0, unchangedFrames = 0;
  std::uint64_t residentTextureBytes = 0, peakTextureBytes = 0;
  double lastRegionMs = 0, lastSubmitMs = 0;
};

// The UI owner supplies the latest scene, never a historical frame queue.
// No timer, asset IO, image decode, readback or automatic device retry lives here.
class CompositionPresenter final {
 public:
  static constexpr std::size_t kMaximumTextures = 10;
  static constexpr std::size_t kMaximumQuads = 12;
  static constexpr std::uint64_t kResidentTextureLimit = 26ULL * 1024 * 1024;
  // A failed replacement keeps the old set; temporary old+new uploads are bounded.
  static constexpr std::uint64_t kReplacementTextureLimit = 2 * kResidentTextureLimit;
  bool Initialize(HWND window, int width, int height, bool allowSoftwareForTest = false);
  bool Resize(int width, int height);
  bool SetTextures(const std::vector<CompositionTexture>& textures);
  bool DrawLatest(const std::vector<CompositionQuad>& quads);
  void Invalidate() noexcept { frameValid_ = false; }
  void Shutdown();
  const CompositionStats& Stats() const { return stats_; }
  const AdapterInfo& Adapter() const { return renderer_.Adapter(); }
  const RendererStats& BackendStats() const { return renderer_.Stats(); }
  HRESULT LastError() const { return error_; }
  const std::string& LastErrorMessage() const { return detail_; }
#ifdef NIUMA_COMPOSITION_DIAGNOSTICS
  // Tests only: called by the same owner; never used by the product drawing path.
  D3D11Renderer& DiagnosticRenderer() { return renderer_; }
#endif
 private:
  struct Uploaded {
    std::uint64_t key, version, bytes;
    std::uint32_t id, width, height;
  };
  bool Fail(HRESULT error, const std::string& detail);
  bool BackendFailure();
  D3D11Renderer renderer_;
  HWND window_ = nullptr;
  int width_ = 0, height_ = 0;
  std::vector<Uploaded> uploaded_;
  std::vector<Quad> previous_;
  bool frameValid_ = false;
  CompositionStats stats_;
  HRESULT error_ = S_OK;
  std::string detail_;
};

}  // namespace niuma::runtime
