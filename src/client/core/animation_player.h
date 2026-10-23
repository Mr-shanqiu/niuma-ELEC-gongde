#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace niuma::client::core {

struct InputSnapshot;
using AnimationImageId = std::uint64_t;

struct AnimationPoint { float x = 0, y = 0; };
struct AnimationRect { float x = 0, y = 0, width = 0, height = 0; };

struct AnimationKeyframe {
  float t = 0;
  float x = 0, y = 0;
  float rotation = 0;
  float scale = 1;
  float scaleY = 1;
  float alpha = 1;
};

struct AppearanceLayer {
  AnimationImageId image = 0;
  // The existing package contract: bottom-origin 240 x 250 logical canvas.
  AnimationRect frame;
  AnimationPoint anchor{0.5f, 0.5f};
  bool smoothInterpolation = false;
  std::vector<AnimationKeyframe> keyframes;
};

struct WoodfishImages {
  AnimationImageId shadow = 0, body = 0, mallet = 0;
  std::uint32_t malletWidth = 0;
};

struct AnimationAction {
  bool active = false;
  std::uint64_t serial = 0;
  std::uint64_t startedMs = 0;
  std::uint32_t durationMs = 220;
};

struct AnimationQuad {
  AnimationImageId image = 0;
  // Top-origin physical client pixels, TL/TR/BR/BL. Both native backends use
  // this convention; the macOS adapter must not flip these points a second time.
  std::array<AnimationPoint, 4> positions{};
  std::array<AnimationPoint, 4> uv{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
  float opacity = 1;
  AnimationRect clip;
};

struct AnimationFrame {
  static constexpr std::size_t kMaximumQuads = 6;
  std::array<AnimationQuad, kMaximumQuads> quads{};
  std::size_t quadCount = 0;
  std::uint64_t revision = 0;
  bool valid = false;
  bool needsFrame = false;
  bool needsAnimationTick = false;
  bool showPlusOne = false;
  float progress = 0;
  float strikeAmount = 0;
  AnimationRect plusOneRect;
};

enum class AnimationError : std::uint8_t {
  None, NoScene, InvalidScene, InvalidAction, InvalidScale, MonotonicRegression,
  FrameRevisionExhausted,
};

// A single-owner scene evaluator, not an input counter or a graphics engine.
// SetAppearance receives already verified package data; it performs structural
// safety checks, never opens packages, decodes PNGs or bypasses signature checks.
// Only SetAppearance may allocate. Sample/SetAction/SetInput/Invalidate/ack do not.
class AnimationPlayer {
 public:
  static constexpr std::size_t kMaximumLayers = 6;
  static constexpr std::size_t kMaximumKeyframes = 8;
  static constexpr float kContactPhase = 0.42f;
  static constexpr float kPlusStartPhase = 0.30f;
  static constexpr float kPlusEndPhase = 0.70f;

  bool SetAppearance(const std::vector<AppearanceLayer>& layers, int plusY = 174);
  bool SetWoodfish(const WoodfishImages& images) noexcept;
  // Absolute action timing comes from InputCore (or the existing 800 ms scene
  // selection preview). Reapplying a snapshot never restarts an action clock.
  bool SetAction(const AnimationAction& action) noexcept;
  bool SetInput(const InputSnapshot& snapshot) noexcept;
  // pixelScale maps the 240 x 250 design canvas into physical pixels. For the
  // normal 120 x 125 DIP window this is DPI/192, not DPI/96.
  const AnimationFrame& Sample(std::uint64_t monotonicMs, float pixelScale = 1) noexcept;
  void Invalidate() noexcept;
  // Call only after successful presentation. An old completion cannot clear a
  // newer pending frame; a presentation failure leaves needsFrame set.
  bool MarkPresented(std::uint64_t revision) noexcept;
  AnimationError error() const noexcept { return error_; }

 private:
  enum class Scene : std::uint8_t { None, Appearance, Woodfish };
  bool Build(float progress, float strike, float pixelScale,
             AnimationFrame& output) const noexcept;
  Scene scene_ = Scene::None;
  std::vector<AppearanceLayer> layers_;
  WoodfishImages woodfish_;
  AnimationAction action_;
  AnimationFrame frame_;
  int plusY_ = 174;
  AnimationError error_ = AnimationError::None;
  std::uint64_t lastSampleMs_ = 0;
  std::uint64_t presentedRevision_ = 0;
  bool sampled_ = false;
  bool invalidated_ = true;
};

}  // namespace niuma::client::core
