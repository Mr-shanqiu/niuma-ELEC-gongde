#include "appearance_scene.h"

#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstring>
#include <cmath>
#include <limits>
#include <map>
#include <new>
#include <utility>

namespace niuma::windows::runtime {
namespace {
using niuma::client::core::AnimationImageId;
using niuma::runtime::PixelImage;
using Microsoft::WRL::ComPtr;
constexpr size_t kMaximumDimension = 2048;
constexpr size_t kMaskScratchMaximum = 32ULL * 1024 * 1024;

AppearanceSceneStatus Fail(AppearanceSceneStatus status, const wchar_t* message,
                          std::wstring* error) {
  if (error) *error = message;
  return status;
}
bool Fingerprint(const std::string& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}
size_t BitmapBytes(const niuma::PackImage& image) {
  if (!image.image) return 0;
  return static_cast<size_t>(image.image->GetWidth()) * image.image->GetHeight() * 4;
}
bool ValidPixels(const PixelImage& image, bool checkPremultiplied) {
  if (!image.width || !image.height || image.width > kMaximumDimension ||
      image.height > kMaximumDimension || image.strideBytes < image.width * 4 ||
      static_cast<std::uint64_t>(image.strideBytes) * image.height > image.bgraPremultiplied.size())
    return false;
  if (checkPremultiplied) for (std::uint32_t y = 0; y < image.height; ++y) {
    const auto* row = image.bgraPremultiplied.data() + static_cast<size_t>(y) * image.strideBytes;
    for (std::uint32_t x = 0; x < image.width; ++x)
      if (row[x * 4] > row[x * 4 + 3] || row[x * 4 + 1] > row[x * 4 + 3] ||
          row[x * 4 + 2] > row[x * 4 + 3]) return false;
  }
  return true;
}
struct Budget {
  const AppearanceSceneOptions& options;
  AppearanceSceneMemory& memory;
  size_t sources = 0;
  bool Reserve(size_t knownAdditional = 0, size_t scratch = 0) {
    const auto limit = options.bridgePeakByteLimit;
    const auto resident = memory.residentBytes();
    if (sources > limit || resident > limit - sources ||
        knownAdditional > limit - sources - resident) return false;
    const auto tracked = sources + resident + knownAdditional;
    if (scratch > limit - tracked) return false;
    memory.trackedPeakBytes = std::max(memory.trackedPeakBytes, tracked);
    memory.peakReservationBytes = std::max(memory.peakReservationBytes, tracked + scratch);
    return true;
  }
};

// PrepareAlphaMask has fixed source-run / rectangle guards. For this bridge's
// <=2048x2048 textures, 32 MiB conservatively covers its temporary rows, two
// rectangle sets, alpha bytes and merge vectors. Small textures use a tighter
// bound. This is a reservation, never reported as measured process memory.
size_t AlphaScratch(const PixelImage& image) {
  return std::min(kMaskScratchMaximum,
      static_cast<size_t>(image.width) * image.height * 64 + image.height * 64 + 16384);
}
AppearanceSceneStatus PrepareMask(PreparedSceneImage& image, Budget& budget,
                                 std::wstring* error, bool fading = false) {
  const size_t alphaMinimum = static_cast<size_t>(image.pixels.width) * image.pixels.height;
  const auto resident = budget.memory.residentBytes();
  if (resident > budget.options.residentByteLimit ||
      alphaMinimum > budget.options.residentByteLimit - resident ||
      !budget.Reserve(0, AlphaScratch(image.pixels)))
    return Fail(AppearanceSceneStatus::BudgetExceeded,
        L"形象透明区域超过当前资源预算，未切换形象。", error);
  image.alpha = niuma::runtime::PrepareAlphaMask({image.pixels.bgraPremultiplied.data(),
      image.pixels.bgraPremultiplied.size(), image.pixels.width, image.pixels.height,
      image.pixels.strideBytes}, fading, budget.options.residentByteLimit-resident);
  if (!image.alpha.success)
    return Fail(image.alpha.error.find("budget") != std::string::npos
        ? AppearanceSceneStatus::BudgetExceeded : AppearanceSceneStatus::AlphaUnavailable,
        L"无法在当前预算内完整准备形象透明区域，未切换形象。", error);
  const auto bytes = image.alpha.storageBytes;
  if (bytes > budget.options.residentByteLimit - resident)
    return Fail(AppearanceSceneStatus::BudgetExceeded,
        L"形象透明区域超过当前资源预算，未切换形象。", error);
  image.alpha.storageBytes = bytes;
  budget.memory.alphaMaskBytes += bytes;
  return budget.Reserve() ? AppearanceSceneStatus::Ready :
      Fail(AppearanceSceneStatus::BudgetExceeded, L"形象准备峰值超过资源预算。", error);
}

// Exactly the P0 color policy: WIC converts straight top-down BGRA to PBGRA,
// without dithering or color-space conversion. Never decode a PNG in this step.
bool ConvertPixels(const niuma::PackImage& source, PixelImage& output) {
  auto* bitmap = static_cast<Gdiplus::Bitmap*>(source.image.get());
  const auto width = bitmap->GetWidth(), height = bitmap->GetHeight();
  const size_t bytes = static_cast<size_t>(width) * height * 4;
  if (bitmap->GetPixelFormat() == PixelFormat32bppPARGB) {
    Gdiplus::Rect area(0,0,width,height);
    Gdiplus::BitmapData data{};
    if (bitmap->LockBits(&area,Gdiplus::ImageLockModeRead,PixelFormat32bppPARGB,&data) != Gdiplus::Ok) return false;
    output.width=width; output.height=height; output.strideBytes=width*4;
    output.bgraPremultiplied.resize(bytes);
    for(UINT y=0;y<height;++y) std::memcpy(output.bgraPremultiplied.data()+static_cast<size_t>(y)*width*4,
        static_cast<const BYTE*>(data.Scan0)+static_cast<std::ptrdiff_t>(y)*data.Stride,static_cast<size_t>(width)*4);
    return bitmap->UnlockBits(&data)==Gdiplus::Ok;
  }
  std::vector<std::uint8_t> straight(bytes);
  Gdiplus::Rect area(0, 0, width, height);
  Gdiplus::BitmapData data{};
  if (bitmap->LockBits(&area, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &data) != Gdiplus::Ok)
    return false;
  for (UINT y = 0; y < height; ++y)
    std::memcpy(straight.data() + static_cast<size_t>(y) * width * 4,
        static_cast<const std::uint8_t*>(data.Scan0) + static_cast<std::ptrdiff_t>(y) * data.Stride,
        static_cast<size_t>(width) * 4);
  if (bitmap->UnlockBits(&data) != Gdiplus::Ok) return false;
  ComPtr<IWICImagingFactory> factory;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory1, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(factory.GetAddressOf())))) return false;
  ComPtr<IWICBitmap> input;
  if (FAILED(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA,
      width * 4, static_cast<UINT>(bytes), straight.data(), input.GetAddressOf()))) return false;
  ComPtr<IWICFormatConverter> converter;
  if (FAILED(factory->CreateFormatConverter(converter.GetAddressOf())) ||
      FAILED(converter->Initialize(input.Get(), GUID_WICPixelFormat32bppPBGRA,
          WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
  output.width = width;
  output.height = height;
  output.strideBytes = width * 4;
  output.bgraPremultiplied.resize(bytes);
  return SUCCEEDED(converter->CopyPixels(nullptr, output.strideBytes, static_cast<UINT>(bytes),
      output.bgraPremultiplied.data()));
}

bool FilterPixels(const niuma::PackImage& source, UINT width, UINT height, PixelImage& output) {
  if (width==source.image->GetWidth() && height==source.image->GetHeight())
    return ConvertPixels(source,output);
  niuma::PackImage filtered;
  filtered.image=std::make_unique<Gdiplus::Bitmap>(width,height,PixelFormat32bppPARGB);
  if(filtered.image->GetLastStatus()!=Gdiplus::Ok) return false;
  {
    Gdiplus::Graphics graphics(filtered.image.get());
    if(graphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy)!=Gdiplus::Ok ||
        graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic)!=Gdiplus::Ok ||
        graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality)!=Gdiplus::Ok ||
        graphics.DrawImage(source.image.get(),Gdiplus::Rect(0,0,width,height),0,0,
            source.image->GetWidth(),source.image->GetHeight(),Gdiplus::UnitPixel)!=Gdiplus::Ok) return false;
  }
  return ConvertPixels(filtered,output);
}
bool FilterBuiltin(PixelImage& pixels, UINT width, UINT height) {
  width=std::min(width,pixels.width); height=std::min(height,pixels.height);
  if(!width || !height) return false;
  if(width==pixels.width && height==pixels.height) return true;
  niuma::PackImage source;
  source.image=std::make_unique<Gdiplus::Bitmap>(pixels.width,pixels.height,pixels.strideBytes,
      PixelFormat32bppPARGB,pixels.bgraPremultiplied.data());
  PixelImage output;
  if(source.image->GetLastStatus()!=Gdiplus::Ok || !FilterPixels(source,width,height,output)) return false;
  source.image.reset();
  pixels=std::move(output);
  return true;
}
PixelImage Shadow() {
  PixelImage image;
  image.width = 320; image.height = 32; image.strideBytes = 320 * 4;
  image.bgraPremultiplied.resize(static_cast<size_t>(image.strideBytes) * image.height);
  for (std::uint32_t y = 0; y < image.height; ++y) for (std::uint32_t x = 0; x < image.width; ++x) {
    unsigned coverage = 0;
    for (unsigned sy = 0; sy < 4; ++sy) for (unsigned sx = 0; sx < 4; ++sx) {
      const float nx = (x + (sx + 0.5f) / 4.0f - 160.0f) / 160.0f;
      const float ny = (y + (sy + 0.5f) / 4.0f - 16.0f) / 16.0f;
      if (nx * nx + ny * ny <= 1) ++coverage;
    }
    image.bgraPremultiplied[static_cast<size_t>(y) * image.strideBytes + x * 4 + 3] =
        static_cast<std::uint8_t>((64 * coverage + 8) / 16);
  }
  return image;
}
bool OptionsValid(const AppearanceSceneOptions& options) {
  return options.residentByteLimit > 0 && options.bridgePeakByteLimit > 0 &&
      std::isfinite(options.pixelDensity) && options.pixelDensity>0 && options.pixelDensity<=8;
}
}  // namespace

