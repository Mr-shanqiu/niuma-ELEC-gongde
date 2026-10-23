#include <windows.h>
#include <psapi.h>
#include <filesystem>
#include <objidl.h>
#include <gdiplus.h>
#include "../src/windows/appearance_pack.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <map>
#include <string>
#include <vector>

namespace perf {
bool enabled = false;
bool soakMode = false;
struct RollingTiming {
  std::uint64_t count = 0;
  double total = 0, maximum = 0;
  std::array<std::uint64_t, 2049> bins{};
  void Add(double ms) {
    ++count; total += ms; maximum = std::max(maximum, ms);
    ++bins[std::min<std::size_t>(2048, static_cast<std::size_t>(std::max(0.0, ms)))];
  }
  double P95() const {
    if (!count) return 0;
    std::uint64_t cumulative = 0;
    for (std::size_t i = 0; i < bins.size(); ++i) {
      cumulative += bins[i]; if (cumulative >= (count * 95 + 99) / 100) return static_cast<double>(i);
    }
    return 2048;
  }
};
RollingTiming soakFrames;
bool captureNext = false;
std::vector<std::uint64_t> captures;
unsigned submitFailures = 0;
std::map<std::string, std::vector<double>> samples;
std::filesystem::path captureDirectory;
void Capture(const void* buffer, std::size_t bytes, int width, int height) {
  std::uint64_t hash = 14695981039346656037ULL;
  const auto* pixels = static_cast<const unsigned char*>(buffer);
  for (std::size_t i = 0; i < bytes; ++i) {
    hash ^= pixels[i];
    hash *= 1099511628211ULL;
  }
  // Each scene has five captures; prefix with a monotonic index across scenes.
  static unsigned captureIndex = 0;
  std::ofstream raw(captureDirectory / (std::to_string(captureIndex++) + ".frame"), std::ios::binary);
  const std::uint32_t dimensions[] = {static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height)};
  raw.write(reinterpret_cast<const char*>(dimensions), sizeof(dimensions));
  raw.write(static_cast<const char*>(buffer), bytes);
  if (!raw.good()) { std::fprintf(stderr, "frame capture write failed\n"); std::exit(1); }
  captures.push_back(hash);
  captureNext = false;
}
class Scope {
 public:
  explicit Scope(const char* label) : label_(label), active_(enabled || soakMode),
      start_(std::chrono::steady_clock::now()) {}
  ~Scope() { Stop(); }
  void Stop() {
    if (!active_) return;
    const auto ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - start_).count();
    if (soakMode) {
      if (std::strcmp(label_, "frame.total") == 0) soakFrames.Add(ms);
    } else samples[label_].push_back(ms);
    active_ = false;
  }
 private:
  const char* label_;
  bool active_;
  std::chrono::steady_clock::time_point start_;
};
}

niuma::AppearancePack* gProfileFixturePack = nullptr;
#define wWinMain NiuMaUnusedApplicationEntry
#include NIUMA_PROFILE_APP_SOURCE
#undef wWinMain
// Reuse the real source PNG loader and JSON reader in this test translation unit.
#include NIUMA_PROFILE_PACK_SOURCE

static void Check(bool condition, const char* message) {
  if (!condition) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}

static std::string Read(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  Check(input.good(), "fixture file readable");
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

static void LoadFixture(const std::filesystem::path& directory, niuma::AppearancePack& pack) {
  const auto text = Read(directory / L"manifest.json");
  niuma::JsonValue root;
  Check(niuma::JsonParser(text).Parse(&root), "real source manifest parses");
  pack.id = "render-only-source-fixture";
  const auto* layers = niuma::Member(root, "layers");
  Check(layers && layers->kind == niuma::JsonValue::Kind::Array, "source layers");
  for (const auto& value : layers->array) {
    niuma::PackLayer layer;
    const auto& frame = niuma::Member(value, "frame")->array;
    const auto& anchor = niuma::Member(value, "anchor")->array;
    Check(frame.size() == 4 && anchor.size() == 2, "fixture geometry");
    layer.x = static_cast<float>(frame[0].number);
    layer.y = static_cast<float>(frame[1].number);
    layer.width = static_cast<float>(frame[2].number);
    layer.height = static_cast<float>(frame[3].number);
    layer.anchorX = static_cast<float>(anchor[0].number);
    layer.anchorY = static_cast<float>(anchor[1].number);
    layer.imageName = niuma::Member(value, "image")->string;
    for (const auto& key : niuma::Member(value, "keyframes")->array) {
      niuma::PackKeyframe point;
      point.t = static_cast<float>(niuma::Member(key, "t")->number);
      point.x = static_cast<float>(niuma::Member(key, "x")->number);
      point.y = static_cast<float>(niuma::Member(key, "y")->number);
      point.rotation = static_cast<float>(niuma::Member(key, "rotation")->number);
      point.scale = static_cast<float>(niuma::Member(key, "scale")->number);
      point.alpha = static_cast<float>(niuma::Member(key, "alpha")->number);
      layer.keyframes.push_back(point);
    }
    const auto png = Read(directory / layer.imageName);
    Check(niuma::LoadImage(png.data(), png.size(), &layer.image), "real source PNG loader");
    pack.layers.push_back(std::move(layer));
  }
}

static LRESULT CALLBACK FixtureProcedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == kCountMessage) {
    CountGlobalDelivery(false, lp, wp);
    return 0;
  }
  return DefWindowProcW(window, message, wp, lp);
}

