// Uses real Windows GDI/GDI+ without starting the client or its input hooks.
#include "../src/windows/render_cache.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iterator>

static void Check(bool condition, const char* name) {
  if (!condition) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}

static void DrawOriginal(Gdiplus::Graphics& graphics, const std::wstring& text,
    const Gdiplus::RectF& rect, float size, Gdiplus::FontStyle style) {
  Gdiplus::FontFamily family(L"Microsoft YaHei UI");
  Gdiplus::StringFormat format;
  format.SetAlignment(Gdiplus::StringAlignmentCenter);
  format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
  format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
  Gdiplus::GraphicsPath path;
  Check(path.AddString(text.c_str(), -1, &family, style, size, rect, &format) ==
      Gdiplus::Ok, "original glyph path");
  Gdiplus::Pen outline(Gdiplus::Color(190, 24, 24, 24), 1.5f);
  outline.SetLineJoin(Gdiplus::LineJoinRound);
  graphics.DrawPath(&outline, &path);
  Gdiplus::SolidBrush fill(Gdiplus::Color(255, 240, 139, 35));
  graphics.FillPath(&fill, &path);
}

static void DrawCached(Gdiplus::Graphics& graphics,
    niuma::render::WidgetGlyphCache& cache, const std::wstring& text,
    const Gdiplus::RectF& rect, float size, Gdiplus::FontStyle style) {
  const auto* path = cache.Get(text, rect, size, style);
  Check(path != nullptr, "cached glyph path");
  Gdiplus::Pen outline(Gdiplus::Color(190, 24, 24, 24), 1.5f);
  outline.SetLineJoin(Gdiplus::LineJoinRound);
  graphics.DrawPath(&outline, path);
  Gdiplus::SolidBrush fill(Gdiplus::Color(255, 240, 139, 35));
  graphics.FillPath(&fill, path);
}

template <class Operation> static double Milliseconds(Operation operation) {
  const auto begin = std::chrono::steady_clock::now();
  operation();
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - begin).count();
}

int main() {
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  Check(Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok, "GDI+ start");
  HDC screen = GetDC(nullptr);
  Check(screen != nullptr, "screen DC");
  unsigned pixelCases = 0;
  double originalMs = 0, cachedMs = 0;
  {
    niuma::render::LayeredSurface surface;
    Check(surface.Ensure(screen, 240, 250), "initial allocation");
    const auto firstDc = surface.dc();
    const auto firstPixels = surface.pixels();
    Check(surface.Ensure(screen, 240, 250) && surface.dc() == firstDc &&
        surface.pixels() == firstPixels, "same-size allocation reused");
    std::memset(surface.pixels(), 255, surface.bytes());
    surface.Clear();
    const auto* pixels = static_cast<const unsigned char*>(surface.pixels());
    Check(std::all_of(pixels, pixels + surface.bytes(), [](auto byte) { return byte == 0; }),
        "frame fully transparent after clear");
    Check(surface.Ensure(screen, 480, 676) && surface.bytes() == 480U * 676U * 4U,
        "DPI/countdown resize");
    Check(!surface.Ensure(screen, 0, 100), "invalid size refused");
    surface.Reset();
    surface.Reset();

    niuma::render::WidgetGlyphCache cache;
    niuma::render::LayeredSurface before, after;
    const std::wstring texts[] = {L"12345", L"18446744073709551615", L"距下班", L"Until off work", L"9"};
    for (int scale : {1, 2, 3}) {
      Check(before.Ensure(screen, 240 * scale, 338 * scale) &&
          after.Ensure(screen, 240 * scale, 338 * scale), "comparison surfaces");
      for (const auto style : {Gdiplus::FontStyleRegular, Gdiplus::FontStyleBold}) {
        for (std::size_t i = 0; i < std::size(texts); ++i) {
          before.Clear(); after.Clear();
          const float size = i == 1 ? 22.0f : 26.0f;
          const Gdiplus::RectF rect(0, 10.0f + static_cast<float>(i) * 45, 240, 40);
          {
            Gdiplus::Graphics a(before.dc()), b(after.dc());
            a.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
            b.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
            a.ScaleTransform(static_cast<float>(scale), static_cast<float>(scale));
            b.ScaleTransform(static_cast<float>(scale), static_cast<float>(scale));
            DrawOriginal(a, texts[i], rect, size, style);
            DrawCached(b, cache, texts[i], rect, size, style);
          }
          Check(std::memcmp(before.pixels(), after.pixels(), before.bytes()) == 0,
              "cached/uncached pixels identical");
          ++pixelCases;
        }
      }
    }
    const Gdiplus::RectF rect(0, 0, 240, 40);
    for (unsigned i = 0; i < 256; ++i)
      Check(cache.Get(std::to_wstring(i), rect, 26, Gdiplus::FontStyleRegular) != nullptr,
          "changing counter");
    Check(cache.size() == niuma::render::WidgetGlyphCache::kMaximumEntries,
        "glyph cache remains bounded");
    cache.Clear();
    Check(cache.size() == 0, "glyph cleanup");

    // Microbenchmark reports a component cost, not real-client CPU or latency.
    Check(after.Ensure(screen, 480, 676), "benchmark surface");
    const auto render = [&](bool cached) {
      for (int frame = 0; frame < 120; ++frame) {
        after.Clear();
        Gdiplus::Graphics graphics(after.dc());
        graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
        graphics.ScaleTransform(2.0f, 2.0f);
        const std::wstring duration = L"08:30:59";
        for (std::size_t digit = 0; digit < duration.size(); ++digit) {
          const Gdiplus::RectF cell(52 + static_cast<float>(digit) * 17, 286, 17, 42);
          if (cached) DrawCached(graphics, cache, duration.substr(digit, 1), cell, 24,
              Gdiplus::FontStyleRegular);
          else DrawOriginal(graphics, duration.substr(digit, 1), cell, 24,
              Gdiplus::FontStyleRegular);
        }
      }
    };
    originalMs = Milliseconds([&] { render(false); });
    cachedMs = Milliseconds([&] { render(true); });
    cache.Clear(); before.Reset(); after.Reset(); surface.Reset();
    // Warmed process resource count: repeated grow/shrink must not leak handles.
    const DWORD handlesBefore = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    for (int i = 0; i < 100; ++i) {
      Check(surface.Ensure(screen, 120 + (i % 3) * 120, 125 + (i % 2) * 44), "resize stress");
      surface.Clear();
    }
    surface.Reset();
    Check(GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) == handlesBefore,
        "surface handles released");
  }
  ReleaseDC(nullptr, screen);
  Gdiplus::GdiplusShutdown(token);
  std::printf("{\"status\":\"passed\",\"pixelCases\":%u,\"glyphLimit\":64,"
      "\"resizeIterations\":100,\"textComponentOriginalMs\":%.3f,"
      "\"textComponentCachedMs\":%.3f,\"clientExecuted\":false,"
      "\"inputHooksInstalled\":false}\n", pixelCases, originalMs, cachedMs);
}
