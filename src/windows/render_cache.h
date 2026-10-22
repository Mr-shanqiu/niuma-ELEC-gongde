#pragma once

#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include <cstddef>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace niuma::render {

// Owned by the UI thread. Recreate only when the physical surface size changes.
class LayeredSurface {
 public:
  LayeredSurface() = default;
  ~LayeredSurface() { Reset(); }
  LayeredSurface(const LayeredSurface&) = delete;
  LayeredSurface& operator=(const LayeredSurface&) = delete;

  bool Ensure(HDC screen, int width, int height) {
    if (dc_ && width_ == width && height_ == height) return true;
    Reset();
    if (!screen || width <= 0 || height <= 0 ||
        static_cast<std::size_t>(width) >
            std::numeric_limits<std::size_t>::max() / 4 /
                static_cast<std::size_t>(height)) return false;
    dc_ = CreateCompatibleDC(screen);
    if (!dc_) return false;
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    bitmap_ = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels_, nullptr, 0);
    if (!bitmap_ || !pixels_) { Reset(); return false; }
    original_ = SelectObject(dc_, bitmap_);
    if (!original_ || original_ == HGDI_ERROR) {
      original_ = nullptr;
      Reset();
      return false;
    }
    width_ = width;
    height_ = height;
    return true;
  }

  void Clear() {
    if (pixels_) ZeroMemory(pixels_, bytes());
  }

  void Reset() {
    if (dc_ && original_) SelectObject(dc_, original_);
    if (bitmap_) DeleteObject(bitmap_);
    if (dc_) DeleteDC(dc_);
    dc_ = nullptr;
    bitmap_ = nullptr;
    original_ = nullptr;
    pixels_ = nullptr;
    width_ = height_ = 0;
  }

  HDC dc() const { return dc_; }
  void* pixels() const { return pixels_; }
  std::size_t bytes() const {
    return static_cast<std::size_t>(width_) * static_cast<std::size_t>(height_) * 4;
  }

 private:
  HDC dc_ = nullptr;
  HBITMAP bitmap_ = nullptr;
  HGDIOBJ original_ = nullptr;
  void* pixels_ = nullptr;
  int width_ = 0;
  int height_ = 0;
};

// Cache geometry, not rendered pixels: color, DPI transforms and antialiasing
// still come from the current draw. The bound prevents counters growing memory.
class WidgetGlyphCache {
 public:
  static constexpr std::size_t kMaximumEntries = 64;

  const Gdiplus::GraphicsPath* Get(const std::wstring& text,
      const Gdiplus::RectF& rect, float fontSize, Gdiplus::FontStyle style) {
    for (const auto& entry : entries_) {
      if (entry.text == text && entry.fontSize == fontSize && entry.style == style &&
          entry.rect.X == rect.X && entry.rect.Y == rect.Y &&
          entry.rect.Width == rect.Width && entry.rect.Height == rect.Height)
        return entry.path.get();
    }
    Gdiplus::FontFamily family(L"Microsoft YaHei UI");
    Gdiplus::StringFormat format;
    format.SetAlignment(Gdiplus::StringAlignmentCenter);
    format.SetLineAlignment(Gdiplus::StringAlignmentCenter);
    format.SetFormatFlags(Gdiplus::StringFormatFlagsNoWrap);
    auto path = std::make_unique<Gdiplus::GraphicsPath>();
    if (path->AddString(text.c_str(), -1, &family, style, fontSize, rect, &format) !=
        Gdiplus::Ok) return nullptr;
    Entry replacement{text, rect, fontSize, style, std::move(path)};
    if (entries_.size() < kMaximumEntries) {
      entries_.push_back(std::move(replacement));
      return entries_.back().path.get();
    }
    const auto slot = next_;
    entries_[slot] = std::move(replacement);
    next_ = (next_ + 1) % kMaximumEntries;
    return entries_[slot].path.get();
  }

  void Clear() { entries_.clear(); next_ = 0; }
  std::size_t size() const { return entries_.size(); }

 private:
  struct Entry {
    std::wstring text;
    Gdiplus::RectF rect;
    float fontSize;
    Gdiplus::FontStyle style;
    std::unique_ptr<Gdiplus::GraphicsPath> path;
  };
  std::vector<Entry> entries_;
  std::size_t next_ = 0;
};

}  // namespace niuma::render