static std::uint64_t PrivateBytes() {
  PROCESS_MEMORY_COUNTERS_EX memory{};
  Check(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)) != 0,
      "private memory measurement");
  return memory.PrivateUsage;
}

static void WriteStats(std::ostream& output) {
  bool first = true;
  for (auto& [name, values] : perf::samples) {
    if (!first) output << ',';
    first = false;
    std::sort(values.begin(), values.end());
    double total = 0;
    for (auto value : values) total += value;
    output << '"' << name << "\":{\"calls\":" << values.size()
        << ",\"totalMs\":" << total << ",\"meanMs\":" << total / values.size()
        << ",\"p95Ms\":" << values[(values.size() - 1) * 95 / 100]
        << ",\"maxMs\":" << values.back() << '}';
  }
}

#include "windows-render-soak.h"
#include "windows-keyboard-chain-probe.h"

int wmain(int argc, wchar_t** argv) {
  if (argc == 4 && wcscmp(argv[3], L"--keyboard-chain") == 0)
    return RunKeyboardChainProbe(argv[1], argv[2]);
  if (argc == 4 && wcscmp(argv[3], L"--soak") == 0)
    return RunRenderSoak(argv[1], argv[2], 300);
  if (argc != 3 && argc != 4) return 2;
  const bool rasterExperiment = argc == 4 && wcscmp(argv[3], L"--decode-source-once") == 0;
  if (argc == 4 && !rasterExperiment) return 2;
  const std::filesystem::path root(argv[1]), report(argv[2]);
  perf::captureDirectory = report.parent_path() / (std::string("frames-") + NIUMA_PROFILE_VERSION);
  std::filesystem::create_directories(perf::captureDirectory);
  gIsolatedAcceptance = true;
  gAcceptanceRoot = report.parent_path().wstring();
  std::ofstream output(report);
  Check(output.good(), "report output");
  output << std::fixed << std::setprecision(6);
  Check(SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "COM");
  Gdiplus::GdiplusStartupInput startup;
  Check(Gdiplus::GdiplusStartup(&gState.gdiplusToken, &startup, nullptr) == Gdiplus::Ok, "GDI+");
  Check(LoadAllPngResources(), "production PNG resources");
  WNDCLASSW wc{};
  wc.lpfnWndProc = FixtureProcedure;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"NiuMaRenderProfileFixture";
  Check(RegisterClassW(&wc) != 0, "fixture class");
  gState.window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      wc.lpszClassName, L"Render profile fixture", WS_POPUP,
      0, 0, 240, 338, nullptr, nullptr, wc.hInstance, nullptr);
  Check(gState.window != nullptr, "hidden owned fixture window");
  output << "{\"version\":\"" << NIUMA_PROFILE_VERSION
      << "\",\"experimentalDecodedRaster\":" << (rasterExperiment ? "true" : "false")
      << ",\"scope\":\"instrumented production drawing; hidden owned window; no real hook chain\",\"scenes\":[";
  bool first = true;
  std::size_t rasterPeakBytes = 0, artworkPeakBytes = 0;
  const auto initialPrivateBytes = PrivateBytes();
  auto observedPrivatePeakBytes = initialPrivateBytes;
  {
    niuma::AppearancePack offwork;
#if defined(NIUMA_PROFILE_AFTER)
    niuma::AppearanceResourceMemory preparedMemory;
#endif
    LoadFixture(root / L"assets/appearance-packs/offwork-button", offwork);
    if (rasterExperiment) for (auto& layer : offwork.layers) {
      const auto width = static_cast<INT>(layer.image.image->GetWidth());
      const auto height = static_cast<INT>(layer.image.image->GetHeight());
      auto raster = std::make_unique<Gdiplus::Bitmap>(width, height, PixelFormat32bppPARGB);
      Check(raster->GetLastStatus() == Gdiplus::Ok, "raster allocation");
      {
        Gdiplus::Graphics graphics(raster.get());
        graphics.SetCompositingMode(Gdiplus::CompositingModeSourceCopy);
        Check(graphics.DrawImage(layer.image.image.get(), Gdiplus::Rect(0, 0, width, height),
            0, 0, width, height, Gdiplus::UnitPixel) == Gdiplus::Ok, "decode once");
      }
      layer.image.image = std::move(raster);
      if (layer.image.stream) { layer.image.stream->Release(); layer.image.stream = nullptr; }
    }
    for (const int mode : {0, 1, 2}) for (const bool countdown : {false, true}) {
      const bool pack = mode != 0;
      if (mode == 2) for (auto& layer : offwork.layers)
        for (auto& key : layer.keyframes) key.alpha = 0.5f;
      gProfileFixturePack = pack ? &offwork : nullptr;
      gState.selectedScene = MeritScene::Woodfish;
      gOffwork.enabled = countdown;
      gOffwork.snapshot.valid = true;
      gOffwork.snapshot.remainingSeconds = 30659;
      gState.todayTotal = 12345;
      for (const int dpi : {96, 192, 288}) for (const bool animated : {false, true}) {
        if (mode == 2 && (!countdown || dpi != 192 || !animated)) continue;
#if defined(NIUMA_PROFILE_PREVIOUS)
        // Only the new memory comparison is needed for the unchanged prior candidate.
        if (mode != 1 || !countdown || dpi != 192) continue;
#endif
#if defined(NIUMA_PROFILE_AFTER)
        // Preparation belongs to the worker phase, outside measured drawing.
        // A real switch replaces one owned prepared pack; no global cache.
        offwork = niuma::AppearancePack{};
        preparedMemory = {};
        if (pack) {
          LoadFixture(root / L"assets/appearance-packs/offwork-button", offwork);
          niuma::AppearanceAnimationOptions options;
          options.pixelDensity = static_cast<float>(dpi) / 192.0f;
          for (auto& layer : offwork.layers) {
            if (mode == 2) for (auto& key : layer.keyframes) key.alpha = 0.5f;
            Check(niuma::PrepareLayerRaster(layer, options, preparedMemory),
                "prepare selected fixture within total resource budget");
          }
        }
#endif
        gState.dpi = static_cast<UINT>(dpi);
        gState.windowWidth = ScaleDip(kWindowDipWidth, gState.dpi);
        gState.windowHeight = ScaleDip(MainWindowDipHeight(), gState.dpi);
        SetWindowPos(gState.window, nullptr, 0, 0, gState.windowWidth, gState.windowHeight,
            SWP_NOZORDER | SWP_NOACTIVATE);
        gState.striking = animated;
        gState.strikeStarted = 10000;
        gState.strikeDurationMs = 240;
        perf::enabled = false;
        const auto firstStarted = std::chrono::steady_clock::now();
        RenderLayeredWindow(10000);
        const auto firstRequestedFrameMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - firstStarted).count();
        perf::captures.clear();
        for (int phase : {0, 64, 128, 192, 240}) {
          perf::captureNext = true;
          RenderLayeredWindow(10000 + (animated ? phase : 0));
        }
        perf::samples.clear();
        perf::enabled = true;
        for (int frame = 0; frame < 60; ++frame)
          RenderLayeredWindow(10000 + (animated ? (frame % 15) * 16 : 0));
        perf::enabled = false;
        observedPrivatePeakBytes = std::max(observedPrivatePeakBytes, PrivateBytes());
        std::size_t sceneRasterBytes = 0, sceneArtworkBytes = 0;
#if defined(NIUMA_PROFILE_PREVIOUS)
        Check(niuma::gRenderRasterCache.bytes <= niuma::RenderRasterCache::kByteLimit,
            "decoded cache budget");
        rasterPeakBytes = std::max(rasterPeakBytes, niuma::gRenderRasterCache.bytes);
        sceneRasterBytes = niuma::gRenderRasterCache.bytes;
#endif
#if defined(NIUMA_PROFILE_AFTER)
        Check(preparedMemory.rasterBytes <= 8ULL * 1024 * 1024 &&
            preparedMemory.residentBytes() <= 24ULL * 1024 * 1024,
            "prepared raster and total resource budgets");
        sceneRasterBytes = preparedMemory.rasterBytes;
        rasterPeakBytes = std::max(rasterPeakBytes, sceneRasterBytes);
        Check(gArtworkSurface.bytes() <= kArtworkByteLimit, "artwork surface budget");
        artworkPeakBytes = std::max(artworkPeakBytes, gArtworkSurface.bytes());
        sceneArtworkBytes = gArtworkSurface.bytes();
#endif
        if (!first) output << ',';
        first = false;
        output << "{\"appearance\":\"" << (mode == 2 ? "offwork-fade-fixture" : pack ? "offwork" : "woodfish")
            << "\",\"countdown\":" << (countdown ? "true" : "false")
            << ",\"dpi\":" << dpi << ",\"animated\":" << (animated ? "true" : "false")
            << ",\"firstRequestedFrameMs\":" << firstRequestedFrameMs
            << ",\"privateBytes\":" << PrivateBytes()
            << ",\"decodedCacheBytes\":" << sceneRasterBytes
            << ",\"artworkCacheBytes\":" << sceneArtworkBytes
#if defined(NIUMA_PROFILE_AFTER)
            << ",\"preparedSourceRgbaBytes\":" << preparedMemory.sourceRgbaBytes
            << ",\"preparedCompressedBytes\":" << preparedMemory.compressedBytes
            << ",\"preparedResidentBytes\":" << preparedMemory.residentBytes()
#endif
            << ",\"stages\":{";
        WriteStats(output);
        output << "},\"pixelHashes\":[";
        bool firstHash = true;
        for (auto hash : perf::captures) {
          if (!firstHash) output << ',';
          firstHash = false;
          output << '"' << std::hex << hash << std::dec << '"';
        }
        output << "]}";
      }
    }
    gProfileFixturePack = nullptr;
