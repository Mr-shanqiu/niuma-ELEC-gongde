#include "animation_player.h"
#include "input_state.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace niuma::client::core {
namespace {

bool InRange(float value, float minimum, float maximum) noexcept {
  return std::isfinite(value) && value >= minimum && value <= maximum;
}

float SmoothStep(float value) noexcept {
  const float t = std::clamp(value, 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}

AnimationPoint Rotate(AnimationPoint point, float degrees) noexcept {
  constexpr float radiansPerDegree = 3.14159265358979323846f / 180.0f;
  const float c = std::cos(degrees * radiansPerDegree);
  const float s = std::sin(degrees * radiansPerDegree);
  return {point.x * c - point.y * s, point.x * s + point.y * c};
}

AnimationKeyframe AtPhase(const AppearanceLayer& layer, float phase) noexcept {
  const auto& keys = layer.keyframes;
  if (phase <= keys.front().t) return keys.front();
  if (phase >= keys.back().t) return keys.back();
  for (std::size_t i = 1; i < keys.size(); ++i) {
    if (phase > keys[i].t) continue;
    const auto& left = keys[i - 1];
    const auto& right = keys[i];
    float amount = (phase - left.t) / (right.t - left.t);
    if (layer.smoothInterpolation) amount = SmoothStep(amount);
    const auto mix = [amount](float a, float b) { return a + (b - a) * amount; };
    return {phase, mix(left.x, right.x), mix(left.y, right.y),
      mix(left.rotation, right.rotation), mix(left.scale, right.scale),
      mix(left.scaleY, right.scaleY), mix(left.alpha, right.alpha)};
  }
  return keys.back();
}

AnimationQuad Rectangle(AnimationImageId image, float x, float y,
                        float width, float height) noexcept {
  AnimationQuad result;
  result.image = image;
  result.positions = {{{x, y}, {x + width, y}, {x + width, y + height}, {x, y + height}}};
  return result;
}

bool PhysicalCanvas(AnimationQuad& quad, float scale) noexcept {
  for (auto& point : quad.positions) {
    point.x *= scale;
    point.y *= scale;
    if (!std::isfinite(point.x) || !std::isfinite(point.y)) return false;
  }
  // Keep subpixel clip coordinates here; each backend performs its explicit
  // outward/inward pixel rounding when translating the shared clip contract.
  quad.clip = {0, 80.0f * scale, 240.0f * scale, 170.0f * scale};
  return std::isfinite(quad.clip.y) && std::isfinite(quad.clip.width) &&
         std::isfinite(quad.clip.height);
}

bool SamePoint(AnimationPoint a, AnimationPoint b) noexcept { return a.x == b.x && a.y == b.y; }
bool SameRect(AnimationRect a, AnimationRect b) noexcept {
  return a.x == b.x && a.y == b.y && a.width == b.width && a.height == b.height;
}
bool SameVisual(const AnimationFrame& a, const AnimationFrame& b) noexcept {
  if (a.quadCount != b.quadCount || a.showPlusOne != b.showPlusOne ||
      !SameRect(a.plusOneRect, b.plusOneRect)) return false;
  for (std::size_t i = 0; i < a.quadCount; ++i) {
    const auto& left = a.quads[i];
    const auto& right = b.quads[i];
    if (left.image != right.image || left.opacity != right.opacity ||
        !SameRect(left.clip, right.clip)) return false;
    for (std::size_t j = 0; j < 4; ++j)
      if (!SamePoint(left.positions[j], right.positions[j]) || !SamePoint(left.uv[j], right.uv[j]))
        return false;
  }
  return true;
}

bool ValidLayer(const AppearanceLayer& layer) noexcept {
  const auto& f = layer.frame;
  if (!layer.image || !InRange(f.x, -480, 480) || !InRange(f.y, -480, 480) ||
      !InRange(f.width, 0, 480) || !InRange(f.height, 0, 480) ||
      f.width <= 0 || f.height <= 0 || !InRange(layer.anchor.x, 0, 1) ||
      !InRange(layer.anchor.y, 0, 1) || layer.keyframes.empty() ||
      layer.keyframes.size() > AnimationPlayer::kMaximumKeyframes ||
      layer.keyframes.front().t != 0) return false;
  float previous = -1;
  for (const auto& key : layer.keyframes) {
    if (!InRange(key.t, 0, 1) || key.t <= previous || !InRange(key.x, -480, 480) ||
        !InRange(key.y, -480, 480) || !InRange(key.rotation, -360, 360) ||
        !InRange(key.scale, 0.1f, 4) || !InRange(key.scaleY, 0.1f, 4) ||
        !InRange(key.alpha, 0, 1)) return false;
    previous = key.t;
  }
  return true;
}
}  // namespace

bool AnimationPlayer::SetAppearance(const std::vector<AppearanceLayer>& layers, int plusY) {
  // Current verified packs all reserve the same +1 text band (plus_y = 174).
  if (layers.empty() || layers.size() > kMaximumLayers || plusY != 174 ||
      !std::all_of(layers.begin(), layers.end(), ValidLayer)) {
    error_ = AnimationError::InvalidScene;
    return false;
  }
  layers_ = layers;
  scene_ = Scene::Appearance;
  plusY_ = plusY;
  invalidated_ = true;
  error_ = AnimationError::None;
  return true;
}

bool AnimationPlayer::SetWoodfish(const WoodfishImages& images) noexcept {
  if (!images.shadow || !images.body || !images.mallet || images.malletWidth <= 108) {
    error_ = AnimationError::InvalidScene;
    return false;
  }
  layers_.clear();
  woodfish_ = images;
  scene_ = Scene::Woodfish;
  plusY_ = 174;
  invalidated_ = true;
  error_ = AnimationError::None;
  return true;
}

bool AnimationPlayer::SetAction(const AnimationAction& action) noexcept {
  if (action.active && action.durationMs == 0) {
    error_ = AnimationError::InvalidAction;
    return false;
  }
  action_ = action;
  error_ = AnimationError::None;
  return true;
}

bool AnimationPlayer::SetInput(const InputSnapshot& snapshot) noexcept {
  if (!snapshot.ready || snapshot.strikeDurationMs <= 0) {
    error_ = AnimationError::InvalidAction;
    return false;
  }
  return SetAction({snapshot.striking, snapshot.actionSerial, snapshot.strikeStartedMs,
                    static_cast<std::uint32_t>(snapshot.strikeDurationMs)});
}

bool AnimationPlayer::Build(float progress, float strike, float pixelScale,
                            AnimationFrame& output) const noexcept {
  if (scene_ == Scene::Appearance) {
    for (const auto& layer : layers_) {
      const auto key = AtPhase(layer, progress);
      const auto& f = layer.frame;
      const float top = 250.0f - f.y - f.height;
      const AnimationPoint anchor{f.x + f.width * layer.anchor.x,
                                  top + f.height * (1.0f - layer.anchor.y)};
      auto quad = Rectangle(layer.image, f.x, top, f.width, f.height);
      quad.opacity = key.alpha;
      for (auto& point : quad.positions) {
        point.x = (point.x - anchor.x) * key.scale;
        point.y = (point.y - anchor.y) * key.scale * key.scaleY;
        point = Rotate(point, -key.rotation);
        point.x += anchor.x + key.x;
        point.y += anchor.y - key.y;
      }
      if (!PhysicalCanvas(quad, pixelScale)) return false;
      output.quads[output.quadCount++] = quad;
    }
  } else {
    output.quads[0] = Rectangle(woodfish_.shadow, 40, 231, 160, 16);
    output.quads[1] = Rectangle(woodfish_.body, 26, 121, 214, 129);
    output.quads[2] = Rectangle(woodfish_.mallet, -260, -28, 266, 54);
    output.quads[3] = Rectangle(woodfish_.mallet, -309, -27, 60, 54);
    output.quadCount = 4;
    const float width = static_cast<float>(woodfish_.malletWidth);
    const float shaftLeft = 108.0f / width;
    output.quads[2].uv = {{{shaftLeft, 0}, {1, 0}, {1, 1}, {shaftLeft, 1}}};
    const float headRight = std::min(145.0f, width) / width;
    output.quads[3].uv = {{{0, 0}, {headRight, 0}, {headRight, 1}, {0, 1}}};
    for (std::size_t i = 0; i < output.quadCount; ++i) {
      auto& quad = output.quads[i];
      for (auto& point : quad.positions) {
        if (i >= 2) {
          point = Rotate(point, -(3.0f + 2.2f * strike));
          point.x += 417.0f;
          point.y += 70.0f;
        }
        point.x = 120.0f + (point.x - 120.0f) * 0.88f;
        point.y = 250.0f + (point.y - 250.0f) * 0.88f;
      }
      if (!PhysicalCanvas(quad, pixelScale)) return false;
    }
  }
  output.plusOneRect = {0, (250.0f - static_cast<float>(plusY_) - 30.0f) * pixelScale,
                         240.0f * pixelScale, 30.0f * pixelScale};
  return std::isfinite(output.plusOneRect.y) && std::isfinite(output.plusOneRect.width) &&
         std::isfinite(output.plusOneRect.height);
}

const AnimationFrame& AnimationPlayer::Sample(std::uint64_t monotonicMs, float pixelScale) noexcept {
  const auto fail = [this](AnimationError error) -> const AnimationFrame& {
    error_ = error;
    frame_.valid = frame_.needsFrame = frame_.needsAnimationTick = false;
    return frame_;
  };
  if (scene_ == Scene::None) return fail(AnimationError::NoScene);
  if (!std::isfinite(pixelScale) || pixelScale <= 0) return fail(AnimationError::InvalidScale);
  if (sampled_ && monotonicMs < lastSampleMs_) return fail(AnimationError::MonotonicRegression);
  AnimationFrame next;
  next.valid = true;
  if (action_.active) {
    // Subtraction after the start check avoids underflow and start+duration
    // overflow. A delayed render samples now; it never replays missed cycles.
    if (monotonicMs < action_.startedMs) {
      next.needsAnimationTick = true;
    } else {
      const auto elapsed = monotonicMs - action_.startedMs;
      if (elapsed < action_.durationMs) {
        next.needsAnimationTick = true;
        next.progress = static_cast<float>(elapsed) / static_cast<float>(action_.durationMs);
        next.strikeAmount = next.progress < kContactPhase
            ? SmoothStep(next.progress / kContactPhase)
            : 1.0f - SmoothStep((next.progress - kContactPhase) / (1.0f - kContactPhase));
        next.showPlusOne = next.progress >= kPlusStartPhase && next.progress <= kPlusEndPhase;
      }
    }
  }
  if (!Build(next.progress, next.strikeAmount, pixelScale, next))
    return fail(AnimationError::InvalidScale);
  const bool changed = invalidated_ || !frame_.valid || !SameVisual(frame_, next);
  if (changed && frame_.revision == std::numeric_limits<std::uint64_t>::max())
    return fail(AnimationError::FrameRevisionExhausted);
  next.revision = frame_.revision + (changed ? 1 : 0);
  next.needsFrame = next.revision != presentedRevision_;
  frame_ = next;
  sampled_ = true;
  lastSampleMs_ = monotonicMs;
  invalidated_ = false;
  error_ = AnimationError::None;
  return frame_;
}

void AnimationPlayer::Invalidate() noexcept { invalidated_ = true; }

bool AnimationPlayer::MarkPresented(std::uint64_t revision) noexcept {
  if (!frame_.valid || revision == 0 || revision != frame_.revision) return false;
  presentedRevision_ = revision;
  frame_.needsFrame = false;
  return true;
}

}  // namespace niuma::client::core
