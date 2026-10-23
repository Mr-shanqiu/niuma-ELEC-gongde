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

#include "weak_alpha_override.h"

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
    // Most recent successful Draw's sparse decisions and uploaded byte count.
    std::uint64_t weakAlphaEntries = 0;
    std::uint64_t weakAlphaBytes = 0;
    // Reusable GPU allocation, retained until Shutdown; bounded by 8 MiB.
    std::uint64_t weakAlphaBufferBytes = 0;
    int width = 0;
    int height = 0;
};

// Opt-in diagnostics only: timestamp interval on this device's GPU command
// stream, excluding Present. It is not GPU utilization, active execution time,
// DWM cost, energy, or the physical screen presentation interval.
enum class GpuTimingRead { Disabled, Pending, Ready, Invalid, Failed };
struct GpuTimingSample {
    std::uint64_t frame = 0;
    double intervalMs = 0;
};
struct GpuTimingStats {
    bool enabled = false;
    std::uint32_t pending = 0;
    std::uint64_t issued = 0, completed = 0, invalid = 0, dropped = 0;
    HRESULT error = S_OK;
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
    // Optional sparse decisions have one list per quad. A malformed, unsorted,
    // oversized or out-of-surface list fails before any frame is drawn. Upload
    // copies the lists; their storage may be released as soon as Draw returns.
    bool Draw(const std::vector<Quad>& quads, bool present = true,
              const WeakAlphaOverrides* weak = nullptr);
    bool Present();
    // Allocates exactly four query sets. Normal product use never enables it.
    // Reads are nonblocking and DONOTFLUSH; a full ring drops measurements,
    // never frames. Missing/disjoint results are distinct from a measured zero.
    bool EnableDiagnosticGpuTiming();
    GpuTimingRead ReadDiagnosticGpuTiming(GpuTimingSample& sample);
    const GpuTimingStats& DiagnosticGpuTimingStats() const;
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
