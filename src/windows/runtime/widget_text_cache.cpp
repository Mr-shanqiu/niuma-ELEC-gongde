#include "widget_text_cache.h"

#include <objidl.h>
#include <gdiplus.h>

#include <algorithm>
#include <cmath>
#include <chrono>
#include <limits>
#include <new>
#include <utility>
#include <vector>

namespace niuma::runtime {
namespace {
constexpr std::size_t SlotIndex(WidgetTextSlot slot) { return static_cast<std::size_t>(slot); }
struct TextKey {
    std::wstring first, second, family;
    float scale = 1, firstSize = 0, secondSize = 0, outlineWidth = 0;
    std::uint32_t firstColor = 0, secondColor = 0, outlineColor = 0;
    int fontStyle = 0;
    bool operator==(const TextKey& other) const {
        return first == other.first && second == other.second && family == other.family &&
            scale == other.scale && firstSize == other.firstSize && secondSize == other.secondSize &&
            outlineWidth == other.outlineWidth && firstColor == other.firstColor &&
            secondColor == other.secondColor && outlineColor == other.outlineColor && fontStyle == other.fontStyle;
    }
};
bool ValidSize(float value) { return std::isfinite(value) && value > 0 && value <= 128; }
bool ValidInput(const WidgetTextInput& input) {
    const auto& s = input.style;
    return std::isfinite(input.pixelScale) && input.pixelScale > 0 && input.pixelScale <= 64 &&
        input.merit.size() <= 128 && input.plusOne.size() <= 32 &&
        input.countdownLabel.size() <= 128 && input.countdownDuration.size() <= 32 &&
        (!input.meritVisible || !input.merit.empty()) && !input.plusOne.empty() &&
        (!input.countdownVisible || (!input.countdownLabel.empty() && !input.countdownDuration.empty())) &&
        !s.widgetFamily.empty() && s.widgetFamily.size() <= 128 &&
        !s.plusFamily.empty() && s.plusFamily.size() <= 128 &&
        ValidSize(s.meritFont) && ValidSize(s.longMeritFont) && ValidSize(s.longestMeritFont) &&
        ValidSize(s.plusFont) && ValidSize(s.labelFont) && ValidSize(s.durationFont) &&
        std::isfinite(s.outlineWidth) && s.outlineWidth >= 0 && s.outlineWidth <= 8 &&
        s.widgetFontStyle >= 0 && s.widgetFontStyle <= 15 && s.plusFontStyle >= 0 && s.plusFontStyle <= 15;
}
TextKey KeyFor(WidgetTextSlot slot, const WidgetTextInput& input) {
    TextKey key;
    const auto& s = input.style;
    key.scale = input.pixelScale;
    if (slot == WidgetTextSlot::PlusOne) {
        key.first = input.plusOne; key.family = s.plusFamily;
        key.firstSize = s.plusFont; key.firstColor = s.plusColor; key.fontStyle = s.plusFontStyle;
    } else {
        key.family = s.widgetFamily; key.fontStyle = s.widgetFontStyle;
        key.outlineColor = s.outlineColor; key.outlineWidth = s.outlineWidth;
        if (slot == WidgetTextSlot::Merit) {
            key.first = input.merit; key.firstColor = s.meritColor;
            key.firstSize = input.merit.size() > 24 ? s.longestMeritFont :
                input.merit.size() > 18 ? s.longMeritFont : s.meritFont;
        } else {
            key.first = input.countdownLabel; key.second = input.countdownDuration;
            key.firstSize = s.labelFont; key.secondSize = s.durationFont;
            key.firstColor = s.labelColor; key.secondColor = s.durationColor;
        }
    }
    return key;
}
bool Setup(Gdiplus::Graphics& graphics, const Gdiplus::Matrix& transform) {
    return graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver) == Gdiplus::Ok &&
        graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias) == Gdiplus::Ok &&
        graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic) == Gdiplus::Ok &&
        graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality) == Gdiplus::Ok &&
        graphics.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit) == Gdiplus::Ok &&
        graphics.SetTransform(&transform) == Gdiplus::Ok;
}
// Logical paths are independent of the raster transform, color and outline.
// Reuse the current widget family/format for both counters and clock. Retain
// only clock paths, whose labels and positional digits actually repeat;
// ever-increasing merit strings are deliberately not a path history.
class WidgetGlyphContext {
    struct Entry {
        std::wstring text;
        Gdiplus::RectF rect;
        float size;
        int style;
        std::size_t bytes;
        std::unique_ptr<Gdiplus::GraphicsPath> path;
    };
    WidgetTextCacheStats& stats_;
    std::wstring familyName_;
    std::unique_ptr<Gdiplus::FontFamily> family_;
    std::unique_ptr<Gdiplus::StringFormat> format_;
    std::vector<Entry> entries_;
    void ClearPaths() {
        entries_.clear();
        stats_.glyphEntries = stats_.glyphGeometryBytes = 0;
    }
public:
    explicit WidgetGlyphContext(WidgetTextCacheStats& stats) : stats_(stats) {}
    void Clear() {
        ClearPaths(); family_.reset(); format_.reset(); familyName_.clear();
    }
    const Gdiplus::GraphicsPath* Resolve(const TextKey& key, const std::wstring& text,
        const Gdiplus::RectF& rect, float size, bool retain,
        std::unique_ptr<Gdiplus::GraphicsPath>& transient) {
        if (!format_) {
            auto format = std::make_unique<Gdiplus::StringFormat>();
            if (format->SetAlignment(Gdiplus::StringAlignmentCenter) != Gdiplus::Ok ||
                format->SetLineAlignment(Gdiplus::StringAlignmentCenter) != Gdiplus::Ok ||
                format->SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap) != Gdiplus::Ok) return nullptr;
            format_ = std::move(format);
        }
        if (!family_ || key.family != familyName_) {
            auto family = std::make_unique<Gdiplus::FontFamily>(key.family.c_str());
            if (family->GetLastStatus() != Gdiplus::Ok) return nullptr;
            auto name = key.family;
            ClearPaths(); family_ = std::move(family); familyName_ = std::move(name);
            ++stats_.fontFamilyBuilds;
        }
        if (retain) for (const auto& entry : entries_) {
            if (entry.text == text && entry.size == size && entry.style == key.fontStyle &&
                entry.rect.X == rect.X && entry.rect.Y == rect.Y &&
                entry.rect.Width == rect.Width && entry.rect.Height == rect.Height) {
                ++stats_.glyphPathHits; return entry.path.get();
            }
        }
        transient = std::make_unique<Gdiplus::GraphicsPath>();
        if (transient->AddString(text.c_str(), -1, family_.get(), key.fontStyle, size, rect,
                format_.get()) != Gdiplus::Ok) return nullptr;
        ++stats_.glyphPathBuilds;
        const auto points = transient->GetPointCount();
        if (points < 0) return nullptr;
        const auto bytes = static_cast<std::size_t>(points) * (sizeof(Gdiplus::PointF) + sizeof(BYTE));
        if (!retain || bytes > WidgetTextCache::kGlyphGeometryByteLimit) return transient.get();
        // Oversized valid glyphs still draw via the transient original path.
        // Eviction changes preparation work only, never output or acceptance.
        entries_.reserve(WidgetTextCache::kGlyphEntryLimit);
        while (!entries_.empty() && (entries_.size() >= WidgetTextCache::kGlyphEntryLimit ||
            bytes > WidgetTextCache::kGlyphGeometryByteLimit - stats_.glyphGeometryBytes)) {
            stats_.glyphGeometryBytes -= entries_.front().bytes;
            entries_.erase(entries_.begin());
        }
        entries_.push_back({text, rect, size, key.fontStyle, bytes, std::move(transient)});
        stats_.glyphGeometryBytes += bytes; stats_.glyphEntries = entries_.size();
        return entries_.back().path.get();
    }
};
bool DrawWidget(Gdiplus::Graphics& graphics, const TextKey& key, const std::wstring& text,
                const Gdiplus::RectF& rect, float fontSize, std::uint32_t color,
                WidgetGlyphContext& glyphs, bool retain) {
    std::unique_ptr<Gdiplus::GraphicsPath> transient;
    const auto* path = glyphs.Resolve(key, text, rect, fontSize, retain, transient);
    if (!path) return false;
    Gdiplus::Pen outline(Gdiplus::Color(key.outlineColor), key.outlineWidth);
    Gdiplus::SolidBrush fill{Gdiplus::Color(color)};
    if (outline.GetLastStatus() != Gdiplus::Ok || fill.GetLastStatus() != Gdiplus::Ok ||
        outline.SetLineJoin(Gdiplus::LineJoinRound) != Gdiplus::Ok) return false;
    return graphics.DrawPath(&outline, path) == Gdiplus::Ok && graphics.FillPath(&fill, path) == Gdiplus::Ok;
}
bool Draw(Gdiplus::Graphics& graphics, WidgetTextSlot slot, const TextKey& key, WidgetGlyphContext& glyphs) {
    if (slot == WidgetTextSlot::Merit)
        return DrawWidget(graphics, key, key.first, {0, 0, 240, 40}, key.firstSize, key.firstColor, glyphs, false);
    if (slot == WidgetTextSlot::PlusOne) {
        Gdiplus::Font font(key.family.c_str(), key.firstSize, key.fontStyle, Gdiplus::UnitPixel);
        Gdiplus::StringFormat format;
        Gdiplus::SolidBrush brush{Gdiplus::Color(key.firstColor)};
        if (font.GetLastStatus() != Gdiplus::Ok || brush.GetLastStatus() != Gdiplus::Ok ||
            format.SetAlignment(Gdiplus::StringAlignmentCenter) != Gdiplus::Ok ||
            format.SetLineAlignment(Gdiplus::StringAlignmentCenter) != Gdiplus::Ok) return false;
        return graphics.DrawString(key.first.c_str(), -1, &font, Gdiplus::RectF(0, 0, 240, 30),
            &format, &brush) == Gdiplus::Ok;
    }
    if (!DrawWidget(graphics, key, key.first, {12, 258, 216, 28}, key.firstSize, key.firstColor, glyphs, true)) return false;
    constexpr float cellWidth = 17;
    const float left = (240 - cellWidth * static_cast<float>(key.second.size())) / 2;
    for (std::size_t i = 0; i < key.second.size(); ++i)
        if (!DrawWidget(graphics, key, std::wstring(1, key.second[i]),
                {left + cellWidth * static_cast<float>(i), 286, cellWidth, 42}, key.secondSize, key.secondColor, glyphs, true))
            return false;
    return true;
}
} // namespace

