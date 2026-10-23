#pragma once

#include "../appearance_pack.h"
#include "../../client/core/animation_player.h"
#include "d3d11_renderer.h"
#include "prepared_alpha_region.h"

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace niuma::windows::runtime {

enum class AppearanceSceneKind { Package, Woodfish };
enum class AppearanceSceneStatus {
  Ready, Invalid, Changed, BudgetExceeded, ImageUnavailable, AlphaUnavailable
};

struct AppearanceSceneOptions {
  // CPU colors plus prepared alpha retained in the completed scene. This is
  // not a whole-process or GPU limit; the caller separately budgets old current
  // resources, pending results and uploaded GPU textures during a switch.
  size_t residentByteLimit = 24ULL * 1024 * 1024;
  // Bounds tracked source/color buffers and a conservative per-image reserve
  // for WIC conversion / PrepareAlphaMask scratch, not opaque codec overhead.
  size_t bridgePeakByteLimit = 96ULL * 1024 * 1024;
};

struct AppearanceSceneMemory {
  size_t sourceRgbaBytesAtEntry = 0;
  size_t sourceRasterBytesAtEntry = 0;
  size_t sourcePreviewBytesAtEntry = 0;
  size_t uploadPixelBytes = 0;
  size_t alphaMaskBytes = 0;
  size_t trackedPeakBytes = 0;
  size_t peakReservationBytes = 0;
  // Reuses the loader's separate estimate; it is not added to bridge peak
  // because package decode and the conversion phase occur consecutively.
  size_t loaderPreparationPeakBytes = 0;
  size_t residentBytes() const { return uploadPixelBytes + alphaMaskBytes; }
};

struct PreparedSceneImage {
  niuma::client::core::AnimationImageId id = 0;  // Local stable id, starting at 1.
  niuma::runtime::PixelImage pixels;
  niuma::runtime::PreparedAlphaMask alpha;
};

class PreparedAppearanceScene final {
 public:
  PreparedAppearanceScene() = default;
  PreparedAppearanceScene(const PreparedAppearanceScene&) = delete;
  PreparedAppearanceScene& operator=(const PreparedAppearanceScene&) = delete;
  PreparedAppearanceScene(PreparedAppearanceScene&&) noexcept = default;
  PreparedAppearanceScene& operator=(PreparedAppearanceScene&&) noexcept = default;

  AppearanceSceneKind kind = AppearanceSceneKind::Package;
  niuma::AppearanceResourceRequest source;
  std::vector<niuma::client::core::AppearanceLayer> layers;
  niuma::client::core::WoodfishImages woodfish;
  int plusY = 174;
  std::vector<PreparedSceneImage> images;
  AppearanceSceneMemory memory;

  bool Configure(niuma::client::core::AnimationPlayer& player) const;
  const PreparedSceneImage* Find(niuma::client::core::AnimationImageId id) const noexcept;
  bool HasColorPixels() const noexcept;
  // Optional after all AddTexture calls have succeeded. Masks and geometry stay
  // alive; a later device recovery must prepare colors again if released.
  void ReleaseColorPixels() noexcept;
};

// Production worker entry. COM and GDI+ must be initialized on the worker / for
// its lifetime. Reuses the actual package validator and retains full source
// pixels for conversion; it never accepts loose P0 source fixtures.
AppearanceSceneStatus PrepareAppearanceScene(
    const niuma::AppearanceResourceRequest& request,
    const AppearanceSceneOptions& options,
    std::unique_ptr<PreparedAppearanceScene>* output,
    std::wstring* error);

// Ownership-transfer adapter for a result of PrepareAppearanceAnimation with
// retainSourcePixels=true. This is not an import/verification API: the caller
// must not fabricate or mutate the validated result. Identity is rechecked.
// On return the supplied GDI resource is consumed, including on failure.
AppearanceSceneStatus ConvertPreparedAppearanceScene(
    std::unique_ptr<niuma::AppearancePack> pack,
    const niuma::AppearanceResourceRequest& expected,
    const AppearanceSceneOptions& options,
    std::unique_ptr<PreparedAppearanceScene>* output,
    std::wstring* error);

// Separate, explicit built-in entry. Inputs are the executable's trusted
// decoded woodfish/mallet resources, in premultiplied top-down BGRA; ownership
// moves into the scene. No file/import path and no support for loose packs.
// The caller's content fingerprint binds those embedded bytes and shadow v1.
AppearanceSceneStatus PrepareWoodfishScene(
    niuma::runtime::PixelImage body,
    niuma::runtime::PixelImage mallet,
    const std::string& contentFingerprint,
    const AppearanceSceneOptions& options,
    std::unique_ptr<PreparedAppearanceScene>* output,
    std::wstring* error);

}  // namespace niuma::windows::runtime