bool PreparedAppearanceScene::Configure(niuma::client::core::AnimationPlayer& player) const {
  return kind == AppearanceSceneKind::Woodfish ? player.SetWoodfish(woodfish)
                                             : player.SetAppearance(layers, plusY);
}
const PreparedSceneImage* PreparedAppearanceScene::Find(AnimationImageId id) const noexcept {
  for (const auto& image : images) if (image.id == id) return &image;
  return nullptr;
}
bool PreparedAppearanceScene::HasColorPixels() const noexcept {
  return !images.empty() && std::all_of(images.begin(), images.end(),
      [](const auto& image) { return ValidPixels(image.pixels, false); });
}
void PreparedAppearanceScene::ReleaseColorPixels() noexcept {
  for (auto& image : images) std::vector<std::uint8_t>().swap(image.pixels.bgraPremultiplied);
  memory.uploadPixelBytes = 0;
}

AppearanceSceneStatus ConvertPreparedAppearanceScene(std::unique_ptr<niuma::AppearancePack> pack,
    const niuma::AppearanceResourceRequest& expected, const AppearanceSceneOptions& options,
    std::unique_ptr<PreparedAppearanceScene>* output, std::wstring* error) {
  if (output) output->reset();
  if (error) error->clear();
  if (!output || !pack || !OptionsValid(options) || expected.sourcePath.empty() ||
      expected.id.empty() || !Fingerprint(expected.contentFingerprint))
    return Fail(AppearanceSceneStatus::Invalid, L"形象资源请求不完整。", error);
  if (pack->sourcePath != expected.sourcePath || pack->id != expected.id ||
      pack->contentFingerprint != expected.contentFingerprint)
    return Fail(AppearanceSceneStatus::Changed, L"形象资源版本已变化，请重新读取。", error);
  if (pack->layers.empty() || pack->layers.size() > niuma::client::core::AnimationPlayer::kMaximumLayers)
    return Fail(AppearanceSceneStatus::Invalid, L"形象图层不完整。", error);
  try {
    auto scene = std::make_unique<PreparedAppearanceScene>();
    scene->source = expected;
    scene->pixelDensity = options.pixelDensity;
    scene->plusY = pack->plusY;
    scene->images.reserve(pack->layers.size());
    scene->layers.reserve(pack->layers.size());
    std::map<std::string, AnimationImageId> ids;
    std::map<std::string,std::pair<UINT,UINT>> dimensions;
    for (const auto& layer : pack->layers) {
      if (layer.imageName.empty() || !layer.image.image || layer.image.stream ||
          layer.image.image->GetPixelFormat() != PixelFormat32bppARGB ||
          layer.sourcePixelWidth == 0 || layer.sourcePixelHeight == 0 ||
          layer.sourcePixelWidth > kMaximumDimension || layer.sourcePixelHeight > kMaximumDimension ||
          layer.image.image->GetWidth() != layer.sourcePixelWidth ||
          layer.image.image->GetHeight() != layer.sourcePixelHeight || layer.keyframes.size() > 8)
        return Fail(AppearanceSceneStatus::ImageUnavailable,
            L"形象未保留完整原始像素，请在后台重新准备。", error);
      const auto inserted = ids.emplace(layer.imageName, ids.size() + 1);
      float maximumX=1, maximumY=1;
      for(const auto& key:layer.keyframes) {
        maximumX=std::max(maximumX,std::abs(key.scale));
        maximumY=std::max(maximumY,std::abs(key.scale*key.scaleY));
      }
      auto& desired=dimensions[layer.imageName];
      desired.first=std::max(desired.first,static_cast<UINT>(std::min(
          std::ceil(layer.width*options.pixelDensity*maximumX*2),static_cast<float>(layer.sourcePixelWidth))));
      desired.second=std::max(desired.second,static_cast<UINT>(std::min(
          std::ceil(layer.height*options.pixelDensity*maximumY*2),static_cast<float>(layer.sourcePixelHeight))));
      niuma::client::core::AppearanceLayer translated;
      translated.image = inserted.first->second;
      translated.frame = {layer.x, layer.y, layer.width, layer.height};
      translated.anchor = {layer.anchorX, layer.anchorY};
      translated.smoothInterpolation = layer.smoothInterpolation;
      for (const auto& key : layer.keyframes)
        translated.keyframes.push_back({key.t, key.x, key.y, key.rotation,
            key.scale, key.scaleY, key.alpha});
      scene->layers.push_back(std::move(translated));
      scene->memory.sourceRgbaBytesAtEntry += BitmapBytes(layer.image);
      scene->memory.sourceRasterBytesAtEntry += BitmapBytes(layer.raster);
    }
    scene->memory.sourcePreviewBytesAtEntry = BitmapBytes(pack->preview);
    niuma::client::core::AnimationPlayer validation;
    if (!scene->Configure(validation))
      return Fail(AppearanceSceneStatus::Invalid, L"形象动作结构不完整，未切换形象。", error);
    Budget budget{options, scene->memory, scene->memory.sourceRgbaBytesAtEntry +
        scene->memory.sourceRasterBytesAtEntry + scene->memory.sourcePreviewBytesAtEntry};
    if (!budget.Reserve())
      return Fail(AppearanceSceneStatus::BudgetExceeded, L"原始形象资源超过准备预算。", error);
    pack->preview = {};
    for (auto& layer : pack->layers) layer.raster = {};
    budget.sources = scene->memory.sourceRgbaBytesAtEntry;
    for (auto& layer : pack->layers) {
      const auto id = ids.at(layer.imageName);
      const auto sourceBytes = BitmapBytes(layer.image);
      if (const auto* duplicate = scene->Find(id)) {
        if (duplicate->pixels.width != dimensions.at(layer.imageName).first ||
            duplicate->pixels.height != dimensions.at(layer.imageName).second)
          return Fail(AppearanceSceneStatus::Invalid, L"相同图层资源尺寸不一致。", error);
        layer.image = {};
        budget.sources -= sourceBytes;
        continue;
      }
      if (scene->memory.residentBytes() > options.residentByteLimit ||
          sourceBytes > options.residentByteLimit - scene->memory.residentBytes() ||
          !budget.Reserve(sourceBytes * 2, sourceBytes))
        return Fail(AppearanceSceneStatus::BudgetExceeded, L"形象像素转换超过资源预算。", error);
      PreparedSceneImage image;
      image.id = id;
      const auto target=dimensions.at(layer.imageName);
      if (!FilterPixels(layer.image, target.first, target.second, image.pixels))
        return Fail(AppearanceSceneStatus::ImageUnavailable, L"无法准备形象显示像素。", error);
      scene->memory.uploadPixelBytes += image.pixels.bgraPremultiplied.capacity();
      layer.image = {};
      budget.sources -= sourceBytes;
      const bool fading=std::any_of(scene->layers.begin(),scene->layers.end(),[&](const auto& item) {
        return item.image==id && std::any_of(item.keyframes.begin(),item.keyframes.end(),
            [](const auto& key) { return key.alpha<1; });
      });
      const auto status = PrepareMask(image, budget, error, fading);
      if (status != AppearanceSceneStatus::Ready) return status;
      scene->images.push_back(std::move(image));
    }
    pack.reset();
    *output = std::move(scene);
    return AppearanceSceneStatus::Ready;
  } catch (const std::bad_alloc&) {
    return Fail(AppearanceSceneStatus::BudgetExceeded, L"内存不足，未能准备形象显示资源。", error);
  }
}

