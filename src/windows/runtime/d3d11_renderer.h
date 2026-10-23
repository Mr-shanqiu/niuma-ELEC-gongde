#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace niuma::runtime {

// Pixels and output surfaces use BGRA8, with RGB already multiplied by alpha.
// This backend performs no color-space conversion. The asset pipeline owns that
// policy, including the treatment of pixels along translucent edges.
struct PixelImage {
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t strideBytes = 0;
    std::vector<std::uint8_t> bgraPremultiplied;
};

struct Point2 {
    float x = 0;
    float y = 0;
};

struct ScissorRect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

struct Quad {
    // Physical client pixels, ordered top-left, top-right, bottom-right,
    // bottom-left before transformation. Concave/crossed quads are unsupported.
    std::array<Point2, 4> positions{};
    std::array<Point2, 4> uv{{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
    std::uint32_t textureId = 0;
    float opacity = 1;
    std::optional<ScissorRect> scissor;
};

struct AdapterInfo {
    std::wstring description;
    std::uint32_t vendorId = 0;
    std::uint32_t deviceId = 0;
    std::uint32_t featureLevel = 0;
    bool software = false;
    // Classification of reported adapter identity, not a performance verdict.
    // Unknown/virtual adapters must not be reported as proven hardware execution.
    std::string kind = "unknown";
    std::string classificationReason;
    bool hardwareAccelerated = false;
    std::uint32_t requestedDriverType = 0;
    std::uint32_t createdDriverType = 0;
    HRESULT hardwareCreateResult = E_PENDING;
    HRESULT warpCreateResult = E_PENDING;
    HRESULT getDescResult = E_PENDING;
    HRESULT queryAdapter1Result = E_PENDING;
    HRESULT getDesc1Result = E_PENDING;
    bool descriptor1Available = false;
    std::uint32_t descriptor1Flags = 0;
    std::wstring descriptor1Description;
    std::uint32_t descriptor1VendorId = 0;
    std::uint32_t descriptor1DeviceId = 0;
};

struct RendererStats {
    std::uint64_t drawCalls = 0;
    std::uint64_t quads = 0;
    std::uint64_t presents = 0;
    std::uint64_t diagnosticReadbacks = 0;
    std::uint64_t textureBytes = 0;
    std::uint32_t textureCount = 0;
    int width = 0;
    int height = 0;
};

// All methods, including destruction, must run on the owning render thread.
// The caller owns the HWND and must keep it alive until Shutdown completes.
// This class controls neither input/activation nor the window's hit-test region.
// There is no internal timer, automatic redraw, retry, or device-loss loop.
class D3D11Renderer final {
public:
    D3D11Renderer();
    ~D3D11Renderer();
    D3D11Renderer(const D3D11Renderer&) = delete;
    D3D11Renderer& operator=(const D3D11Renderer&) = delete;

    bool Initialize(HWND window, int width, int height,
                    bool allowSoftwareForTest = false);
    bool Resize(int width, int height);
    // Zero is reserved for failure; identifiers are valid only until removed
    // or Shutdown. Upload copies the pixels, so the caller may then release them.
    std::uint32_t AddTexture(const PixelImage& image);
    bool RemoveTexture(std::uint32_t textureId);
    void ClearTextures();
    bool Draw(const std::vector<Quad>& quads, bool present = true);
    bool Present();
    // Explicit diagnostic readback only. Call after Draw(..., false), before
    // Present. It never guesses which flip-model buffer was last presented.
    bool Capture(PixelImage& image);
    void Shutdown();

    const AdapterInfo& Adapter() const;
    const RendererStats& Stats() const;
    HRESULT LastError() const;
    const std::string& LastErrorMessage() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace niuma::runtime