struct WidgetTextCache::Impl {
    struct Entry { TextKey key; WidgetTextImage image; };
    std::array<std::unique_ptr<Entry>, 3> entries;
    std::array<bool, 3> visible{};
    WidgetTextCacheStats stats;
    WidgetGlyphContext glyphs{stats};
    std::uint64_t nextVersion = 0;
    bool timingEnabled = false;
    WidgetTextTiming timing;

    bool Build(WidgetTextSlot slot, TextKey key, std::unique_ptr<Entry>& output, std::string& error) {
        using Clock = std::chrono::steady_clock;
        const auto started = timingEnabled ? Clock::now() : Clock::time_point{};
        // Extra two design units retain text antialiasing without a full-window
        // text texture. The rectangle remains aligned to physical texels.
        const float top = slot == WidgetTextSlot::Countdown ? 256 : slot == WidgetTextSlot::PlusOne ? -2 : 0;
        const float bottom = slot == WidgetTextSlot::Countdown ? 330 : slot == WidgetTextSlot::PlusOne ? 32 : 42;
        const double width = std::ceil(240.0 * key.scale);
        const double physicalTop = std::floor(static_cast<double>(top) * key.scale);
        const double height = std::ceil(static_cast<double>(bottom) * key.scale) - physicalTop;
        if (width < 1 || height < 1 || width > 16384 || height > 16384) {
            error = "widget text dimensions exceed renderer limits"; return false;
        }
        const auto bytes = static_cast<std::uint64_t>(width) * static_cast<std::uint64_t>(height) * 4;
        if (bytes > kPixelByteLimit - stats.pixelBytes) {
            error = "widget text replacement exceeds 2 MiB CPU pixel budget"; return false;
        }
        auto replacement = std::make_unique<Entry>();
        replacement->key = std::move(key);
        auto& image = replacement->image;
        image.pixels.width = static_cast<std::uint32_t>(width);
        image.pixels.height = static_cast<std::uint32_t>(height);
        image.pixels.strideBytes = image.pixels.width * 4;
        image.pixels.bgraPremultiplied.resize(static_cast<std::size_t>(bytes));
        const auto allocated = image.pixels.bgraPremultiplied.capacity();
        if (allocated > kPixelByteLimit - stats.pixelBytes) {
            error = "widget text allocation exceeds CPU pixel budget"; return false;
        }
        stats.peakPixelBytes = std::max(stats.peakPixelBytes, stats.pixelBytes + allocated);
        const auto& rasterKey = replacement->key;
        image.logicalRect = {0, static_cast<float>(physicalTop / rasterKey.scale),
            static_cast<float>(width / rasterKey.scale), static_cast<float>(height / rasterKey.scale)};
        const auto rasterStarted = timingEnabled ? Clock::now() : Clock::time_point{};
        {
            // Wrap our final premultiplied pixels; no second DIB or conversion
            // buffer is retained or copied on this path.
            Gdiplus::Bitmap bitmap(static_cast<INT>(image.pixels.width), static_cast<INT>(image.pixels.height),
                static_cast<INT>(image.pixels.strideBytes), PixelFormat32bppPARGB,
                image.pixels.bgraPremultiplied.data());
            if (bitmap.GetLastStatus() != Gdiplus::Ok) { error = "widget text bitmap creation failed"; return false; }
            Gdiplus::Graphics graphics(&bitmap);
            Gdiplus::Matrix transform(rasterKey.scale, 0, 0, rasterKey.scale, 0, static_cast<float>(-physicalTop));
            if (graphics.GetLastStatus() != Gdiplus::Ok || graphics.Clear(Gdiplus::Color(0, 0, 0, 0)) != Gdiplus::Ok ||
                !Setup(graphics, transform) || !Draw(graphics, slot, rasterKey, glyphs)) {
                error = "widget text drawing failed"; return false;
            }
            graphics.Flush(Gdiplus::FlushIntentionSync);
            if (graphics.GetLastStatus() != Gdiplus::Ok) { error = "widget text flush failed"; return false; }
        }
        if (timingEnabled) timing.rasterMs[SlotIndex(slot)] =
            std::chrono::duration<double,std::milli>(Clock::now()-rasterStarted).count();
        const auto maskStarted = timingEnabled ? Clock::now() : Clock::time_point{};
        image.mask = PrepareAlphaMask({image.pixels.bgraPremultiplied.data(), image.pixels.bgraPremultiplied.size(),
            image.pixels.width, image.pixels.height, image.pixels.strideBytes});
        if (!image.mask.success) { error = "widget text mask preparation failed: " + image.mask.error; return false; }
        stats.peakMaskBytes = std::max(stats.peakMaskBytes, stats.maskBytes + image.mask.storageBytes);
        if (timingEnabled) {
            timing.maskMs[SlotIndex(slot)] = std::chrono::duration<double,std::milli>(Clock::now()-maskStarted).count();
            timing.buildMs[SlotIndex(slot)] = std::chrono::duration<double,std::milli>(Clock::now()-started).count();
        }
        output = std::move(replacement);
        return true;
    }
};

