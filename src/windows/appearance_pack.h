#pragma once

#include <windows.h>
#include <gdiplus.h>
#include <objidl.h>

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
  std::vector<PackKeyframe> keyframes;
  PackImage image;
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
  PackImage preview;
  std::vector<PackLayer> layers;
};

class AppearanceCatalog {
 public:
  bool Reload(const std::wstring& directory, std::wstring* error);
  bool Install(const std::wstring& sourcePath,
               const std::wstring& directory,
               std::string* installedId,
               std::wstring* error);
  bool Delete(const std::string& id, std::wstring* error);
  AppearancePack* Find(const std::string& id) const;
  const std::vector<std::unique_ptr<AppearancePack>>& packs() const {
    return packs_;
  }

 private:
  std::vector<std::unique_ptr<AppearancePack>> packs_;
};

bool IsAppearancePackPath(const std::wstring& path);
bool RegisterAppearancePackAssociation(const std::wstring& executable,
                                       std::wstring* error);
void DrawAppearancePack(Gdiplus::Graphics& graphics,
                        const AppearancePack& pack,
                        float progress);

}  // namespace niuma
