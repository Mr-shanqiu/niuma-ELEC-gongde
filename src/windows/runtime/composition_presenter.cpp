#include "composition_presenter.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

namespace niuma::runtime {
namespace {
using Clock = std::chrono::steady_clock;
double Milliseconds(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
bool Equal(const Quad& a, const Quad& b) {
  if (a.textureId != b.textureId || a.opacity != b.opacity ||
      a.scissor.has_value() != b.scissor.has_value()) return false;
  if (a.scissor && (a.scissor->x != b.scissor->x || a.scissor->y != b.scissor->y ||
      a.scissor->width != b.scissor->width || a.scissor->height != b.scissor->height)) return false;
  for (std::size_t i = 0; i < a.positions.size(); ++i)
    if (a.positions[i].x != b.positions[i].x || a.positions[i].y != b.positions[i].y ||
        a.uv[i].x != b.uv[i].x || a.uv[i].y != b.uv[i].y) return false;
  return true;
}
}

bool CompositionPresenter::Fail(HRESULT error, const std::string& detail) {
  error_ = error; detail_ = detail; return false;
}
void CompositionPresenter::ForgetInstalledRegion() noexcept {
  installedRaster_ = AlphaRegionResult{};
  stats_.retainedRegionBytes = 0;
}
void CompositionPresenter::Invalidate() noexcept {
  frameValid_ = false;
  ForgetInstalledRegion();
}
bool CompositionPresenter::BackendFailure() {
  Invalidate();
  return Fail(renderer_.LastError(), renderer_.LastErrorMessage());
}
bool CompositionPresenter::Initialize(HWND window, int width, int height, bool software) {
  Shutdown();
  if (!renderer_.Initialize(window, width, height, software)) return BackendFailure();
  window_ = window; width_ = width; height_ = height;
  error_ = S_OK; detail_.clear();
  return true;
}
bool CompositionPresenter::Resize(int width, int height) {
  if (!window_) return Fail(E_UNEXPECTED, "Composition window is not initialized");
  if (width == width_ && height == height_) return true;
  if (!renderer_.Resize(width, height)) return BackendFailure();
  width_ = width; height_ = height; Invalidate();
  return true;
}
bool CompositionPresenter::SetTextures(const std::vector<CompositionTexture>& textures) {
  if (!window_) return Fail(E_UNEXPECTED, "Composition window is not initialized");
  if (textures.empty() || textures.size() > kMaximumTextures)
    return Fail(E_INVALIDARG, "Invalid composition texture count");
  std::uint64_t nextBytes = 0;
  for (std::size_t i = 0; i < textures.size(); ++i) {
    const auto& t = textures[i];
    if (!t.key || !t.version || !t.pixels || !t.pixels->width || !t.pixels->height ||
        t.pixels->width > 16384 || t.pixels->height > 16384)
      return Fail(E_INVALIDARG, "Texture identity or pixels are missing");
    const auto bytes = std::uint64_t(t.pixels->width) * t.pixels->height * 4;
    if (bytes > kResidentTextureLimit || nextBytes > kResidentTextureLimit - bytes)
      return Fail(E_OUTOFMEMORY, "Composition texture budget exceeded");
    nextBytes += bytes;
    for (std::size_t j = 0; j < i; ++j)
      if (textures[j].key == t.key) return Fail(E_INVALIDARG, "Duplicate composition texture key");
    // Do not trust a matching version to hide malformed source bytes.
    if (t.pixels->width > std::numeric_limits<std::uint32_t>::max() / 4 ||
        t.pixels->strideBytes < t.pixels->width * 4 ||
        std::uint64_t(t.pixels->strideBytes) * t.pixels->height > t.pixels->bgraPremultiplied.size())
      return Fail(E_INVALIDARG, "Incomplete composition texture pixels");
  }
  std::vector<Uploaded> next;
  std::vector<std::uint32_t> created;
  next.reserve(textures.size()); created.reserve(textures.size());
  auto transientBytes = stats_.residentTextureBytes;
  for (const auto& t : textures) {
    auto found = std::find_if(uploaded_.begin(), uploaded_.end(), [&](const Uploaded& u) {
      return u.key == t.key && u.version == t.version &&
          u.width == t.pixels->width && u.height == t.pixels->height;
    });
    if (found != uploaded_.end()) { next.push_back(*found); continue; }
    const auto bytes = std::uint64_t(t.pixels->width) * t.pixels->height * 4;
    if (bytes > kReplacementTextureLimit - transientBytes) {
      for (auto id : created) renderer_.RemoveTexture(id);
      return Fail(E_OUTOFMEMORY, "Composition replacement peak exceeded");
    }
    const auto id = renderer_.AddTexture(*t.pixels);
    if (!id) {
      for (auto previous : created) renderer_.RemoveTexture(previous);
      return BackendFailure();
    }
    created.push_back(id);
    next.push_back({t.key, t.version, bytes, id, t.pixels->width, t.pixels->height});
    transientBytes += bytes;
    ++stats_.textureUploads;
    stats_.peakTextureBytes = std::max(stats_.peakTextureBytes, transientBytes);
  }
  bool changed = !created.empty() || next.size() != uploaded_.size();
  for (const auto& old : uploaded_) {
    if (std::none_of(next.begin(), next.end(), [&](const Uploaded& n) { return n.id == old.id; })) {
      renderer_.RemoveTexture(old.id); changed = true;
    }
  }
  uploaded_ = std::move(next);
  stats_.residentTextureBytes = nextBytes;
  if (changed) frameValid_ = false;
  error_ = S_OK; detail_.clear();
  return true;
}
bool CompositionPresenter::DrawLatest(const std::vector<CompositionQuad>& source, PixelImage* diagnosticCapture) {
  if (!window_) return Fail(E_UNEXPECTED, "Composition window is not initialized");
  if (source.empty() || source.size() > kMaximumQuads)
    return Fail(E_INVALIDARG, "Invalid composition quad count");
  std::vector<Quad> quads;
  std::vector<PreparedAlphaQuad> masks;
  quads.reserve(source.size()); masks.reserve(source.size());
  for (const auto& q : source) {
    const auto found = std::find_if(uploaded_.begin(), uploaded_.end(),
        [&](const Uploaded& t) { return t.key == q.textureKey; });
    if (found == uploaded_.end() || !q.mask || !q.mask->success ||
        q.mask->width != found->width || q.mask->height != found->height)
      return Fail(E_INVALIDARG, "Composition quad has no matching prepared resource");
    auto quad = q.geometry; quad.textureId = found->id;
    quads.push_back(quad);
    masks.push_back(FromRendererPreparedQuad(quad, *q.mask));
  }
  if (!diagnosticCapture && frameValid_ && previous_.size() == quads.size() &&
      std::equal(previous_.begin(), previous_.end(), quads.begin(), Equal)) {
    ++stats_.unchangedFrames;
    error_ = S_OK; detail_.clear();
    return true;
  }
  const auto regionStart = Clock::now();
  auto region = BuildPreparedAlphaRegion(width_, height_, masks, &installedRaster_);
  if (!region.success) return Fail(E_INVALIDARG, region.error);
  stats_.lastRegionDetails = region.stats;
  // Region and GPU use the very same weak-edge decisions. USER owns the region
  // only after a successful call; a failed submission remains visibly failed.
  stats_.lastRegionInstallWallMs = 0;
  if (region.stats.nativeRegionReused) {
    ++stats_.nativeRegionReuses;
  } else {
    const auto installStarted = Clock::now();
    if (!SetWindowRgn(window_, region.region, FALSE)) {
      const DWORD error = GetLastError();
      Invalidate();
      return Fail(error ? HRESULT_FROM_WIN32(error) : E_FAIL, "Composition hit region could not be installed");
    }
    stats_.lastRegionInstallWallMs = Milliseconds(installStarted);
    region.ReleaseRegion();
    ++stats_.nativeRegionInstalls;
    ForgetInstalledRegion();
    // Bound actual allocation capacity, including empty/transparent coverage.
    const auto bytes = region.raster.rectangles.capacity() * sizeof(AlphaRegionRect);
    if (bytes <= kInstalledRegionByteLimit) {
      installedRaster_ = std::move(region.raster);
      stats_.retainedRegionBytes = bytes;
    }
  }
  stats_.lastRegionMs = Milliseconds(regionStart);
  const auto submitStart = Clock::now();
  if (!renderer_.Draw(quads, false, &region.weakOverrides)) return BackendFailure();
  stats_.lastDrawSubmitWallMs = Milliseconds(submitStart);
  const auto readbackStart = Clock::now();
  if (diagnosticCapture && !renderer_.Capture(*diagnosticCapture)) return BackendFailure();
  stats_.lastReadbackWallMs = diagnosticCapture ? Milliseconds(readbackStart) : 0;
  const auto presentStart = Clock::now();
  if (!renderer_.Present()) return BackendFailure();
  stats_.lastPresentWallMs = Milliseconds(presentStart);
  stats_.lastSubmitMs = Milliseconds(submitStart);
  previous_ = std::move(quads);
  frameValid_ = true;
  ++stats_.framesPresented;
  error_ = S_OK; detail_.clear();
  return true;
}
void CompositionPresenter::Shutdown() {
  renderer_.Shutdown();
  uploaded_.clear(); previous_.clear(); Invalidate();
  window_ = nullptr; width_ = height_ = 0;
  stats_.residentTextureBytes = 0;
}
}  // namespace niuma::runtime
