#include "layered_renderer.h"
#include "platform_compat.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace niuma::runtime {
namespace {
// Match the existing 8 MiB layered-surface bound. Includes the countdown band.
constexpr std::uint64_t kSurfaceBytes = 8ULL * 1024 * 1024;
constexpr std::uint64_t kTextureBytes = 52ULL * 1024 * 1024;
bool ValidSize(int w, int h) {
  return w > 0 && h > 0 && w <= 4096 && h <= 4096 &&
      std::uint64_t(w)*h*4 <= kSurfaceBytes;
}
}
bool LayeredRenderer::Fail(HRESULT error, const char* detail) {
  error_ = error; detail_ = detail; return false;
}
bool LayeredRenderer::Ready() {
  return (window_ && owner_ == GetCurrentThreadId()) || Fail(E_UNEXPECTED,"Compatibility display owner unavailable");
}
bool LayeredRenderer::Initialize(HWND window, int width, int height) {
  Shutdown();
  if (!IsWindow(window)) return Fail(E_INVALIDARG,"Compatibility window unavailable");
  const auto style = GetWindowLongPtrW(window,GWL_EXSTYLE);
  if (style & WS_EX_NOREDIRECTIONBITMAP) return Fail(E_INVALIDARG,"Compatibility HWND must be created without NOREDIRECTIONBITMAP");
  if (!(style & WS_EX_LAYERED)) {
    SetLastError(ERROR_SUCCESS);
    if (!SetWindowLongPtrW(window,GWL_EXSTYLE,style|WS_EX_LAYERED) && GetLastError())
      return Fail(HRESULT_FROM_WIN32(GetLastError()),"Enable layered window style");
  }
  SetWindowRgn(window,nullptr,FALSE);
  window_ = window; owner_ = GetCurrentThreadId();
  if (!Resize(width,height)) { window_ = nullptr; owner_ = 0; return false; }
  return true;
}
bool LayeredRenderer::Resize(int w, int h) {
  if (!Ready()) return false;
  if (!ValidSize(w,h)) return Fail(E_INVALIDARG,"Compatibility surface budget exceeded");
  HDC screen = GetDC(nullptr);
  const bool okay = screen && surface_.Ensure(screen,w,h);
  if (screen) ReleaseDC(nullptr,screen);
  if (!okay) return Fail(E_OUTOFMEMORY,"Create compatibility display surface");
  stats_.width = w; stats_.height = h; pending_ = false;
  error_ = S_OK; detail_.clear(); return true;
}
std::unique_ptr<LayeredRenderer::Texture> LayeredRenderer::Prepare(const PixelImage& p, bool updatable) {
  if (!p.width || !p.height || p.width > 16384 || p.height > 16384 ||
      p.strideBytes < std::uint64_t(p.width)*4 ||
      std::uint64_t(p.strideBytes)*p.height > p.bgraPremultiplied.size() ||
      std::uint64_t(p.strideBytes)*p.height > kTextureBytes) return nullptr;
  auto t = std::make_unique<Texture>(); t->updatable = updatable;
  t->pixels.width = p.width; t->pixels.height = p.height; t->pixels.strideBytes = p.strideBytes;
  const auto bytes = static_cast<std::size_t>(p.strideBytes)*p.height;
  t->pixels.bgraPremultiplied.assign(p.bgraPremultiplied.begin(),p.bgraPremultiplied.begin()+bytes);
  t->bitmap = std::make_unique<Gdiplus::Bitmap>(p.width,p.height,p.strideBytes,
      PixelFormat32bppPARGB,t->pixels.bgraPremultiplied.data());
  if (t->bitmap->GetLastStatus() != Gdiplus::Ok) return nullptr;
  return t;
}
std::uint32_t LayeredRenderer::AddTexture(const PixelImage& p, bool updatable) {
  if (!Ready()) return 0;
  const auto bytes = std::uint64_t(p.strideBytes)*p.height;
  if (!next_ || textures_.size() >= 20 || bytes > kTextureBytes ||
      stats_.textureBytes > kTextureBytes-bytes) { Fail(E_OUTOFMEMORY,"Compatibility texture budget exceeded"); return 0; }
  auto t = Prepare(p,updatable);
  if (!t) { Fail(E_INVALIDARG,"Invalid compatibility texture"); return 0; }
  const auto id = next_++; textures_.emplace(id,std::move(t));
  stats_.textureBytes += bytes; stats_.textureCount = static_cast<std::uint32_t>(textures_.size());
  ++stats_.textureCreations; error_ = S_OK; detail_.clear(); return id;
}
bool LayeredRenderer::UpdateTexture(std::uint32_t id, const PixelImage& p) {
  if (!Ready()) return false;
  const auto found = textures_.find(id);
  if (found == textures_.end() || !found->second->updatable ||
      found->second->pixels.width != p.width || found->second->pixels.height != p.height ||
      found->second->pixels.strideBytes != p.strideBytes ||
      p.bgraPremultiplied.size() < std::uint64_t(p.strideBytes)*p.height)
    return Fail(E_INVALIDARG,"Invalid compatibility texture update");
  // Bitmap keeps the same backing allocation; updates never re-decode images.
  std::memcpy(found->second->pixels.bgraPremultiplied.data(),p.bgraPremultiplied.data(),
      static_cast<std::size_t>(p.strideBytes)*p.height);
  ++stats_.textureUpdates; error_ = S_OK; detail_.clear(); return true;
}
bool LayeredRenderer::RemoveTexture(std::uint32_t id) {
  if (!Ready()) return false;
  const auto found = textures_.find(id);
  if (found == textures_.end()) return Fail(E_INVALIDARG,"Unknown compatibility texture");
  stats_.textureBytes -= std::uint64_t(found->second->pixels.strideBytes)*found->second->pixels.height;
  textures_.erase(found); stats_.textureCount = static_cast<std::uint32_t>(textures_.size());
  error_ = S_OK; detail_.clear(); return true;
}
bool LayeredRenderer::Draw(const std::vector<Quad>& quads) {
  if (!Ready()) return false;
  pending_ = false;
  if (quads.empty() || quads.size() > 12) return Fail(E_INVALIDARG,"Invalid compatibility draw count");
  // Validate the entire frame before touching the reusable output buffer.
  for (const auto& q : quads) {
    if (!textures_.count(q.textureId) || !std::isfinite(q.opacity) || q.opacity < 0 || q.opacity > 1)
      return Fail(E_INVALIDARG,"Invalid compatibility draw resource");
    for (unsigned i=0;i<4;++i) if (!std::isfinite(q.positions[i].x) || !std::isfinite(q.positions[i].y) ||
        !std::isfinite(q.uv[i].x) || !std::isfinite(q.uv[i].y) || q.uv[i].x < 0 || q.uv[i].x > 1 ||
        q.uv[i].y < 0 || q.uv[i].y > 1) return Fail(E_INVALIDARG,"Invalid compatibility draw geometry");
    // Shared animation emits affine rectangles with rectangular UV crops.
    if (std::abs(q.positions[2].x-q.positions[1].x-q.positions[3].x+q.positions[0].x) > .02f ||
        std::abs(q.positions[2].y-q.positions[1].y-q.positions[3].y+q.positions[0].y) > .02f ||
        q.uv[0].y != q.uv[1].y || q.uv[2].y != q.uv[3].y ||
        q.uv[0].x != q.uv[3].x || q.uv[1].x != q.uv[2].x ||
        q.uv[1].x <= q.uv[0].x || q.uv[3].y <= q.uv[0].y)
      return Fail(E_INVALIDARG,"Unsupported non-affine compatibility geometry");
  }
  surface_.Clear();
  Gdiplus::Bitmap target(stats_.width,stats_.height,stats_.width*4,PixelFormat32bppPARGB,
      static_cast<BYTE*>(surface_.pixels()));
  Gdiplus::Graphics graphics(&target);
  if (graphics.GetLastStatus() != Gdiplus::Ok) return Fail(E_FAIL,"Open compatibility frame");
  graphics.SetCompositingMode(Gdiplus::CompositingModeSourceOver);
  graphics.SetInterpolationMode(Gdiplus::InterpolationModeBilinear);
  graphics.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHalf);
  for (const auto& q : quads) {
    graphics.ResetClip();
    if (q.scissor && graphics.SetClip(Gdiplus::Rect(q.scissor->x,q.scissor->y,
        q.scissor->width,q.scissor->height)) != Gdiplus::Ok) return Fail(E_INVALIDARG,"Invalid compatibility scissor");
    const auto& t = *textures_.at(q.textureId);
    Gdiplus::PointF points[]={{q.positions[0].x,q.positions[0].y},
      {q.positions[1].x,q.positions[1].y},{q.positions[3].x,q.positions[3].y}};
    Gdiplus::ImageAttributes attributes;
    attributes.SetWrapMode(Gdiplus::WrapModeTileFlipXY);
    Gdiplus::ColorMatrix opacity = {{{1,0,0,0,0},{0,1,0,0,0},{0,0,1,0,0},
      {0,0,0,q.opacity,0},{0,0,0,0,1}}};
    if (q.opacity != 1) attributes.SetColorMatrix(&opacity);
    const auto result = graphics.DrawImage(t.bitmap.get(),points,3,
      q.uv[0].x*t.pixels.width,q.uv[0].y*t.pixels.height,
      (q.uv[1].x-q.uv[0].x)*t.pixels.width,(q.uv[3].y-q.uv[0].y)*t.pixels.height,
      Gdiplus::UnitPixel,&attributes);
    if (result != Gdiplus::Ok) return Fail(E_FAIL,"Draw prepared compatibility image");
  }
  graphics.Flush(Gdiplus::FlushIntentionSync);
  ++stats_.drawCalls; stats_.quads += quads.size(); pending_ = true;
  error_ = S_OK; detail_.clear(); return true;
}
bool LayeredRenderer::Present() {
  if (!Ready()) return false;
  if (!pending_) return Fail(E_UNEXPECTED,"No prepared compatibility frame");
  RECT bounds{}; if (!GetWindowRect(window_,&bounds)) return Fail(E_FAIL,"Read compatibility window location");
  POINT destination{bounds.left,bounds.top},source{}; SIZE size{stats_.width,stats_.height};
  BLENDFUNCTION blend{AC_SRC_OVER,0,255,AC_SRC_ALPHA};
  if (!UpdateLayeredWindow(window_,nullptr,&destination,&size,surface_.dc(),&source,0,&blend,ULW_ALPHA))
    return Fail(HRESULT_FROM_WIN32(GetLastError()),"Present compatibility frame");
  ++stats_.presents; pending_ = false; error_ = S_OK; detail_.clear(); return true;
}
bool LayeredRenderer::Capture(PixelImage& p) {
  if (!Ready() || !pending_) return Fail(E_UNEXPECTED,"No compatibility frame to capture");
  p.width=stats_.width;p.height=stats_.height;p.strideBytes=p.width*4;
  p.bgraPremultiplied.resize(surface_.bytes());
  std::memcpy(p.bgraPremultiplied.data(),surface_.pixels(),surface_.bytes());
  ++stats_.diagnosticReadbacks; return true;
}
void LayeredRenderer::Shutdown() {
  textures_.clear(); surface_.Reset(); window_=nullptr;owner_=0;next_=1;pending_=false;stats_={};
}
bool DisplayRenderer::Initialize(HWND window,int w,int h,bool softwareTest,bool layeredTest) {
  Shutdown();
  const auto style = GetWindowLongPtrW(window,GWL_EXSTYLE);
  layered_ = layeredTest || !(style & WS_EX_NOREDIRECTIONBITMAP);
  if (!layered_) return modern_.Initialize(window,w,h,softwareTest);
  // The caller selects its HWND style from the OS/component capability before
  // creation. Windows rejects NOREDIRECTIONBITMAP -> LAYERED conversion (87).
  // Device failures on a modern HWND keep the existing bounded recovery flow;
  // never conceal them with a failed late conversion or a software GPU.
  compatibility_.description=L"Prepared-pixel compatibility display";
  compatibility_.kind="cpu-layered";compatibility_.hardwareAccelerated=false;
  compatibility_.classificationReason="composition-unavailable-or-compatibility-test";
  return legacy_.Initialize(window,w,h);
}
} // namespace niuma::runtime
