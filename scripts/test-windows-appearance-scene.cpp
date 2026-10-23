// Directed bridge test: real package loader -> shared geometry / BGRA / alpha.
// No GPU, window, input hook, installed package or production data is used.
#include "../src/windows/runtime/appearance_scene.h"
#include "miniz.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <thread>
#include <utility>

namespace {
using namespace niuma::windows::runtime;
using niuma::client::core::AnimationPlayer;
void Check(bool ok, const char* label) {
  if (!ok) { std::fprintf(stderr, "FAIL %s\n", label); std::exit(1); }
}
struct Sandbox {
  std::filesystem::path path;
  Sandbox() {
    wchar_t temp[MAX_PATH]{};
    Check(GetTempPathW(MAX_PATH, temp) != 0, "temporary root");
    path = std::filesystem::path(temp) / (L"niuma-scene-test-" +
        std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    Check(std::filesystem::create_directory(path), "owned test directory");
  }
  ~Sandbox() { std::error_code ignored; std::filesystem::remove_all(path, ignored); }
};
std::vector<unsigned char> Png() {
  Gdiplus::Bitmap bitmap(9, 7, PixelFormat32bppARGB);
  for (int y = 0; y < 7; ++y) for (int x = 0; x < 9; ++x)
    Check(bitmap.SetPixel(x, y, Gdiplus::Color(128, 200, 100, 50)) == Gdiplus::Ok, "fixture pixel");
  bitmap.SetPixel(4, 3, Gdiplus::Color(0, 200, 100, 50));
  bitmap.SetPixel(0, 0, Gdiplus::Color(1, 255, 255, 255));
  IStream* stream = nullptr;
  Check(SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)), "PNG stream");
  const CLSID encoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}};
  Check(bitmap.Save(stream, &encoder, nullptr) == Gdiplus::Ok, "PNG encode");
  STATSTG info{};
  Check(SUCCEEDED(stream->Stat(&info, STATFLAG_NONAME)), "PNG size");
  LARGE_INTEGER zero{};
  stream->Seek(zero, STREAM_SEEK_SET, nullptr);
  std::vector<unsigned char> result(static_cast<size_t>(info.cbSize.QuadPart));
  ULONG read = 0;
  Check(SUCCEEDED(stream->Read(result.data(), static_cast<ULONG>(result.size()), &read)) &&
      read == result.size(), "PNG bytes");
  stream->Release();
  return result;
}
std::string Manifest(const std::string& id = "fixture.scene", bool opaque = false) {
  std::string result = "{\"schema_version\":3,\"id\":\"" + id +
      "\",\"version\":\"1\",\"name_zh\":\"Scene\",\"name_en\":\"Scene\","
      "\"author\":\"test\",\"publisher\":\"test\",\"review_id\":\"test\","
      "\"canvas_width\":240,\"canvas_height\":250,\"preview\":\"image.png\","
      "\"plus_y\":174,\"layers\":[";
  const float times[] = {0, .1f, .2f, .3f, .4f, .6f, .8f, 1};
  for (int layer = 0; layer < 6; ++layer) {
    if (layer) result += ',';
    result += "{\"image\":\"image.png\",\"frame\":[" + std::to_string(20 + layer) +
        ",-10,180,160],\"anchor\":[0.2,0.8],\"interpolation\":\"" +
        (layer % 2 ? "smoothstep" : "linear") + "\",\"keyframes\":[";
    for (int key = 0; key < 8; ++key) {
      if (key) result += ',';
      result += "{\"t\":" + std::to_string(times[key]) + ",\"x\":" + std::to_string(key * 2) +
          ",\"y\":" + std::to_string(key * 3) + ",\"rotation\":" + std::to_string(key * 10) +
          ",\"scale\":" + std::to_string(1 + key * .1f) +
          ",\"scale_y\":" + std::to_string(1 + key * .03f) +
          ",\"alpha\":" + std::to_string(opaque ? 1 : 1 - key * .1f) + "}";
    }
    result += "]}";
  }
  return result + "]}";
}
void Archive(const std::filesystem::path& path, const std::string& manifest,
             const std::vector<unsigned char>& png) {
  mz_zip_archive zip{};
  Check(mz_zip_writer_init_file(&zip, path.string().c_str(), 0) != 0, "archive begin");
  Check(mz_zip_writer_add_mem(&zip, "manifest.json", manifest.data(), manifest.size(), 0) &&
      mz_zip_writer_add_mem(&zip, "image.png", png.data(), png.size(), 0) &&
      mz_zip_writer_finalize_archive(&zip), "archive entries");
  Check(mz_zip_writer_end(&zip) != 0, "archive close");
}
std::unique_ptr<niuma::AppearancePack> Load(const niuma::AppearanceResourceRequest& request,
                                         bool retain = true) {
  niuma::AppearanceAnimationOptions options;
  options.retainSourcePixels = retain;
  niuma::AppearanceResourceMemory memory;
  std::unique_ptr<niuma::AppearancePack> output;
  std::wstring error;
  Check(niuma::PrepareAppearanceAnimation(request, options, &output, &memory, &error) ==
      niuma::AppearancePreparationStatus::Ready, "verified source preparation");
  return output;
}
void Geometry(const PreparedAppearanceScene& scene) {
  AnimationPlayer player;
  Check(scene.Configure(player), "shared scene configured");
  Check(player.SetAction({true, 1, 1000, 1000}), "absolute action");
  unsigned compared = 0;
  for (unsigned time : {1000U, 1450U, 1700U, 1999U}) {
    const auto& frame = player.Sample(time, 1.5f);
    Check(frame.valid && frame.quadCount == 6, "six visible layers");
    const float phase = (time - 1000) / 1000.0f;
    for (size_t i = 0; i < scene.layers.size(); ++i) {
      const auto& layer = scene.layers[i];
      size_t right = 1;
      while (right + 1 < layer.keyframes.size() && phase > layer.keyframes[right].t) ++right;
      const auto& left = layer.keyframes[right - 1];
      const auto& last = layer.keyframes[right];
      float t = (phase - left.t) / (last.t - left.t);
      if (layer.smoothInterpolation) t = t * t * (3 - 2 * t);
      const auto mix = [t](float a, float b) { return a + (b - a) * t; };
      const float top = 250 - layer.frame.y - layer.frame.height;
      const float ax = layer.frame.x + layer.frame.width * layer.anchor.x;
      const float ay = top + layer.frame.height * (1 - layer.anchor.y);
      Gdiplus::Matrix matrix;
      matrix.Translate(ax + mix(left.x, last.x), ay - mix(left.y, last.y));
      matrix.Rotate(-mix(left.rotation, last.rotation));
      matrix.Scale(mix(left.scale, last.scale), mix(left.scale, last.scale) * mix(left.scaleY, last.scaleY));
      matrix.Translate(-ax, -ay);
      Gdiplus::PointF points[] = {{layer.frame.x, top}, {layer.frame.x + layer.frame.width, top},
          {layer.frame.x + layer.frame.width, top + layer.frame.height},
          {layer.frame.x, top + layer.frame.height}};
      Check(matrix.TransformPoints(points, 4) == Gdiplus::Ok, "GDI reference transform");
      for (size_t point = 0; point < 4; ++point) {
        Check(std::abs(points[point].X * 1.5f - frame.quads[i].positions[point].x) < .001f &&
            std::abs(points[point].Y * 1.5f - frame.quads[i].positions[point].y) < .001f,
            "shared geometry matches original GDI transform without second Y flip");
        ++compared;
      }
      Check(std::abs(frame.quads[i].opacity - mix(left.alpha, last.alpha)) < .0001f &&
          frame.quads[i].clip.y == 120 && frame.quads[i].clip.height == 255 &&
          frame.quads[i].uv[0].x == 0 && frame.quads[i].uv[3].y == 1,
          "opacity, clip and top-down UV preserved");
    }
  }
  Check(compared == 96, "geometry cases");
}
niuma::runtime::PixelImage Builtin(unsigned width, unsigned height) {
  niuma::runtime::PixelImage image;
  image.width = width; image.height = height; image.strideBytes = width * 4;
  image.bgraPremultiplied.resize(static_cast<size_t>(image.strideBytes) * height, 64);
  for (size_t i = 3; i < image.bgraPremultiplied.size(); i += 4) image.bgraPremultiplied[i] = 128;
  return image;
}
}

