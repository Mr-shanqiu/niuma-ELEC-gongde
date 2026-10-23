// Native resource-lifetime checks. Private generated fixtures; no client hooks,
// user packages, signing keys or network. Link the normal appearance loader.
#include "../src/windows/appearance_pack.h"
#include "miniz.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

namespace {
void Check(bool ok, const char* name) {
  if (!ok) { std::fprintf(stderr, "FAIL %s\n", name); std::exit(1); }
}
struct Sandbox {
  std::filesystem::path path;
  Sandbox() {
    wchar_t temp[MAX_PATH]{};
    Check(GetTempPathW(MAX_PATH, temp) != 0, "temporary directory");
    path = std::filesystem::path(temp) / (L"niuma-resource-test-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    Check(std::filesystem::create_directory(path), "owned directory");
  }
  ~Sandbox() { std::error_code ignored; std::filesystem::remove_all(path, ignored); }
};
std::vector<unsigned char> Png() {
  Gdiplus::Bitmap bitmap(512, 512, PixelFormat32bppARGB);
  Gdiplus::Rect rect(0, 0, 512, 512);
  Gdiplus::BitmapData data{};
  Check(bitmap.LockBits(&rect, Gdiplus::ImageLockModeWrite, PixelFormat32bppARGB, &data) ==
      Gdiplus::Ok, "fixture pixels");
  for (int y = 0; y < 512; ++y) {
    auto* row = static_cast<unsigned char*>(data.Scan0) + y * data.Stride;
    for (int x = 0; x < 512; ++x) {
      row[x * 4] = static_cast<unsigned char>(x * 7);
      row[x * 4 + 1] = static_cast<unsigned char>(y * 3);
      row[x * 4 + 2] = static_cast<unsigned char>(x + y);
      row[x * 4 + 3] = static_cast<unsigned char>((x + y) % 255 + 1);
    }
  }
  Check(bitmap.UnlockBits(&data) == Gdiplus::Ok, "fixture unlock");
  IStream* stream = nullptr;
  Check(SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)), "PNG stream");
  const CLSID encoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}};
  Check(bitmap.Save(stream, &encoder, nullptr) == Gdiplus::Ok, "PNG encode");
  STATSTG info{};
  Check(SUCCEEDED(stream->Stat(&info, STATFLAG_NONAME)), "PNG size");
  LARGE_INTEGER zero{};
  Check(SUCCEEDED(stream->Seek(zero, STREAM_SEEK_SET, nullptr)), "PNG rewind");
  std::vector<unsigned char> result(static_cast<size_t>(info.cbSize.QuadPart));
  ULONG read = 0;
  Check(SUCCEEDED(stream->Read(result.data(), static_cast<ULONG>(result.size()), &read)) &&
      read == result.size(), "PNG read");
  stream->Release();
  return result;
}
std::string Manifest(const std::string& id, bool fade, const char* version = "1") {
  const std::string alpha = fade ? "0.5" : "1";
  return "{\"schema_version\":1,\"id\":\"" + id + "\",\"version\":\"" + version +
      "\",\"name_zh\":\"Resource fixture\",\"name_en\":\"Resource fixture\","
      "\"author\":\"test\",\"publisher\":\"test\",\"review_id\":\"local\","
      "\"canvas_width\":240,\"canvas_height\":250,\"preview\":\"image.png\",\"plus_y\":174,"
      "\"layers\":[{\"image\":\"image.png\",\"frame\":[20,0,200,170],\"anchor\":[0.5,0.5],"
      "\"keyframes\":[{\"t\":0,\"x\":0,\"y\":0,\"rotation\":0,\"scale\":1,\"alpha\":" + alpha +
      "},{\"t\":1,\"x\":3,\"y\":2,\"rotation\":5,\"scale\":1.2,\"alpha\":" + alpha + "}]}]}";
}
void Archive(const std::filesystem::path& path, const std::string& manifest,
             const std::vector<unsigned char>& png) {
  mz_zip_archive archive{};
  Check(mz_zip_writer_init_file(&archive, path.string().c_str(), 0) != 0, "fixture ZIP");
  Check(mz_zip_writer_add_mem(&archive, "manifest.json", manifest.data(), manifest.size(), 0) != 0 &&
      mz_zip_writer_add_mem(&archive, "image.png", png.data(), png.size(), 0) != 0 &&
      mz_zip_writer_finalize_archive(&archive) != 0, "fixture members");
  Check(mz_zip_writer_end(&archive) != 0, "fixture close");
}
niuma::PackImage StreamedImage(const std::vector<unsigned char>& png) {
  niuma::PackImage result;
  Check(SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &result.stream)), "reference stream");
  ULONG written = 0;
  Check(SUCCEEDED(result.stream->Write(png.data(), static_cast<ULONG>(png.size()), &written)) &&
      written == png.size(), "reference PNG bytes");
  LARGE_INTEGER zero{};
  Check(SUCCEEDED(result.stream->Seek(zero, STREAM_SEEK_SET, nullptr)), "reference rewind");
  result.image.reset(Gdiplus::Image::FromStream(result.stream));
  Check(result.image && result.image->GetLastStatus() == Gdiplus::Ok, "reference lazy PNG");
  return result;
}
niuma::AppearancePack Reference(const niuma::AppearancePack& prepared,
                               const std::vector<unsigned char>& png) {
  niuma::AppearancePack reference;
  for (const auto& original : prepared.layers) {
    niuma::PackLayer layer;
    layer.x = original.x; layer.y = original.y;
    layer.width = original.width; layer.height = original.height;
    layer.anchorX = original.anchorX; layer.anchorY = original.anchorY;
    layer.keyframes = original.keyframes;
    layer.smoothInterpolation = original.smoothInterpolation;
    layer.image = StreamedImage(png);
    if (original.raster.image) {
      const auto width = original.raster.image->GetWidth(), height = original.raster.image->GetHeight();
      auto raster = std::make_unique<Gdiplus::Bitmap>(width, height, PixelFormat32bppPARGB);
      {
        Gdiplus::Graphics graphics(raster.get());
        graphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy);
        graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
        graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
        Check(graphics.DrawImage(layer.image.image.get(), Gdiplus::Rect(0, 0, width, height),
            0, 0, layer.image.image->GetWidth(), layer.image.image->GetHeight(), Gdiplus::UnitPixel) ==
            Gdiplus::Ok, "previous raster algorithm");
      }
      layer.raster.image = std::move(raster);
    }
    reference.layers.push_back(std::move(layer));
  }
  return reference;
}
std::vector<unsigned char> Frame(const niuma::AppearancePack& pack, float density, float phase) {
  const int width = static_cast<int>(240 * density), height = static_cast<int>(250 * density);
  Gdiplus::Bitmap bitmap(width, height, PixelFormat32bppARGB);
  {
    Gdiplus::Graphics graphics(&bitmap);
    graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
    graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
    graphics.ScaleTransform(density, density);
    Check(niuma::DrawAppearancePack(graphics, pack, phase), "complete prepared draw");
  }
  Gdiplus::Rect area(0, 0, width, height);
  Gdiplus::BitmapData data{};
  Check(bitmap.LockBits(&area, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &data) ==
      Gdiplus::Ok, "frame pixels");
  std::vector<unsigned char> pixels(static_cast<size_t>(width) * height * 4);
  for (int y = 0; y < height; ++y) std::memcpy(pixels.data() + static_cast<size_t>(y) * width * 4,
      static_cast<const unsigned char*>(data.Scan0) + y * data.Stride, static_cast<size_t>(width) * 4);
  Check(bitmap.UnlockBits(&data) == Gdiplus::Ok, "frame unlock");
  return pixels;
}
}

