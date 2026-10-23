#pragma once

#include "../src/windows/runtime/d3d11_renderer.h"

#include <filesystem>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace niuma::runtime::p0 {

// Source-only diagnostic fixtures. This is not an importer and must not be
// linked into the client to bypass appearance-package signature validation.
inline constexpr char kOffworkManifestSha256[] =
    "360ca8cecda67f0edd3a8e678fdfe77bb91a13bb704c009c901734f51bef566c";

struct FixtureSourceFingerprint {
    const char* relativePath;
    const char* sha256;
};
// The CI harness verifies these before invoking the fixed-geometry fixture.
inline constexpr FixtureSourceFingerprint kFixtureSources[] = {
    {"assets/appearance-packs/offwork-button/manifest.json", kOffworkManifestSha256},
    {"assets/appearance-packs/offwork-button/base.png", "caad2caca774c9a8a376f2fd66bc80004a6179a86fd2da9604884612621e795d"},
    {"assets/appearance-packs/offwork-button/cap.png", "436a64cdbbbedc1665fdcb1cb20d8f515c18f85cead9226950ad3dbc1cdec2d3"},
    {"assets/appearance-packs/offwork-button/hand.png", "da831976360c0e5f959042462d0cd67393f3476e2f17444848aea88a1b78f430"},
    {"assets/woodfish.png", "e8a39c8cab37cb9c24089e977800070cc8fe1cbe7bc8707c02a9276891e9f386"},
    {"assets/mallet.png", "98f60366b8860f36f52e47b7510e4149213cae4fc194060cafc3afabe715e249"},
};

// The caller initializes COM on this thread before using these WIC helpers.
bool LoadPng(const std::filesystem::path& path, PixelImage& image, std::string& error);
bool SavePng(const std::filesystem::path& path, const PixelImage& image, std::string& error);

class FixtureScene final {
public:
    FixtureScene();
    ~FixtureScene();
    FixtureScene(const FixtureScene&) = delete;
    FixtureScene& operator=(const FixtureScene&) = delete;

    bool Load(D3D11Renderer& renderer, const std::filesystem::path& repoRoot, bool offwork);
    const std::vector<std::pair<std::uint32_t, PixelImage>>& Textures() const;
    // A single normalized action cycle. phase is clamped to [0,1]; scale maps
    // the existing 240 x 250 logical canvas into physical client pixels.
    std::vector<Quad> Quads(float phase, float scale) const;
    // Call while the renderer is alive, before Shutdown or loading a new device.
    void Clear(D3D11Renderer& renderer);
    std::string Name() const;
    std::string LastError() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace niuma::runtime::p0
