#include "../src/client/core/animation_player.h"
#include "../src/client/core/input_state.h"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>

namespace {
std::atomic<bool> watchAllocations{false};
std::atomic<unsigned> watchedAllocations{0};
}

void* operator new(std::size_t size) {
  if (watchAllocations.load(std::memory_order_relaxed)) ++watchedAllocations;
  if (void* value = std::malloc(size ? size : 1)) return value;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* value) noexcept { std::free(value); }
void operator delete[](void* value) noexcept { std::free(value); }
void operator delete(void* value, std::size_t) noexcept { std::free(value); }
void operator delete[](void* value, std::size_t) noexcept { std::free(value); }

namespace {
using namespace niuma::client::core;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

bool Near(float actual, float expected, float tolerance = 0.0002f) {
  return std::abs(actual - expected) <= tolerance;
}

void Point(AnimationPoint actual, float x, float y, float scale = 1) {
  CHECK(Near(actual.x, x * scale));
  CHECK(Near(actual.y, y * scale));
}

void Clip(const AnimationQuad& quad, float scale) {
  CHECK(quad.clip.x == 0 && quad.clip.y == 80 * scale);
  CHECK(quad.clip.width == 240 * scale && quad.clip.height == 170 * scale);
}

std::uint64_t Fingerprint(const std::string& path) {
  std::ifstream stream(path, std::ios::binary);
  CHECK(stream.good());
  std::uint64_t value = 14695981039346656037ULL;
  char byte = 0;
  while (stream.get(byte)) value = (value ^ static_cast<unsigned char>(byte)) * 1099511628211ULL;
  CHECK(stream.eof());
  return value;
}

AnimationKeyframe Key(float t, float x = 0, float y = 0, float rotation = 0,
                       float scale = 1, float scaleY = 1, float alpha = 1) {
  return {t, x, y, rotation, scale, scaleY, alpha};
}

// These fixture values are transcribed from the real accepted manifests, whose
// bytes are pinned below. The fingerprint is a test drift detector, never an
// import or signature validator.
std::vector<AppearanceLayer> Offwork() {
  return {
    {1, {22, 22.910685805422645f, 182.30303030303028f, 147.08931419457736f},
     {.5f, .5f}, false, {Key(0, 0, 6.778309409888357f)}},
    {2, {24.098883572567782f, 9.354066985645945f, 177.6555023923445f, 160.64593301435406f},
     {.5f, .5f}, false, {
       Key(0, 0, 10.303030303030305f), Key(.25f, 0, 10.303030303030305f),
       Key(.43f, 0, 6.236044657097288f), Key(.60f, 0, 6.236044657097288f),
       Key(.78f, 0, 10.303030303030305f), Key(1, 0, 10.303030303030305f)}},
    {3, {22, 0, 188, 170}, {.5f, .5f}, false, {
       Key(0, 5.247208931419458f, -13.556618819776714f), Key(.25f),
       Key(.43f, 0, -4.0669856459330145f), Key(.60f, 0, -4.0669856459330145f),
       Key(.78f), Key(1, 5.247208931419458f, -13.556618819776714f)}}
  };
}

std::vector<AppearanceLayer> Translation(bool smooth = false) {
  return {{11, {10, 20, 40, 20}, {.5f, .5f}, smooth,
           {Key(0), Key(1, 100, 20, 0, 1, 1, .5f)}}};
}

void OffworkGoldenGeometry() {
  struct Expected { std::uint64_t time; float capY, handX, handY; };
  const Expected expected[] = {
    {0, 69.6969697f, 27.2472089f, 93.5566188f},
    {250, 69.6969697f, 22, 80},
    {340, 71.7304625f, 22, 82.0334928f},
    {430, 73.7639553f, 22, 84.0669856f},
    {600, 73.7639553f, 22, 84.0669856f},
    {780, 69.6969697f, 22, 80},
    // At the action boundary the idle pose is restored, not replayed.
    {1000, 69.6969697f, 27.2472089f, 93.5566188f}
  };
  for (float scale : {.5f, 1.0f, 2.0f}) {
    AnimationPlayer player;
    CHECK(player.SetAppearance(Offwork()));
    CHECK(player.SetAction({true, 1, 0, 1000}));
    for (const auto& pose : expected) {
      const auto& frame = player.Sample(pose.time, scale);
      CHECK(frame.valid && frame.quadCount == 3);
      Point(frame.quads[0].positions[0], 22, 73.2216906f, scale);
      Point(frame.quads[0].positions[2], 204.3030303f, 220.3110048f, scale);
      Point(frame.quads[1].positions[0], 24.0988836f, pose.capY, scale);
      Point(frame.quads[2].positions[0], pose.handX, pose.handY, scale);
      for (std::size_t i = 0; i < frame.quadCount; ++i) {
        CHECK(frame.quads[i].image == i + 1 && frame.quads[i].opacity == 1);
        Clip(frame.quads[i], scale);
        Point(frame.quads[i].uv[0], 0, 0);
        Point(frame.quads[i].uv[2], 1, 1);
      }
      CHECK(frame.plusOneRect.x == 0 && frame.plusOneRect.y == 46 * scale);
      CHECK(frame.plusOneRect.width == 240 * scale && frame.plusOneRect.height == 30 * scale);
    }
  }
}

void AsymmetricAnchorAndMacCoordinateConvention() {
  AnimationPlayer player;
  CHECK(player.SetAppearance({{7, {10, 20, 40, 20}, {.25f, .75f}, false,
                              {Key(0, 3, 4, 90, 2, .5f, .25f)}}}));
  const auto& frame = player.Sample(0);
  // In the original bottom-origin Mac convention these corners are
  // (18,19), (18,99), (38,99), (38,19). Flip y once at the shared boundary.
  Point(frame.quads[0].positions[0], 18, 231);
  Point(frame.quads[0].positions[1], 18, 151);
  Point(frame.quads[0].positions[2], 38, 151);
  Point(frame.quads[0].positions[3], 38, 231);
  CHECK(frame.quads[0].opacity == .25f);
}

void RealWoodfishPackage() {
  AnimationPlayer player;
  CHECK(player.SetAppearance({
    {1, {26, 0, 214, 129}, {.5f, .5f}, false, {Key(0)}},
    {2, {101, 128, 186, 42}, {.86f, .5f}, false,
     {Key(0, 0, 0, 2), Key(.5f, 0, 0, 8), Key(1, 0, 0, 2)}}}));
  CHECK(player.SetAction({true, 1, 0, 1000}));
  auto frame = player.Sample(0);
  CHECK(frame.quadCount == 2);
  Point(frame.quads[0].positions[0], 26, 121);
  Point(frame.quads[0].positions[2], 240, 250);
  // Golden points independently evaluated from the accepted Mac anchor (.86,.5).
  Point(frame.quads[1].positions[0], 100.364555f, 85.595316f);
  frame = player.Sample(500);
  Point(frame.quads[1].positions[0], 99.634085f, 102.466500f);
  Point(frame.quads[1].positions[2], 289.669216f, 118.171562f);
}

void BuiltinWoodfishGeometry() {
  AnimationPlayer player;
  CHECK(player.SetWoodfish({10, 20, 30, 600}));
  CHECK(player.SetAction({true, 1, 0, 1000}));
  auto frame = player.Sample(0);
  CHECK(frame.quadCount == 4 && frame.strikeAmount == 0);
  Point(frame.quads[0].positions[0], 49.6f, 233.28f);
  Point(frame.quads[0].positions[2], 190.4f, 247.36f);
  Point(frame.quads[1].positions[0], 37.28f, 136.48f);
  Point(frame.quads[1].positions[2], 225.6f, 250);
  CHECK(frame.quads[2].image == 30 && frame.quads[3].image == 30);
  Point(frame.quads[2].uv[0], .18f, 0);
  Point(frame.quads[2].uv[2], 1, 1);
  Point(frame.quads[3].uv[1], 145.0f / 600.0f, 0);
  // Cropped shaft/head stay separate; their overlap and the outer .88 scale
  // are part of the existing accepted woodfish silhouette.
  Point(frame.quads[2].positions[0], 151.584004f, 78.968235f);
  Point(frame.quads[3].positions[0], 108.569155f, 82.103755f);
  frame = player.Sample(210);
  CHECK(Near(frame.strikeAmount, .5f));
  frame = player.Sample(420);
  CHECK(Near(frame.strikeAmount, 1));
  Point(frame.quads[2].positions[0], 151.268463f, 87.798143f);
  frame = player.Sample(710);
  CHECK(Near(frame.strikeAmount, .5f));
  frame = player.Sample(1000, .5f);
  CHECK(!frame.needsAnimationTick && frame.strikeAmount == 0);
  Point(frame.quads[1].positions[0], 37.28f, 136.48f, .5f);
  for (std::size_t i = 0; i < frame.quadCount; ++i) Clip(frame.quads[i], .5f);
}

void LinearAndSmoothInterpolation() {
  for (bool smooth : {false, true}) {
    AnimationPlayer player;
    CHECK(player.SetAppearance(Translation(smooth)));
    CHECK(player.SetAction({true, 1, 0, 1000}));
    const auto& frame = player.Sample(250);
    const float amount = smooth ? .15625f : .25f;
    Point(frame.quads[0].positions[0], 10 + 100 * amount, 210 - 20 * amount);
    CHECK(Near(frame.quads[0].opacity, 1 - .5f * amount));
  }
}

void IdleAckAndLateSampling() {
  AnimationPlayer player;
  CHECK(player.SetAppearance(Translation()));
  const auto idle = player.Sample(100);
  CHECK(idle.valid && idle.needsFrame && !idle.needsAnimationTick);
  CHECK(player.MarkPresented(idle.revision));
  auto frame = player.Sample(1000);
  CHECK(!frame.needsFrame && !frame.needsAnimationTick && frame.revision == idle.revision);
  CHECK(player.SetAction({true, 1, 1000, 1000}));
  frame = player.Sample(1500);
  CHECK(frame.needsFrame && frame.needsAnimationTick && Near(frame.progress, .5f));
  Point(frame.quads[0].positions[0], 60, 200);
  const auto first = frame.revision;
  CHECK(player.Sample(1500).needsFrame);  // No successful presentation yet.
  CHECK(player.MarkPresented(first));
  CHECK(!player.Sample(1500).needsFrame);
  frame = player.Sample(1900);  // Drop missed frames rather than replaying them.
  CHECK(Near(frame.progress, .9f));
  CHECK(frame.revision == first + 1 && !player.MarkPresented(first));
  CHECK(player.MarkPresented(frame.revision));
  frame = player.Sample(9000);
  CHECK(frame.needsFrame && !frame.needsAnimationTick && frame.progress == 0);
  Point(frame.quads[0].positions[0], 10, 210);
  CHECK(player.MarkPresented(frame.revision));
  CHECK(!player.Sample(9001).needsFrame && !player.Sample(9002).needsAnimationTick);
  player.Invalidate();
  frame = player.Sample(9003);
  CHECK(frame.needsFrame && frame.revision == first + 3);
  CHECK(player.MarkPresented(frame.revision));
  CHECK(!player.Sample(9004).needsFrame);
}

void PlateauAndPlusOneBoundaries() {
  AnimationPlayer player;
  CHECK(player.SetAppearance(Offwork()));
  CHECK(player.SetAction({true, 1, 0, 1000}));
  auto frame = player.Sample(430);
  CHECK(frame.showPlusOne && player.MarkPresented(frame.revision));
  frame = player.Sample(500);
  CHECK(frame.needsAnimationTick && !frame.needsFrame);  // Identical held pose.
  AnimationPlayer fixed;
  CHECK(fixed.SetAppearance({{1, {0, 0, 20, 20}, {.5f, .5f}, false, {Key(0)}}}));
  CHECK(fixed.SetAction({true, 1, 0, 1000}));
  CHECK(!fixed.Sample(299).showPlusOne);
  CHECK(fixed.Sample(300).showPlusOne);
  CHECK(fixed.Sample(700).showPlusOne);
  CHECK(!fixed.Sample(701).showPlusOne);
  CHECK(!fixed.Sample(1000).needsAnimationTick);
}

void InputCoreTempoIsAuthoritative() {
  constexpr LocalDate day = 20261024;
  InputCore input;
  CHECK(input.Initialize(0, day, nullptr, 0));
  AnimationPlayer player;
  CHECK(player.SetAppearance(Translation()));
  const auto hit = [&](std::uint64_t time) {
    CHECK(input.Observe({InputKind::KeyDown, false, time, day}) == ObserveResult::Counted);
    CHECK(player.SetInput(input.snapshot()));
  };
  hit(1000);
  CHECK(input.snapshot().strikeDurationMs == 220);
  hit(1100);
  CHECK(Near(player.Sample(1110).progress, .5f));  // Rapid hit did not restart.
  hit(1200);
  CHECK(!player.Sample(1220).needsAnimationTick);
  input.AdvanceAnimation(1220);
  hit(1300);
  CHECK(input.snapshot().strikeDurationMs == 140);
  CHECK(Near(player.Sample(1370).progress, .5f));
  input.AdvanceAnimation(1440);
  hit(1900);
  CHECK(input.snapshot().strikeDurationMs == 240);
  CHECK(Near(player.Sample(2020).progress, .5f));
  input.AdvanceAnimation(2140);
  hit(2501);
  for (unsigned i = 0; i < 100; ++i) hit(2502);
  CHECK(input.snapshot().suggestedDurationMs == 120);
  input.AdvanceAnimation(2721);
  hit(2722);
  CHECK(input.snapshot().strikeDurationMs == 120);
  CHECK(Near(player.Sample(2782).progress, .5f));
  CHECK(player.SetAction({true, 99, 3000, 800}));  // Existing selection preview.
  CHECK(Near(player.Sample(3400).progress, .5f));
  CHECK(!player.Sample(3800).needsAnimationTick);
}

void InvalidInputsAndRecovery() {
  AnimationPlayer player;
  CHECK(!player.Sample(0).valid && player.error() == AnimationError::NoScene);
  CHECK(player.SetAppearance(Translation()));
  const auto initial = player.Sample(10);
  CHECK(player.MarkPresented(initial.revision));
  CHECK(!player.SetAppearance({}));
  auto invalid = Translation();
  invalid[0].keyframes[1].t = 0;
  CHECK(!player.SetAppearance(invalid));
  invalid = Translation();
  invalid[0].frame.width = std::numeric_limits<float>::quiet_NaN();
  CHECK(!player.SetAppearance(invalid));
  invalid = Translation();
  invalid[0].keyframes.front().t = .1f;
  CHECK(!player.SetAppearance(invalid));
  invalid = Translation();
  invalid[0].keyframes[1].scaleY = 0;
  CHECK(!player.SetAppearance(invalid));
  invalid = Translation();
  invalid[0].keyframes.resize(9);
  CHECK(!player.SetAppearance(invalid));
  invalid = Translation();
  invalid.resize(7, invalid[0]);
  CHECK(!player.SetAppearance(invalid));
  CHECK(!player.SetAppearance(Translation(), 173));
  CHECK(!player.SetWoodfish({1, 2, 0, 600}));
  CHECK(!player.SetWoodfish({1, 2, 3, 108}));
  CHECK(!player.SetAction({true, 1, 0, 0}));
  CHECK(!player.SetInput(InputSnapshot{}));
  // Rejected replacement is transactional: the previous valid pose survives.
  auto frame = player.Sample(11);
  CHECK(frame.valid && !frame.needsFrame && frame.quads[0].image == 11);
  CHECK(!player.Sample(9).valid && player.error() == AnimationError::MonotonicRegression);
  CHECK(!player.MarkPresented(initial.revision));
  frame = player.Sample(12);
  CHECK(frame.valid && frame.needsFrame);
  CHECK(!player.Sample(13, 0).valid && player.error() == AnimationError::InvalidScale);
  CHECK(!player.Sample(13, std::numeric_limits<float>::infinity()).valid);
  CHECK(!player.Sample(13, std::numeric_limits<float>::max()).valid);
  CHECK(player.Sample(14, 1).valid);
}

void ClockEdges() {
  AnimationPlayer player;
  CHECK(player.SetAppearance(Translation()));
  CHECK(player.SetAction({true, 1, 500, 1000}));
  auto frame = player.Sample(0);
  CHECK(frame.valid && frame.progress == 0 && frame.needsAnimationTick);
  CHECK(player.MarkPresented(frame.revision));
  CHECK(!player.Sample(499).needsFrame);
  CHECK(player.Sample(500).progress == 0);
  CHECK(Near(player.Sample(1000).progress, .5f));
  AnimationPlayer edge;
  CHECK(edge.SetAppearance(Translation()));
  constexpr auto last = std::numeric_limits<std::uint64_t>::max();
  CHECK(edge.SetAction({true, 1, last - 100, 200}));
  CHECK(Near(edge.Sample(last).progress, .5f));  // No started+duration overflow.
}

void SamplingDoesNotAllocate() {
  AnimationPlayer player;
  CHECK(player.SetAppearance(Offwork()));
  InputSnapshot input;
  input.ready = input.striking = true;
  input.strikeDurationMs = 220;
  watchedAllocations = 0;
  watchAllocations = true;
  bool valid = true;
  for (std::uint64_t i = 0; i < 20000; ++i) {
    input.actionSerial = i / 220;
    input.strikeStartedMs = (i / 220) * 220;
    valid = player.SetInput(input) && valid;
    const auto& frame = player.Sample(i, i < 10000 ? .5f : 1.0f);
    valid = frame.valid && valid;
    if (frame.needsFrame) valid = player.MarkPresented(frame.revision) && valid;
    if (i % 2000 == 0) player.Invalidate();
  }
  watchAllocations = false;
  CHECK(valid && watchedAllocations == 0);
}
}  // namespace