WidgetTextCache::WidgetTextCache() : impl_(std::make_unique<Impl>()) {}
WidgetTextCache::~WidgetTextCache() = default;

WidgetTextUpdate WidgetTextCache::Update(const WidgetTextInput& input) {
    auto& state = *impl_;
    if (state.timingEnabled) state.timing = {};
    WidgetTextUpdate result;
    const auto fail = [&](const std::string& error) {
        result.error = error; ++state.stats.failures; return std::move(result);
    };
    if (!ValidInput(input)) return fail("widget text input or style is invalid");
    try {
        const std::array<bool, 3> active{input.meritVisible, true, input.countdownVisible};
        for (std::size_t i = 0; i < state.entries.size(); ++i) {
            if (!active[i]) continue;
            const auto slot = static_cast<WidgetTextSlot>(i);
            auto key = KeyFor(slot, input);
            auto& entry = state.entries[i];
            if (entry && entry->key == key) continue;
            if (state.nextVersion == std::numeric_limits<std::uint64_t>::max())
                return fail("widget text version exhausted");
            std::unique_ptr<Impl::Entry> replacement;
            std::string error;
            if (!state.Build(slot, std::move(key), replacement, error)) return fail(error);
            replacement->image.version = ++state.nextVersion;
            if (entry) {
                state.stats.pixelBytes -= entry->image.pixels.bgraPremultiplied.capacity();
                state.stats.maskBytes -= entry->image.mask.storageBytes;
            } else ++state.stats.entries;
            state.stats.pixelBytes += replacement->image.pixels.bgraPremultiplied.capacity();
            state.stats.maskBytes += replacement->image.mask.storageBytes;
            entry = std::move(replacement);
            ++state.stats.redraws[i];
            result.changedMask |= static_cast<std::uint8_t>(1u << i);
            if (state.timingEnabled) state.timing.changedMask = result.changedMask;
        }
        state.visible = {input.meritVisible, input.plusVisible, input.countdownVisible};
        result.success = true;
    } catch (const std::bad_alloc&) { return fail("widget text allocation failed"); }
    return result;
}

const WidgetTextImage* WidgetTextCache::Get(WidgetTextSlot slot) const noexcept {
    const auto i = SlotIndex(slot);
    return i < impl_->entries.size() && impl_->entries[i] ? &impl_->entries[i]->image : nullptr;
}
bool WidgetTextCache::Visible(WidgetTextSlot slot) const noexcept {
    const auto i = SlotIndex(slot);
    return i < impl_->visible.size() && impl_->visible[i];
}
const WidgetTextCacheStats& WidgetTextCache::Stats() const noexcept { return impl_->stats; }
void WidgetTextCache::EnableDiagnosticTiming(bool enabled) noexcept {
    impl_->timingEnabled = enabled;
    impl_->timing = {};
}
const WidgetTextTiming& WidgetTextCache::DiagnosticTiming() const noexcept { return impl_->timing; }
void WidgetTextCache::Clear() noexcept {
    impl_->glyphs.Clear();
    for (auto& entry : impl_->entries) entry.reset();
    impl_->visible.fill(false);
    impl_->stats.pixelBytes = impl_->stats.maskBytes = impl_->stats.entries = 0;
}

} // namespace niuma::runtime
