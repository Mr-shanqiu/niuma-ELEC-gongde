#include "appearance_pack.h"

#include <gdiplus.h>

#include <iostream>
#include <string>
#include <array>
#include <vector>

int wmain(int argc, wchar_t** argv) {
  if (argc != 3 && argc != 4) return 2;
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  if (Gdiplus::GdiplusStartup(&token, &input, nullptr) != Gdiplus::Ok) return 3;

  const std::wstring directory = argv[1];
  niuma::AppearanceCatalog catalog;
  std::wstring error;
  std::string firstId;
  std::string secondId;
  bool ok = catalog.Install(argv[2], directory, &firstId, &error);
  ok = ok && catalog.packs().size() == 1 && !firstId.empty();
  ok = ok && catalog.Install(argv[2], directory, &secondId, &error);
  ok = ok && firstId == secondId && catalog.packs().size() == 1;
  niuma::AppearancePack* pack = catalog.Find(firstId);
  ok = ok && pack != nullptr && pack->plusY == 174 && !pack->layers.empty();
  if (ok && firstId == "official.lucky-cat") {
    ok = pack->layers.size() == 2;
    if (ok) {
      const auto& body = pack->layers[0];
      const auto& paw = pack->layers[1];
      ok = body.x == 5.0f && body.y == -35.0f && body.width == 230.0f &&
          paw.x == 30.0f && paw.y == -35.0f && paw.width == 230.0f &&
          paw.smoothInterpolation && paw.keyframes.size() == 3 &&
          paw.keyframes[1].scaleY == 0.8f && paw.keyframes[1].y == 0.0f;
    }
  }
  if (ok) {
    for (float phase : std::array<float, 5>{0.0f, 0.15f, 0.42f, 0.70f, 1.0f}) {
    Gdiplus::Bitmap frame(240, 250, PixelFormat32bppARGB);
    Gdiplus::Graphics graphics(&frame);
    graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
    niuma::DrawAppearancePack(graphics, *pack, phase);
    Gdiplus::Color pixel;
    bool foundVisiblePixel = false;
    for (UINT y = 80; y < 250 && !foundVisiblePixel; y += 4) {
      for (UINT x = 0; x < 240; x += 4) {
        frame.GetPixel(x, y, &pixel);
        if (pixel.GetA() != 0) {
          foundVisiblePixel = true;
          break;
        }
      }
    }
    bool clearCounterRegion = true;
    for (UINT y = 0; y < 80 && clearCounterRegion; ++y) {
      for (UINT x = 0; x < 240; ++x) {
        frame.GetPixel(x, y, &pixel);
        if (pixel.GetA() != 0) { clearCounterRegion = false; break; }
      }
    }
    ok = ok && foundVisiblePixel && clearCounterRegion;
    std::cout << "phase=" << phase << " visible=" << foundVisiblePixel
              << " counter_clear=" << clearCounterRegion << "\n";
    }
  }
  if (ok && argc == 4) {
    std::vector<std::string> importedIds;
    ok = catalog.InstallBatch(argv[3], directory, &importedIds, &error);
    ok = ok && importedIds.size() == 2 && catalog.packs().size() == 2;
    if (ok) {
      importedIds.clear();
      ok = catalog.InstallBatch(argv[3], directory, &importedIds, &error);
      ok = ok && importedIds.size() == 2 && catalog.packs().size() == 2;
    }
  }
  ok = ok && catalog.Delete(firstId, &error) &&
      catalog.packs().size() == (argc == 4 ? 1u : 0u);
  if (!ok) std::wcerr << L"Appearance pack test failed: " << error << L"\n";
  if (ok) std::cout << "PASS " << firstId << " install/reimport/render/clip/delete\n";
  Gdiplus::GdiplusShutdown(token);
  return ok ? 0 : 1;
}