int main() {
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  Check(Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok, "GDI startup");
  Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)), "COM startup");
  {
    Sandbox sandbox;
    const auto path = sandbox.path / L"scene.nmgpack";
    const auto png = Png();
    Archive(path, Manifest(), png);
    niuma::AppearanceCatalog catalog;
    std::wstring error;
    Check(catalog.ReloadMetadata(sandbox.path.wstring(), &error) && error.empty() &&
        catalog.packs().size() == 1, "real validated catalog");
    const auto request = niuma::RequestAppearanceResources(*catalog.packs().front());
    AppearanceSceneOptions options;
    std::unique_ptr<PreparedAppearanceScene> scene;
    AppearanceSceneStatus status = AppearanceSceneStatus::Invalid;
    std::thread worker([&] {
      Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)), "worker COM");
      status = PrepareAppearanceScene(request, options, &scene, &error);
      CoUninitialize();
    });
    worker.join();
    Check(status == AppearanceSceneStatus::Ready && scene && scene->layers.size() == 6 &&
        scene->layers[0].keyframes.size() == 8 && scene->images.size() == 1 &&
        scene->source.contentFingerprint == request.contentFingerprint && scene->HasColorPixels(),
        "validated six-layer scene shares one image/mask");
    const auto& image = scene->images.front();
    Check(image.id == 1 && image.pixels.width == 9 && image.pixels.height == 7 && image.alpha.success &&
        image.alpha.sourceAlpha[3 * 9 + 4] == 0 && image.alpha.sourceAlpha[0] == 1,
        "original dimensions, transparent hole and faint alpha retained");
    const auto* pixel = image.pixels.bgraPremultiplied.data() + 4;
    Check(pixel[0] == 25 && pixel[1] == 50 && pixel[2] == 100 && pixel[3] == 128 &&
        image.pixels.bgraPremultiplied[0] == 1 && image.pixels.bgraPremultiplied[3] == 1,
        "WIC PBGRA policy preserved");
    Check(scene->memory.sourceRgbaBytesAtEntry == 6 * 9 * 7 * 4 &&
        scene->memory.uploadPixelBytes == image.pixels.bgraPremultiplied.capacity() &&
        scene->memory.alphaMaskBytes == image.alpha.storageBytes &&
        scene->memory.residentBytes() <= options.residentByteLimit &&
        scene->memory.peakReservationBytes <= options.bridgePeakByteLimit,
        "source, deduplicated colors, mask and peak reported separately");
    Geometry(*scene);
    const auto alpha = image.alpha.sourceAlpha;
    const auto maskBytes = scene->memory.alphaMaskBytes;
    scene->ReleaseColorPixels();
    Check(!scene->HasColorPixels() && scene->memory.uploadPixelBytes == 0 &&
        scene->memory.residentBytes() == maskBytes && scene->Find(1)->alpha.sourceAlpha == alpha,
        "optional color release keeps owned alpha and geometry");
    Geometry(*scene);
    auto wrong = request;
    wrong.contentFingerprint[0] = wrong.contentFingerprint[0] == '0' ? '1' : '0';
    Check(ConvertPreparedAppearanceScene(Load(request), wrong, options, &scene, &error) ==
        AppearanceSceneStatus::Changed && !scene, "changed binding rejected");
    auto constrained = options;
    constrained.residentByteLimit = 9 * 7 * 4;
    Check(ConvertPreparedAppearanceScene(Load(request), request, constrained, &scene, &error) ==
        AppearanceSceneStatus::BudgetExceeded && !scene, "alpha bytes cannot escape resident budget");
    constrained = options; constrained.bridgePeakByteLimit = 64;
    Check(ConvertPreparedAppearanceScene(Load(request), request, constrained, &scene, &error) ==
        AppearanceSceneStatus::BudgetExceeded && !scene, "source overlap included in bridge peak");
    Archive(path, Manifest("fixture.scene", true), png);
    error.clear();
    Check(catalog.ReloadMetadata(sandbox.path.wstring(), &error) && error.empty(), "opaque reload");
    const auto opaque = niuma::RequestAppearanceResources(*catalog.packs().front());
    Check(ConvertPreparedAppearanceScene(Load(opaque, false), opaque, options, &scene, &error) ==
        AppearanceSceneStatus::ImageUnavailable && !scene, "downsampled-only pack cannot replace original alpha");
    Archive(path, Manifest("official.unsigned"), png);
    Check(PrepareAppearanceScene(opaque, options, &scene, &error) == AppearanceSceneStatus::Invalid &&
        !scene && !error.empty(), "production bridge still enforces actual package authorization");
    Check(PrepareWoodfishScene(Builtin(8, 8), Builtin(200, 10), std::string(64, 'a'),
        options, &scene, &error) == AppearanceSceneStatus::Ready && scene &&
        scene->kind == AppearanceSceneKind::Woodfish && scene->images.size() == 3,
        "trusted built-in woodfish separate entry");
    AnimationPlayer player;
    Check(scene->Configure(player), "woodfish shared scene");
    const auto& frame = player.Sample(0);
    Check(frame.valid && frame.quadCount == 4 && frame.quads[2].image == frame.quads[3].image &&
        std::abs(frame.quads[2].uv[0].x - 108.0f / 200) < .00001f &&
        std::abs(frame.quads[3].uv[1].x - 145.0f / 200) < .00001f,
        "mallet crop UVs share one texture");
    Check(scene->Find(1)->alpha.sourceAlpha[16 * 320 + 160] == 64 &&
        scene->Find(1)->alpha.sourceAlpha[0] == 0, "shadow keeps approved geometry and alpha");
    auto bad = Builtin(8, 8);
    bad.bgraPremultiplied[0] = 255;
    Check(PrepareWoodfishScene(std::move(bad), Builtin(200, 10), std::string(64, 'a'), options,
        &scene, &error) == AppearanceSceneStatus::Invalid && !scene,
        "builtin input cannot masquerade straight pixels as premultiplied");
    std::printf("PASS appearance scene bridge: verified package, 96 transform corners, colors/alpha, budgets, woodfish\n");
  }
  CoUninitialize();
  Gdiplus::GdiplusShutdown(token);
}