#if defined(NIUMA_PROFILE_AFTER)
    // Refresh the countdown and number independently while the shape is idle.
    gProfileFixturePack = &offwork;
    gState.striking = false;
    RenderLayeredWindow(10000);
    const auto builds = gArtworkBuilds;
    const auto hits = gArtworkHits;
    for (unsigned i = 1; i <= 60; ++i) {
      ++gState.todayTotal;
      --gOffwork.snapshot.remainingSeconds;
      RenderLayeredWindow(10000 + i * 1000);
    }
    Check(gArtworkBuilds == builds && gArtworkHits >= hits + 60,
        "60 counter/countdown changes do not rebuild idle artwork");
    gProfileFixturePack = nullptr;
    RenderLayeredWindow(10000);
    offwork = niuma::AppearancePack{};
    Check(offwork.layers.empty(), "builtin switch releases owned prepared resources");
    gProfileFixturePack = nullptr;
#endif
  }
#if defined(NIUMA_PROFILE_AFTER)
  {
    niuma::AppearancePack large;
    niuma::AppearanceResourceMemory memory;
    niuma::AppearanceAnimationOptions options;
    for (int i = 0; i < 3; ++i) {
      niuma::PackLayer layer;
      layer.image.image = std::make_unique<Gdiplus::Bitmap>(1024, 1024, PixelFormat32bppARGB);
      layer.width = layer.height = 1024;
      Check(niuma::PrepareLayerRaster(layer, options, memory), "bounded prepare fallback");
      large.layers.push_back(std::move(layer));
    }
    Check(memory.rasterBytes == 8ULL * 1024 * 1024,
        "raster capacity stops at 8MiB without rejecting uncached layers");
    Check(!large.layers[2].raster.image && large.layers[2].image.image &&
        memory.sourceRgbaBytes == 4ULL * 1024 * 1024,
        "over-budget raster retains bounded original pixels");
  }
