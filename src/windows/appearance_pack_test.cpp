#include "appearance_pack.h"

#include <gdiplus.h>

#include <iostream>
#include <string>

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
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
  if (ok) {
    Gdiplus::Bitmap frame(240, 250, PixelFormat32bppARGB);
    Gdiplus::Graphics graphics(&frame);
    graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
    niuma::DrawAppearancePack(graphics, *pack, 0.5f);
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
    ok = foundVisiblePixel;
  }
  ok = ok && catalog.Delete(firstId, &error) && catalog.packs().empty();
  if (!ok) std::wcerr << L"Appearance pack test failed: " << error << L"\n";
  Gdiplus::GdiplusShutdown(token);
  return ok ? 0 : 1;
}