AppearanceSceneStatus PrepareAppearanceScene(const niuma::AppearanceResourceRequest& request,
    const AppearanceSceneOptions& options, std::unique_ptr<PreparedAppearanceScene>* output,
    std::wstring* error) {
  if (output) output->reset();
  if (!output || !OptionsValid(options))
    return Fail(AppearanceSceneStatus::Invalid, L"形象资源请求不完整。", error);
  niuma::AppearanceAnimationOptions loadOptions;
  loadOptions.retainSourcePixels = true;
  loadOptions.prepareDisplayRaster = false;
  loadOptions.pixelDensity = options.pixelDensity;
  loadOptions.byteLimit = std::min(options.residentByteLimit, options.bridgePeakByteLimit);
  niuma::AppearanceResourceMemory loadMemory;
  std::unique_ptr<niuma::AppearancePack> pack;
  const auto loaded = niuma::PrepareAppearanceAnimation(request, loadOptions, &pack, &loadMemory, error);
  if (loaded == niuma::AppearancePreparationStatus::Changed) return AppearanceSceneStatus::Changed;
  if (loaded == niuma::AppearancePreparationStatus::BudgetExceeded) return AppearanceSceneStatus::BudgetExceeded;
  if (loaded != niuma::AppearancePreparationStatus::Ready) return AppearanceSceneStatus::Invalid;
  const auto status = ConvertPreparedAppearanceScene(std::move(pack), request, options, output, error);
  if (status == AppearanceSceneStatus::Ready)
    (*output)->memory.loaderPreparationPeakBytes = loadMemory.preparationPeakBytes;
  return status;
}