#endif
  // Known synthetic messages exercise the actual count handler, not a physical
  // keyboard or WH_KEYBOARD_LL/CallNextHookEx chain. No raw keys are collected.
  SYSTEMTIME local{};
  GetLocalTime(&local);
  gState.currentDay = DateKey(local);
  gState.timerRunning = true;
  const auto totalBefore = gState.total;
  perf::samples.clear();
  perf::enabled = true;
  for (int i = 0; i < 100; ++i) Check(PostMessageW(gState.window, kCountMessage, 0, 0), "post known count message");
  MSG message{};
  while (PeekMessageW(&message, gState.window, kCountMessage, kCountMessage, PM_REMOVE))
    DispatchMessageW(&message);
  perf::enabled = false;
  Check(gState.total - totalBefore == 100, "100 known messages counted exactly");
  Check(perf::submitFailures == 0, "layered submissions succeeded");
  output << "],\"syntheticCountMessages\":100,\"countDelta\":" << gState.total - totalBefore
      << ",\"inputStages\":{";
  WriteStats(output);
  output << "},\"submitFailures\":0,\"decodedCacheObservedPeakBytes\":" << rasterPeakBytes
      << ",\"artworkCacheObservedPeakBytes\":" << artworkPeakBytes
      << ",\"initialPrivateBytes\":" << initialPrivateBytes
      << ",\"observedPrivatePeakBytes\":" << observedPrivatePeakBytes
      << ",\"realHooksInstalled\":false,\"userProfileRead\":false,"
      "\"limitations\":\"offline fixed frames; hidden window submission; does not measure physical input latency or real hook scheduling\"}";
  DestroyWindow(gState.window);
  gState.window = nullptr;
  ReleaseAllPngResources();
  Gdiplus::GdiplusShutdown(gState.gdiplusToken);
  CoUninitialize();
  std::printf("PROFILE=%s\n", NIUMA_PROFILE_VERSION);
}
