// Real Windows GDI/GDI+ pixels, without starting the client or input hooks.
#include "../src/windows/runtime/widget_text_cache.h"
#include "../src/windows/render_cache.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
using namespace niuma::runtime;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

struct GdiLifetime {
    ULONG_PTR token = 0;
    HDC screen = nullptr;
    GdiLifetime() {
        Gdiplus::GdiplusStartupInput input;
        CHECK(Gdiplus::GdiplusStartup(&token, &input, nullptr) == Gdiplus::Ok);
        screen = GetDC(nullptr); CHECK(screen);
    }
    ~GdiLifetime() { if (screen) ReleaseDC(nullptr, screen); if (token) Gdiplus::GdiplusShutdown(token); }
};
WidgetTextInput Input() {
    WidgetTextInput input;
    input.merit = L"12345";
    input.countdownLabel = L"距下班";
    input.countdownDuration = L"08:30:59";
    input.countdownVisible = true;
    return input;
}
std::array<std::uint64_t, 3> Versions(const WidgetTextCache& cache) {
    return {cache.Get(WidgetTextSlot::Merit)->version,
        cache.Get(WidgetTextSlot::PlusOne)->version, cache.Get(WidgetTextSlot::Countdown)->version};
}

// Existing app.cpp/widget-glyph-cache rendering, repeated independently here
// against a DIB HDC. This reference never calls the new cache's raster helper.
void OriginalWidget(Gdiplus::Graphics& graphics, const std::wstring& text,
                    const Gdiplus::RectF& rect, float size, Gdiplus::Color color) {
    Gdiplus::FontFamily family(L"Microsoft YaHei UI");
    Gdiplus::StringFormat format;
    format.SetAlignment(Gdiplus::StringAlignmentCenter);
    format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
    Gdiplus::GraphicsPath path;
    CHECK(path.AddString(text.c_str(), -1, &family, Gdiplus::FontStyleRegular,
        size, rect, &format) == Gdiplus::Ok);
    Gdiplus::Pen outline(Gdiplus::Color(190, 24, 24, 24), 1.5f);
    outline.SetLineJoin(Gdiplus::LineJoinRound);
    Gdiplus::SolidBrush fill(color);
    CHECK(graphics.DrawPath(&outline, &path) == Gdiplus::Ok);
    CHECK(graphics.FillPath(&fill, &path) == Gdiplus::Ok);
}
void OriginalPlus(Gdiplus::Graphics& graphics, const std::wstring& text) {
    Gdiplus::Font font(L"Segoe UI", 22, Gdiplus::FontStyleBold, Gdiplus::UnitPixel);
    Gdiplus::StringFormat format;
    format.SetAlignment(Gdiplus::StringAlignmentCenter);
    format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    Gdiplus::SolidBrush brush(Gdiplus::Color(255, 240, 139, 35));
    CHECK(graphics.DrawString(text.c_str(), -1, &font, Gdiplus::RectF(0, 0, 240, 30),
        &format, &brush) == Gdiplus::Ok);
}
void CompareOriginal(HDC screen, WidgetTextSlot slot, const WidgetTextInput& input,
                     const WidgetTextImage& actual) {
    niuma::render::LayeredSurface reference;
    CHECK(reference.Ensure(screen, static_cast<int>(actual.pixels.width), static_cast<int>(actual.pixels.height)));
    reference.Clear();
    {
        Gdiplus::Graphics graphics(reference.dc());
        CHECK(graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver) == Gdiplus::Ok);
        graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
        graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
        graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
        graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
        const float physicalTop = std::round(actual.logicalRect.y * input.pixelScale);
        Gdiplus::Matrix transform(input.pixelScale, 0, 0, input.pixelScale, 0, -physicalTop);
        CHECK(graphics.SetTransform(&transform) == Gdiplus::Ok);
        if (slot == WidgetTextSlot::Merit) {
            const float size = input.merit.size() > 24 ? 18.0f : input.merit.size() > 18 ? 22.0f : 26.0f;
            OriginalWidget(graphics, input.merit, {0, 0, 240, 40}, size, Gdiplus::Color(255, 240, 139, 35));
        } else if (slot == WidgetTextSlot::PlusOne) OriginalPlus(graphics, input.plusOne);
        else {
            OriginalWidget(graphics, input.countdownLabel, {12, 258, 216, 28}, 20, Gdiplus::Color(255, 248, 244, 235));
            constexpr float cell = 17;
            const float left = (240 - cell * static_cast<float>(input.countdownDuration.size())) / 2;
            for (std::size_t i = 0; i < input.countdownDuration.size(); ++i)
                OriginalWidget(graphics, input.countdownDuration.substr(i, 1),
                    {left + cell * static_cast<float>(i), 286, cell, 42}, 24, Gdiplus::Color(255, 240, 139, 35));
        }
        graphics.Flush(Gdiplus::FlushIntentionSync);
    }
    CHECK(reference.bytes() == actual.pixels.bgraPremultiplied.size());
    if (std::memcmp(reference.pixels(), actual.pixels.bgraPremultiplied.data(), reference.bytes()) != 0) {
        const auto* expected = static_cast<const std::uint8_t*>(reference.pixels());
        std::uint64_t differences = 0; unsigned largest = 0;
        for (std::size_t i = 0; i < reference.bytes(); ++i) {
            const auto delta = static_cast<unsigned>(std::abs(static_cast<int>(expected[i]) - actual.pixels.bgraPremultiplied[i]));
            if (delta) ++differences;
            largest = std::max(largest, delta);
        }
        std::cerr << "slot=" << static_cast<unsigned>(slot) << " scale=" << input.pixelScale
            << " differing channels=" << differences << " largest=" << largest << '\n';
        CHECK(false);
    }
    CHECK(actual.mask.success && !actual.mask.supportRectangles.empty());
    const auto& pixels = actual.pixels.bgraPremultiplied;
    for (std::size_t i = 0; i < pixels.size(); i += 4)
        CHECK(pixels[i] <= pixels[i + 3] && pixels[i + 1] <= pixels[i + 3] && pixels[i + 2] <= pixels[i + 3]);
}