int main() {
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  Check(Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok, "GDI startup");
  {
    Sandbox sandbox;
    const auto png = Png();
    for (int i = 0; i < 16; ++i)
      Archive(sandbox.path / (std::to_string(i) + ".nmgpack"),
          Manifest("fixture.pack-" + std::to_string(i), i == 1), png);
    niuma::AppearanceCatalog catalog;
    std::wstring error;
    Check(catalog.ReloadMetadata(sandbox.path.wstring(), &error) && error.empty() &&
        catalog.packs().size() == 16, "complete metadata catalog");
    for (const auto& pack : catalog.packs()) {
      Check(!pack->preview.image && !pack->preview.stream && !pack->contentFingerprint.empty(),
          "catalog retains no preview/stream");
      for (const auto& layer : pack->layers)
        Check(!layer.image.image && !layer.image.stream && !layer.raster.image &&
            layer.sourcePixelWidth == 512 && layer.sourcePixelHeight == 512,
            "catalog retains only layer metadata");
    }
    Gdiplus::Bitmap empty(240, 250, PixelFormat32bppARGB);
    Gdiplus::Graphics graphics(&empty);
    Check(!niuma::DrawAppearancePack(graphics, *catalog.packs().front(), 0),
        "metadata cannot report successful blank draw");
    unsigned pixelCases = 0;
    for (const auto& id : {"fixture.pack-0", "fixture.pack-1"}) {
      auto request = niuma::RequestAppearanceResources(*catalog.Find(id));
      for (float density : {0.5f, 1.0f, 1.5f}) {
        niuma::AppearanceAnimationOptions options;
        options.pixelDensity = density;
        std::unique_ptr<niuma::AppearancePack> prepared;
        niuma::AppearanceResourceMemory memory;
        niuma::AppearancePreparationStatus status;
        std::thread worker([&] {
          CoInitializeEx(nullptr, COINIT_MULTITHREADED);
          status = niuma::PrepareAppearanceAnimation(request, options, &prepared, &memory, &error);
          CoUninitialize();
        });
        worker.join();
        Check(status == niuma::AppearancePreparationStatus::Ready && prepared &&
            prepared->contentFingerprint == request.contentFingerprint &&
            memory.compressedBytes == 0 && memory.residentBytes() <= options.byteLimit,
            "worker transfers complete bounded pixels");
        Check(!prepared->preview.image && !prepared->layers.front().image.stream,
            "active resources retain no preview/compressed stream");
        if (std::strcmp(id, "fixture.pack-0") == 0)
          Check(memory.sourceRgbaBytes == 0 && prepared->layers.front().raster.image,
              "opaque animation releases full source pixels");
        auto reference = Reference(*prepared, png);
        for (float phase : {0.0f, 0.15f, 0.42f, 0.7f, 1.0f}) {
          Check(Frame(*prepared, density, phase) == Frame(reference, density, phase),
              "prepared pixels match previous streamed PNG/raster algorithm");
          ++pixelCases;
        }
        const auto hidden = std::filesystem::path(request.sourcePath + L".hidden");
        std::filesystem::rename(request.sourcePath, hidden);
        Check(!Frame(*prepared, density, 0.42f).empty(), "draw has no file dependency");
        std::filesystem::rename(hidden, request.sourcePath);
      }
    }
    auto request = niuma::RequestAppearanceResources(*catalog.Find("fixture.pack-0"));
    niuma::AppearanceAnimationOptions tiny;
    tiny.byteLimit = 1;
    niuma::AppearanceResourceMemory memory;
    std::unique_ptr<niuma::AppearancePack> prepared;
    Check(niuma::PrepareAppearanceAnimation(request, tiny, &prepared, &memory, &error) ==
        niuma::AppearancePreparationStatus::BudgetExceeded && !prepared && !error.empty(),
        "over-budget resource explicitly refused");
    niuma::AppearanceThumbnailCache cache;
    for (const auto& pack : catalog.packs()) {
      std::unique_ptr<niuma::AppearanceThumbnail> thumbnail;
      Check(niuma::PrepareAppearanceThumbnail(niuma::RequestAppearanceResources(*pack), &thumbnail, &error) ==
          niuma::AppearancePreparationStatus::Ready && thumbnail &&
          thumbnail->memory.sourceRgbaBytes == 0 && thumbnail->memory.rasterBytes == 0 &&
          thumbnail->memory.thumbnailBytes == 240 * 250 * 4, "independent fixed-size thumbnail");
      Check(cache.Put(std::move(thumbnail)) && cache.size() <= 12 && cache.bytes() <= 2880000,
          "thumbnail count and actual byte bounds");
    }
    Check(cache.size() == 12 && cache.bytes() == 2880000, "thumbnail LRU evicts excess");
    std::unique_ptr<niuma::AppearanceThumbnail> existingThumbnail;
    Check(niuma::PrepareAppearanceThumbnail(request, &existingThumbnail, &error) ==
        niuma::AppearancePreparationStatus::Ready && cache.Put(std::move(existingThumbnail)) &&
        cache.Find(request), "old content actually cached before same-path change");
    Archive(request.sourcePath, Manifest("fixture.pack-0", false, "2"), png);
    niuma::AppearanceAnimationOptions options;
    Check(niuma::PrepareAppearanceAnimation(request, options, &prepared, &memory, &error) ==
        niuma::AppearancePreparationStatus::Changed && !prepared, "same path changed content refused");
    std::unique_ptr<niuma::AppearanceThumbnail> thumbnail;
    Check(niuma::PrepareAppearanceThumbnail(request, &thumbnail, &error) ==
        niuma::AppearancePreparationStatus::Changed && !thumbnail, "thumbnail also checks fingerprint");
    error.clear();
    Check(catalog.Reload(sandbox.path.wstring(), &error) && !catalog.Find(request.id)->layers.front().image.image,
        "subsequent reload preserves metadata mode");
    const auto changed = niuma::RequestAppearanceResources(*catalog.Find(request.id));
    Check(changed.contentFingerprint != request.contentFingerprint && cache.Find(changed) == nullptr,
        "cache cannot reuse same-id stale content");
    Check(niuma::PrepareAppearanceThumbnail(changed, &thumbnail, &error) ==
        niuma::AppearancePreparationStatus::Ready && cache.Put(std::move(thumbnail)) &&
        cache.Find(changed) && !cache.Find(request), "cache replaces old same-path content");
    const auto fadeRequest = niuma::RequestAppearanceResources(*catalog.Find("fixture.pack-1"));
    options.byteLimit = 512 * 512 * 4;
    Check(niuma::PrepareAppearanceAnimation(fadeRequest, options, &prepared, &memory, &error) ==
        niuma::AppearancePreparationStatus::Ready && memory.rasterFallback &&
        memory.rasterBytes == 0 && memory.sourceRgbaBytes == options.byteLimit,
        "raster budget fallback keeps exact original pixels within total bound");
    auto fallbackReference = Reference(*prepared, png);
    Check(Frame(*prepared, 1, 0.42f) == Frame(fallbackReference, 1, 0.42f),
        "bounded fallback preserves fade pixels");
    options.byteLimit = 24ULL * 1024 * 1024;
    options.retainSourcePixels = true;
    Check(niuma::PrepareAppearanceAnimation(changed, options, &prepared, &memory, &error) ==
        niuma::AppearancePreparationStatus::Ready && prepared->layers.front().image.image &&
        prepared->layers.front().sourcePixelWidth == 512 &&
        memory.sourceRgbaBytes == 512 * 512 * 4,
        "explicit original-alpha access is available and charged to the budget");
    const std::vector<unsigned char> brokenPng{1, 2, 3};
    Archive(request.sourcePath, Manifest(request.id, false), brokenPng);
    error.clear();
    Check(catalog.ReloadMetadata(sandbox.path.wstring(), &error) && !error.empty() &&
        !catalog.Find(request.id), "metadata mode still rejects broken image and explains failure");
    Archive(request.sourcePath, Manifest("official.unsigned", false), png);
    error.clear();
    Check(catalog.ReloadMetadata(sandbox.path.wstring(), &error) && !error.empty() &&
        !catalog.Find("official.unsigned"), "metadata does not bypass official license requirement");
    cache.Clear();
    Check(cache.size() == 0 && cache.bytes() == 0, "picker close releases thumbnails");
    std::printf("PASS appearance resources; pixel cases=%u; catalog=metadata; thumbnails<=2880000; no draw IO\n",
        pixelCases);
  }
  Gdiplus::GdiplusShutdown(token);
}
