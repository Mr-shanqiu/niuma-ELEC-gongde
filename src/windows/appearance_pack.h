#pragma once

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include <cstdint>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace niuma {

struct PackKeyframe {
  float t = 0.0f;
  float x = 0.0f;
  float y = 0.0f;
  float rotation = 0.0f;
  float scale = 1.0f;
  float scaleY = 1.0f;
  float alpha = 1.0f;
};

struct PackImage {
  IStream* stream = nullptr;
  std::unique_ptr<Gdiplus::Image> image;

  PackImage() = default;
  ~PackImage();
  PackImage(const PackImage&) = delete;
  PackImage& operator=(const PackImage&) = delete;
  PackImage(PackImage&& other) noexcept;
  PackImage& operator=(PackImage&& other) noexcept;
};

struct PackLayer {
  std::string imageName;
  float x = 0.0f;
  float y = 0.0f;
  float width = 0.0f;
  float height = 0.0f;
  float anchorX = 0.5f;
  float anchorY = 0.5f;
  bool smoothInterpolation = false;
  std::vector<PackKeyframe> keyframes;
  UINT sourcePixelWidth = 0;
  UINT sourcePixelHeight = 0;
  // Prepared images are readable Bitmap32bppARGB; rasters use 32bppPARGB.
  PackImage image;
  PackImage raster;
};

struct AppearancePack {
  std::string id;
  std::string version;
  std::wstring nameZh;
  std::wstring nameEn;
  std::wstring author;
  std::wstring publisher;
  std::string reviewId;
  int plusY = 174;
  std::wstring sourcePath;
  // Hash of the validated manifest and PNG content, including unsigned packs.
  std::string contentFingerprint;
  PackImage preview;
  std::vector<PackLayer> layers;
};

// Copy this value on the catalog's owner thread before starting worker work.
// Workers never retain a pointer into AppearanceCatalog.
struct AppearanceResourceRequest {
  std::wstring sourcePath;
  std::string id;
  std::string contentFingerprint;
};

enum class AppearancePreparationStatus { Ready, Invalid, Changed, BudgetExceeded };

struct AppearanceResourceMemory {
  size_t sourceRgbaBytes = 0;
  size_t compressedBytes = 0;
  size_t rasterBytes = 0;
  size_t thumbnailBytes = 0;
  // Conservative peak: archive PNG bytes + retained images + current decode.
  size_t preparationPeakBytes = 0;
  bool rasterFallback = false;
  size_t residentBytes() const {
    return sourceRgbaBytes + compressedBytes + rasterBytes + thumbnailBytes;
  }
};

struct AppearanceAnimationOptions {
  float pixelDensity = 1.0f;
  size_t byteLimit = 24ULL * 1024ULL * 1024ULL;
  bool retainSourcePixels = false;
  bool prepareDisplayRaster = true;
};

struct AppearanceThumbnail {
  AppearanceResourceRequest source;
  PackImage image;
  AppearanceResourceMemory memory;
};

AppearanceResourceRequest RequestAppearanceResources(const AppearancePack& pack);
// Fully validates again and prepares pixels before transferring exclusive
// ownership to the UI. No catalog mutation and no global rendering cache.
AppearancePreparationStatus PrepareAppearanceAnimation(
    const AppearanceResourceRequest& request,
    const AppearanceAnimationOptions& options,
    std::unique_ptr<AppearancePack>* output,
    AppearanceResourceMemory* memory,
    std::wstring* error);
AppearancePreparationStatus PrepareAppearanceThumbnail(
    const AppearanceResourceRequest& request,
    std::unique_ptr<AppearanceThumbnail>* output,
    std::wstring* error);

// UI-owned LRU. Entries are tied to validated content, not merely package id.
class AppearanceThumbnailCache {
 public:
  explicit AppearanceThumbnailCache(size_t byteLimit = 12ULL * 240 * 250 * 4,
                                    size_t entryLimit = 12);
  const AppearanceThumbnail* Find(const AppearanceResourceRequest& request);
  bool Put(std::unique_ptr<AppearanceThumbnail> thumbnail);
  void Clear();
  size_t bytes() const { return bytes_; }
  size_t size() const { return entries_.size(); }

 private:
  size_t byteLimit_, entryLimit_, bytes_ = 0;
  std::vector<std::unique_ptr<AppearanceThumbnail>> entries_;
};

class AppearanceCatalog {
 public:
  bool Reload(const std::wstring& directory, std::wstring* error);
  // Opt this catalog into metadata-only reloads, including subsequent Install.
  // Legacy Reload remains drawable until the caller explicitly opts in.
  bool ReloadMetadata(const std::wstring& directory, std::wstring* error);
  bool Install(const std::wstring& sourcePath,
               const std::wstring& directory,
               std::string* installedId,
               std::wstring* error,
               bool* alreadyInstalled = nullptr);
  bool InstallBatch(const std::wstring& sourcePath,
                    const std::wstring& directory,
                    std::vector<std::string>* installedIds,
                    std::wstring* error,
                    std::vector<std::string>* alreadyInstalledIds = nullptr);
  bool Delete(const std::string& id, std::wstring* error);
  AppearancePack* Find(const std::string& id) const;
  const std::vector<std::unique_ptr<AppearancePack>>& packs() const {
    return packs_;
  }

 private:
  std::vector<std::unique_ptr<AppearancePack>> packs_;
  bool metadataOnly_ = false;
};

bool IsAppearancePackPath(const std::wstring& path);
bool IsAppearanceBatchPath(const std::wstring& path);
bool RegisterPackFileAssociations(const std::wstring& executable,
                                  std::wstring* error);
// Returns false for metadata/unprepared resources or a drawing error. Never
// reads files, decodes PNGs or allocates an image/raster inside this function.
bool DrawAppearancePack(Gdiplus::Graphics& graphics,
                        const AppearancePack& pack,
                        float progress);
std::uint64_t AppearanceRenderGeneration();
void ClearAppearanceRenderCache();

}  // namespace niuma
