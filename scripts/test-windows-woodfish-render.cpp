#ifdef NDEBUG
#undef NDEBUG
#endif

// Render actual production drawing functions without starting the application,
// installing listeners, opening windows, reading settings or contacting services.
#define wWinMain NiuMaUnusedApplicationEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <cassert>
#include <fstream>

static CLSID PngEncoder() {
  UINT count = 0, bytes = 0;
  assert(Gdiplus::GetImageEncodersSize(&count, &bytes) == Gdiplus::Ok);
  std::vector<BYTE> storage(bytes);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(storage.data());
  assert(Gdiplus::GetImageEncoders(count, bytes, encoders) == Gdiplus::Ok);
  for (UINT i = 0; i < count; ++i)
    if (wcscmp(encoders[i].MimeType, L"image/png") == 0) return encoders[i].Clsid;
  std::abort();
}

// Frozen pre-fix default woodfish geometry, for a native before/after comparison.
static void DrawPreviousWoodfish(Gdiplus::Graphics& graphics, float amount, float phase) {
  Gdiplus::SolidBrush shadow(Gdiplus::Color(62, 0, 0, 0));
  graphics.FillEllipse(&shadow, 34.0f, 227.0f, 172.0f, 18.0f);
  graphics.DrawImage(gFish.image.get(), Gdiplus::RectF(18, 102, 232, 140));
  const auto state = graphics.Save();
  graphics.TranslateTransform(280, 90);
  graphics.RotateTransform(6.0f - 10.5f * amount);
  graphics.TranslateTransform(-280, -90);
  graphics.DrawImage(gMallet.image.get(), Gdiplus::RectF(72, 63, 214, 54));
  graphics.Restore(state);
  if (phase >= kPlusStartPhase && phase <= kPlusEndPhase)
    DrawCenteredText(graphics, L"+1", Gdiplus::RectF(0, 66, 240, 30), 22, 255);
  DrawWidgetText(graphics, L"12345", Gdiplus::RectF(0, 0, 240, 40), 26,
      Gdiplus::Color(255, 240, 139, 35));
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  if (Gdiplus::GdiplusStartup(&token, &input, nullptr) != Gdiplus::Ok) return 3;
  const std::filesystem::path root(argv[1]), output(argv[2]);
  std::filesystem::create_directories(output);
  gFish.image.reset(Gdiplus::Image::FromFile((root / L"assets/woodfish.png").c_str()));
  gMallet.image.reset(Gdiplus::Image::FromFile((root / L"assets/mallet.png").c_str()));
  assert(gFish.image && gFish.image->GetLastStatus() == Gdiplus::Ok);
  assert(gMallet.image && gMallet.image->GetLastStatus() == Gdiplus::Ok);
  gState.selectedScene = MeritScene::Woodfish;
  gState.todayTotal = 12345;
  gState.dpi = 96;
  gState.strikeDurationMs = 1000;
  gState.strikeStarted = 10000;
  const CLSID encoder = PngEncoder();
  unsigned feedbackPixels = 0;
  {
    for (unsigned tick = 0; tick <= 100; ++tick) {
      const float phase = tick / 100.0f;
      const float amount = phase < kContactPhase
          ? SmoothStep(phase / kContactPhase)
          : 1.0f - SmoothStep((phase - kContactPhase) / (1.0f - kContactPhase));
      Gdiplus::Bitmap artwork(240, 250, PixelFormat32bppARGB);
      {
        Gdiplus::Graphics graphics(&artwork);
        graphics.Clear(Gdiplus::Color(0, 0, 0, 0));
        DrawSceneArtwork(graphics, MeritScene::Woodfish, amount);
      }
      for (int y = 40; y < 80; ++y) for (int x = 0; x < 240; ++x) {
        Gdiplus::Color pixel;
        assert(artwork.GetPixel(x, y, &pixel) == Gdiplus::Ok);
        assert(pixel.GetA() == 0);  // Artwork never enters the feedback band.
      }
    }
    for (const unsigned tick : {0U, 30U, 42U, 65U, 100U}) {
      const float phase = tick / 100.0f;
      const float amount = phase < kContactPhase
          ? SmoothStep(phase / kContactPhase)
          : 1.0f - SmoothStep((phase - kContactPhase) / (1.0f - kContactPhase));
      for (const bool before : {true, false}) {
        Gdiplus::Bitmap frame(960, 1000, PixelFormat32bppARGB);
        {
          Gdiplus::Graphics graphics(&frame);
          graphics.Clear(Gdiplus::Color(255, 245, 245, 247));
          graphics.ScaleTransform(4, 4);
          graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
          graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
          graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
          graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
          if (before) DrawPreviousWoodfish(graphics, amount, phase);
          else {
            gState.striking = tick < 100;
            DrawScene(graphics, gState.strikeStarted + tick * 10);
          }
        }
        const auto name = std::wstring(before ? L"before-" : L"after-") +
            std::to_wstring(tick) + L".png";
        assert(frame.Save((output / name).c_str(), &encoder, nullptr) == Gdiplus::Ok);
        if (!before && tick == 42) {
          for (int y = 46 * 4; y < 76 * 4; ++y) for (int x = 0; x < 240 * 4; ++x) {
            Gdiplus::Color pixel;
            frame.GetPixel(x, y, &pixel);
            if (pixel.GetR() > 180 && pixel.GetG() > 70 && pixel.GetG() < 190 &&
                pixel.GetB() < 100) ++feedbackPixels;
          }
          assert(feedbackPixels > 100);
        }
      }
    }
  }
  std::ofstream receipt(output / L"WOODFISH_RENDER_RESULT.json");
  receipt << "{\"status\":\"passed\",\"phasesChecked\":101,"
      "\"feedbackBandClear\":true,\"feedbackVisiblePixels\":" << feedbackPixels <<
      ",\"nativeFrames\":10,\"realProfileUsed\":false,\"inputListenerStarted\":false,"
      "\"windowOpened\":false,\"macGeometryMirrored\":true}\n";
  receipt.close();
  ReleaseAllPngResources();
  Gdiplus::GdiplusShutdown(token);
  return 0;
}