int main(int argc, char** argv) {
  try {
    const std::string root = argc > 1 ? argv[1] : ".";
    CHECK(Fingerprint(root + "/assets/appearance-packs/offwork-button/manifest.json") ==
          0xd6a9bc6f4cb0751dULL);
    CHECK(Fingerprint(root + "/assets/appearance-packs/woodfish-sample/manifest.json") ==
          0x3e28055a2f61bff6ULL);
    const struct { const char* name; void (*run)(); } cases[] = {
      {"offwork real manifest geometry and three physical scales", OffworkGoldenGeometry},
      {"asymmetric anchor and shared Mac/Win coordinate convention", AsymmetricAnchorAndMacCoordinateConvention},
      {"real woodfish package rotation", RealWoodfishPackage},
      {"builtin woodfish geometry, crop, clip and strike easing", BuiltinWoodfishGeometry},
      {"linear and smoothstep interpolation", LinearAndSmoothInterpolation},
      {"idle, presentation acknowledgements and late sampling", IdleAckAndLateSampling},
      {"static plateau and +1 phase boundaries", PlateauAndPlusOneBoundaries},
      {"InputCore tempo remains authoritative", InputCoreTempoIsAuthoritative},
      {"invalid input rejection and recovery", InvalidInputsAndRecovery},
      {"future action and monotonic integer edges", ClockEdges},
      {"sampling and action updates allocate nothing", SamplingDoesNotAllocate}
    };
    for (const auto& test : cases) {
      test.run();
      std::cout << "PASS " << test.name << '\n';
    }
    std::cout << "PASS real manifest bindings; " << std::size(cases) << " animation cases\n";
    return 0;
  } catch (const std::exception& error) {
    watchAllocations = false;
    std::cerr << "FAIL " << error.what() << '\n';
    return 1;
  }
}