unsigned PixelReference(HDC screen) {
    unsigned cases = 0;
    for (float scale : {1.0f, 1.5f, 2.0f, 3.0f}) {
        WidgetTextCache cache;
        auto input = Input(); input.pixelScale = scale;
        for (int variant = 0; variant < 3; ++variant) {
            if (variant == 1) {
                input.merit = L"18446744073709551615";
                input.countdownLabel = L"Until off work";
                input.countdownDuration = L"--:--:--";
            } else if (variant == 2) {
                input.merit = L"123456789012345678901234567890";
                input.countdownLabel = L"已加班";
                input.countdownDuration = L"108:30:59";
            }
            const auto update = cache.Update(input);
            if (!update.success) std::cerr << update.error << '\n';
            CHECK(update.success);
            for (auto slot : {WidgetTextSlot::Merit, WidgetTextSlot::PlusOne, WidgetTextSlot::Countdown}) {
                CompareOriginal(screen, slot, input, *cache.Get(slot)); ++cases;
            }
        }
    }
    return cases;
}
void IndependentVersionsAndAnimationReuse() {
    WidgetTextCache cache;
    auto input = Input();
    CHECK(cache.Update(input).success);
    const auto before = Versions(cache);
    const auto draws = cache.Stats().redraws;
    const auto* plusPixels = cache.Get(WidgetTextSlot::PlusOne)->pixels.bgraPremultiplied.data();
    for (int frame = 0; frame < 120; ++frame) {
        input.plusVisible = (frame % 3) != 0;
        const auto update = cache.Update(input);
        CHECK(update.success && update.changedMask == 0 && Versions(cache) == before);
        CHECK(cache.Visible(WidgetTextSlot::PlusOne) == input.plusVisible);
        CHECK(cache.Get(WidgetTextSlot::PlusOne)->pixels.bgraPremultiplied.data() == plusPixels);
    }
    CHECK(cache.Stats().redraws == draws);
    input.countdownDuration = L"08:30:58";
    auto update = cache.Update(input);
    CHECK(update.success && update.changedMask == 4);
    CHECK(cache.Get(WidgetTextSlot::Merit)->version == before[0] && cache.Get(WidgetTextSlot::PlusOne)->version == before[1]);
    const auto clock = cache.Get(WidgetTextSlot::Countdown)->version;
    input.countdownVisible = false; input.countdownDuration = L"08:20:00";
    CHECK(cache.Update(input).success && cache.Get(WidgetTextSlot::Countdown)->version == clock);
    input.countdownVisible = true;
    CHECK(cache.Update(input).changedMask == 4);
}
void DpiAndRelevantStyleKeys() {
    WidgetTextCache cache;
    auto input = Input(); CHECK(cache.Update(input).success);
    auto before = Versions(cache);
    input.pixelScale = 2;
    auto update = cache.Update(input);
    CHECK(update.success && update.changedMask == 7);
    const auto after = Versions(cache);
    for (std::size_t i = 0; i < after.size(); ++i) CHECK(after[i] > before[i]);
    input.style.durationColor = 0xffeeeeee;
    update = cache.Update(input); CHECK(update.success && update.changedMask == 4);
    input.style.plusColor = 0xffeeeeee;
    update = cache.Update(input); CHECK(update.success && update.changedMask == 2);
    input.merit = L"12346";
    update = cache.Update(input); CHECK(update.success && update.changedMask == 1);
}
void RepeatedNumbersRemainBounded() {
    WidgetTextCache cache;
    auto input = Input(); CHECK(cache.Update(input).success);
    const auto bytes = cache.Stats().pixelBytes;
    for (int number = 0; number < 300; ++number) {
        input.merit = std::to_wstring(number);
        CHECK(cache.Update(input).success);
        CHECK(cache.Stats().entries == 3 && cache.Stats().pixelBytes == bytes &&
            cache.Stats().peakPixelBytes <= WidgetTextCache::kPixelByteLimit);
        std::uint64_t maskBytes = 0;
        for (auto slot : {WidgetTextSlot::Merit, WidgetTextSlot::PlusOne, WidgetTextSlot::Countdown})
            maskBytes += cache.Get(slot)->mask.storageBytes;
        CHECK(cache.Stats().maskBytes == maskBytes);
    }
    const auto version = cache.Get(WidgetTextSlot::Merit)->version;
    cache.Clear();
    CHECK(cache.Stats().entries == 0 && cache.Stats().pixelBytes == 0 && cache.Stats().maskBytes == 0);
    CHECK(!cache.Get(WidgetTextSlot::Merit) && !cache.Visible(WidgetTextSlot::Countdown));
    CHECK(cache.Update(input).success && cache.Get(WidgetTextSlot::Merit)->version > version);
}
void FailuresAreExplicitAndPreserveOldSlot() {
    WidgetTextCache cache;
    const auto good = Input(); CHECK(cache.Update(good).success);
    const auto before = Versions(cache);
    const auto* pixels = cache.Get(WidgetTextSlot::Merit)->pixels.bgraPremultiplied.data();
    auto bad = good; bad.pixelScale = 64;
    auto failure = cache.Update(bad);
    CHECK(!failure.success && !failure.error.empty() && failure.changedMask == 0);
    CHECK(Versions(cache) == before && cache.Get(WidgetTextSlot::Merit)->pixels.bgraPremultiplied.data() == pixels);
    bad = good; bad.pixelScale = std::numeric_limits<float>::quiet_NaN();
    CHECK(!cache.Update(bad).success && Versions(cache) == before);
    bad = good; bad.merit.clear();
    CHECK(!cache.Update(bad).success && Versions(cache) == before);
    bad = good; bad.style.widgetFamily = L"NiuMa deliberately missing font 9918";
    failure = cache.Update(bad);
    CHECK(!failure.success && !failure.error.empty() && Versions(cache) == before);
    const auto recovered = cache.Update(good);
    CHECK(recovered.success && recovered.changedMask == 0 && Versions(cache) == before);
}
} // namespace

int main() {
    try {
        GdiLifetime gdi;
        const auto pixelCases = PixelReference(gdi.screen);
        IndependentVersionsAndAnimationReuse();
        DpiAndRelevantStyleKeys();
        RepeatedNumbersRemainBounded();
        FailuresAreExplicitAndPreserveOldSlot();
        std::cout << "widget text cache: 5/5 groups, " << pixelCases
            << " exact GDI reference comparisons; no client/input hooks started\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