AppearanceSceneStatus PrepareWoodfishScene(PixelImage body, PixelImage mallet,
    const std::string& contentFingerprint, const AppearanceSceneOptions& options,
    std::unique_ptr<PreparedAppearanceScene>* output, std::wstring* error) {
  if (output) output->reset();
  if (error) error->clear();
  if (!output || !OptionsValid(options) || !Fingerprint(contentFingerprint) ||
      !ValidPixels(body, true) || !ValidPixels(mallet, true) || mallet.width <= 108)
    return Fail(AppearanceSceneStatus::Invalid, L"内置木鱼资源不完整。", error);
  try {
    const auto originalMalletWidth=mallet.width;
    const auto originalBytes=body.bgraPremultiplied.capacity()+mallet.bgraPremultiplied.capacity();
    if(originalBytes>options.bridgePeakByteLimit/3)
      return Fail(AppearanceSceneStatus::BudgetExceeded,L"内置木鱼准备峰值超过当前预算。",error);
    const float density=options.pixelDensity*.88f*2;
    const auto malletWidth=static_cast<UINT>(std::ceil(std::max(
        266*density*originalMalletWidth/(originalMalletWidth-108),
        60*density*originalMalletWidth/std::min(145u,originalMalletWidth))));
    if(!FilterBuiltin(body,static_cast<UINT>(std::ceil(214*density)),static_cast<UINT>(std::ceil(129*density))) ||
        !FilterBuiltin(mallet,malletWidth,static_cast<UINT>(std::ceil(54*density))))
      return Fail(AppearanceSceneStatus::ImageUnavailable,L"内置木鱼显示图片无法准备。",error);
    auto scene = std::make_unique<PreparedAppearanceScene>();
    scene->kind = AppearanceSceneKind::Woodfish;
    scene->pixelDensity = options.pixelDensity;
    scene->memory.sourceRgbaBytesAtEntry=originalBytes;
    scene->memory.trackedPeakBytes=originalBytes*3;
    scene->memory.peakReservationBytes=originalBytes*3;
    scene->source = {L"", "builtin.woodfish", contentFingerprint};
    scene->images.reserve(3);
    scene->memory.uploadPixelBytes = body.bgraPremultiplied.capacity() + mallet.bgraPremultiplied.capacity();
    Budget budget{options, scene->memory};
    constexpr size_t shadowBytes = 320 * 32 * 4;
    if (scene->memory.residentBytes() > options.residentByteLimit ||
        shadowBytes > options.residentByteLimit - scene->memory.residentBytes() ||
        !budget.Reserve(shadowBytes))
      return Fail(AppearanceSceneStatus::BudgetExceeded, L"内置木鱼资源超过当前预算。", error);
    PreparedSceneImage shadow;
    shadow.id = 1;
    shadow.pixels = Shadow();
    scene->memory.uploadPixelBytes += shadow.pixels.bgraPremultiplied.capacity();
    scene->images.push_back(std::move(shadow));
    PreparedSceneImage bodyImage;
    bodyImage.id = 2; bodyImage.pixels = std::move(body);
    scene->images.push_back(std::move(bodyImage));
    PreparedSceneImage malletImage;
    malletImage.id = 3; malletImage.pixels = std::move(mallet);
    scene->images.push_back(std::move(malletImage));
    for (auto& image : scene->images) {
      const auto status = PrepareMask(image, budget, error);
      if (status != AppearanceSceneStatus::Ready) return status;
    }
    scene->woodfish = {1, 2, 3, originalMalletWidth};
    *output = std::move(scene);
    return AppearanceSceneStatus::Ready;
  } catch (const std::bad_alloc&) {
    return Fail(AppearanceSceneStatus::BudgetExceeded, L"内存不足，未能准备内置木鱼。", error);
  }
}
}  // namespace niuma::windows::runtime
