#pragma once

#include "d3d11_renderer.h"
#include "prepared_alpha_region.h"
#include "native_region_bands.h"

namespace niuma::runtime {

struct CompositionTexture {
  std::uint64_t key = 0, version = 0;
  const PixelImage* pixels = nullptr;  // Read only for this upload call.
  bool reusable = false; // Frequent text only; static artwork remains immutable.
};
struct CompositionQuad {
  std::uint64_t textureKey = 0;
  Quad geometry;  // textureId is filled by the presenter.
  const PreparedAlphaMask* mask = nullptr;  // Owned by the current scene/text cache.
};
struct CompositionStats {
  std::uint64_t textureUploads = 0, framesPresented = 0, unchangedFrames = 0;
  std::uint64_t residentTextureBytes = 0, peakTextureBytes = 0;
  std::uint64_t spareTextureBytes = 0;
  std::size_t spareTextureCount = 0;
  double lastRegionMs = 0, lastSubmitMs = 0;
  PreparedAlphaRegionStats lastRegionDetails;
  double lastRegionInstallWallMs = 0;
  std::uint64_t nativeRegionInstalls = 0, nativeRegionReuses = 0;
  std::size_t retainedRegionBytes = 0;
  std::size_t retainedBandBytes = 0, retainedBandHandles = 0;
  std::uint64_t nativeBandsCreated = 0, nativeBandsReused = 0, nativeBandFallbacks = 0;
  // CPU-side elapsed calls, not CPU execution time. Present and explicit
  // readback are separated so synchronization cannot masquerade as CPU work.
  double lastDrawSubmitWallMs = 0, lastPresentWallMs = 0, lastReadbackWallMs = 0;
};

// The UI owner supplies the latest scene, never a historical frame queue.
// No timer, asset IO, image decode, readback or automatic device retry lives here.
class CompositionPresenter final {
 public:
  static constexpr std::size_t kMaximumTextures = 10;
  static constexpr std::size_t kMaximumQuads = 12;
  // One installed coverage only, no historical scenes or native handles.
  static constexpr std::size_t kInstalledRegionByteLimit = 2 * 1024 * 1024;
  static constexpr std::uint64_t kResidentTextureLimit = 26ULL * 1024 * 1024;
  // A failed replacement keeps the old set; temporary old+new uploads are bounded.
  static constexpr std::uint64_t kReplacementTextureLimit = 2 * kResidentTextureLimit;
  static constexpr std::size_t kSpareTextureCountLimit = 3;
  static constexpr std::uint64_t kSpareTextureByteLimit = 2ULL * 1024 * 1024;
  bool Initialize(HWND window, int width, int height, bool allowSoftwareForTest = false);
  bool Resize(int width, int height);
  bool SetTextures(const std::vector<CompositionTexture>& textures);
  // A non-null capture is an explicit test-only readback before Present.
  // The normal client never supplies it; no readback is retained or automatic.
  bool DrawLatest(const std::vector<CompositionQuad>& quads, PixelImage* diagnosticCapture = nullptr);
  void Invalidate() noexcept;
  void Shutdown();
  const CompositionStats& Stats() const { return stats_; }
  const AdapterInfo& Adapter() const { return renderer_.Adapter(); }
  const RendererStats& BackendStats() const { return renderer_.Stats(); }
  bool EnableDiagnosticGpuTiming() { return renderer_.EnableDiagnosticGpuTiming(); }
  GpuTimingRead ReadDiagnosticGpuTiming(GpuTimingSample& sample) {
    return renderer_.ReadDiagnosticGpuTiming(sample);
  }
  const GpuTimingStats& DiagnosticGpuTimingStats() const { return renderer_.DiagnosticGpuTimingStats(); }
  HRESULT LastError() const { return error_; }
  const std::string& LastErrorMessage() const { return detail_; }
#ifdef NIUMA_COMPOSITION_DIAGNOSTICS
  // Tests only: called by the same owner; never used by the product drawing path.
  D3D11Renderer& DiagnosticRenderer() { return renderer_; }
#endif
 private:
  friend struct CompositionPresenterTestAccess;
  struct Uploaded {
    std::uint64_t key, version, bytes;
    std::uint32_t id, width, height;
    bool reusable;
  };
  bool Fail(HRESULT error, const std::string& detail);
  bool BackendFailure();
  void ForgetInstalledRegion() noexcept;
  void UpdateSpareStats() noexcept;
  void DropSpare(std::size_t index);
  D3D11Renderer renderer_;
  HWND window_ = nullptr;
  int width_ = 0, height_ = 0;
  std::vector<Uploaded> uploaded_;
  std::vector<Uploaded> spares_; // At most one inactive buffer per retained key.
  std::vector<Quad> previous_;
  bool frameValid_ = false;
  AlphaRegionResult installedRaster_;
  NativeRegionBands nativeBands_;
  CompositionStats stats_;
  HRESULT error_ = S_OK;
  std::string detail_;
};

}  // namespace niuma::runtime
