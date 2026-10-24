#pragma once

#include "d3d11_renderer.h"
#include "prepared_alpha_region.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace niuma::runtime {

enum class WidgetTextSlot : std::uint8_t { Merit = 0, PlusOne = 1, Countdown = 2 };

// Defaults reproduce app.cpp: outlined YaHei UI for merit/clock, and the
// separate Segoe UI bold DrawString path for +1. Colors are straight ARGB.
struct WidgetTextStyle {
    std::wstring widgetFamily = L"Microsoft YaHei UI";
    std::wstring plusFamily = L"Segoe UI";
    std::uint32_t meritColor = 0xfff08b23;
    std::uint32_t plusColor = 0xfff08b23;
    std::uint32_t labelColor = 0xfff8f4eb;
    std::uint32_t durationColor = 0xfff08b23;
    std::uint32_t outlineColor = 0xbe181818;
    float outlineWidth = 1.5f;
    float meritFont = 26, longMeritFont = 22, longestMeritFont = 18;
    float plusFont = 22, labelFont = 20, durationFont = 24;
    int widgetFontStyle = 0; // Gdiplus::FontStyleRegular
    int plusFontStyle = 1;   // Gdiplus::FontStyleBold
};

struct WidgetTextInput {
    std::wstring merit;
    std::wstring plusOne = L"+1";
    std::wstring countdownLabel;
    std::wstring countdownDuration;
    bool meritVisible = true;
    bool plusVisible = false;
    bool countdownVisible = false;
    float pixelScale = 1;
    WidgetTextStyle style;
};

struct WidgetTextRect { float x = 0, y = 0, width = 0, height = 0; };
struct WidgetTextImage {
    PixelImage pixels;
    PreparedAlphaMask mask;
    // Physical texel boundaries expressed in design units. Merit/clock use
    // their existing widget coordinates. +1 is relative to its caller-owned
    // (0, plusY) anchor; movement/visibility never changes the cached image.
    WidgetTextRect logicalRect;
    std::uint64_t version = 0;
};
struct WidgetTextUpdate {
    bool success = false;
    std::uint8_t changedMask = 0; // Bit position is WidgetTextSlot.
    std::string error;
};
struct WidgetTextCacheStats {
    std::uint64_t pixelBytes = 0;
    std::uint64_t peakPixelBytes = 0; // Includes old image plus replacement while drawing.
    std::uint64_t maskBytes = 0;
    // Retained masks plus a prepared replacement; excludes temporary span-work
    // allocations inside PrepareAlphaMask. Separately accounted from pixels.
    std::uint64_t peakMaskBytes = 0;
    std::array<std::uint64_t, 3> redraws{};
    std::uint64_t failures = 0;
    std::size_t entries = 0;
};
// Last Update only; disabled by default. No text or historical samples.
struct WidgetTextTiming {
    std::array<double, 3> buildMs{}, rasterMs{}, maskMs{};
    std::uint8_t changedMask = 0;
};

// A single UI/render owner; no filesystem access, PNG decode, timer or growing
// history. Keep GDI+ initialized while Update runs. At most one retained image
// per slot; a temporary replacement is also charged to the 2 MiB pixel budget.
// Visibility is outside the raster key. +1 is prepared even while hidden;
// hidden merit/clock skip work until visible again.
class WidgetTextCache final {
public:
    static constexpr std::size_t kPixelByteLimit = 2 * 1024 * 1024;
    WidgetTextCache();
    ~WidgetTextCache();
    WidgetTextCache(const WidgetTextCache&) = delete;
    WidgetTextCache& operator=(const WidgetTextCache&) = delete;

    // Each changed slot replaces atomically. On failure that slot retains its
    // previous pixels; earlier successful slot updates are reported in the
    // changedMask. Use a new complete view only when success is true.
    WidgetTextUpdate Update(const WidgetTextInput& input);
    const WidgetTextImage* Get(WidgetTextSlot slot) const noexcept;
    bool Visible(WidgetTextSlot slot) const noexcept;
    const WidgetTextCacheStats& Stats() const noexcept;
    void EnableDiagnosticTiming(bool enabled) noexcept;
    const WidgetTextTiming& DiagnosticTiming() const noexcept;
    // Releases images/masks. Version ids are never reused across Clear, so a
    // compositor cannot mistake a rebuilt texture for an old GPU upload.
    void Clear() noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace niuma::runtime
