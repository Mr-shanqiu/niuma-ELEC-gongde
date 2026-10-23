#include "d3d11_renderer.h"

#include <d3d11.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cwctype>
#include <iomanip>
#include <new>
#include <sstream>
#include <unordered_map>
#include <utility>

namespace niuma::runtime {
namespace {
using Microsoft::WRL::ComPtr;

constexpr std::size_t kMaxQuads = 4096;
constexpr int kMaxSurfaceDimension = 16384;
constexpr char kShader[] = R"hlsl(
struct VertexIn {
    float2 position : POSITION;
    float2 uv : TEXCOORD0;
    float opacity : TEXCOORD1;
};
struct VertexOut {
    float4 position : SV_POSITION;
    float2 uv : TEXCOORD0;
    float opacity : TEXCOORD1;
};
VertexOut VSMain(VertexIn input) {
    VertexOut output;
    output.position = float4(input.position, 0.0, 1.0);
    output.uv = input.uv;
    output.opacity = input.opacity;
    return output;
}
Texture2D image : register(t0);
Buffer<uint2> weakPixels : register(t1);
SamplerState imageSampler : register(s0);
cbuffer WeakParameters : register(b0) {
    uint weakOffset;
    uint weakCount;
    uint surfaceWidth;
    uint weakReserved;
    uint4 weakBounds; // inclusive left/top, exclusive right/bottom
};
float4 PSMain(VertexOut input) : SV_TARGET {
    // Both RGB and alpha must scale, since the input is premultiplied.
    float4 sampled = image.Sample(imageSampler, input.uv) * input.opacity;
    uint2 pixel = uint2(input.position.xy);
    if (weakCount != 0 && pixel.x >= weakBounds.x && pixel.x < weakBounds.z &&
        pixel.y >= weakBounds.y && pixel.y < weakBounds.w) {
        uint key = pixel.y * surfaceWidth + pixel.x;
        uint low = 0, high = weakCount;
        [loop] while (low < high) {
            uint middle = low + (high - low) / 2;
            uint2 entry = weakPixels.Load(weakOffset + middle);
            if (entry.x < key) low = middle + 1;
            else high = middle;
        }
        if (low < weakCount) {
            uint2 entry = weakPixels.Load(weakOffset + low);
            if (entry.x == key) {
                if (entry.y == 0) return float4(0, 0, 0, 0);
                // Only alpha 0/1-byte samples enter this sparse path. The CPU
                // decision is authoritative; retain the sampled straight color
                // while keeping the result valid premultiplied BGRA.
                const float alpha = 1.0 / 255.0;
                float3 rgb = sampled.a > 0
                    ? sampled.rgb * (alpha / sampled.a) : float3(0, 0, 0);
                return float4(clamp(rgb, 0.0, alpha), alpha);
            }
        }
    }
    return sampled;
}
)hlsl";

struct Vertex {
    float x, y, u, v, opacity;
};

struct WeakParameters {
    std::uint32_t offset = 0, count = 0, width = 0, reserved = 0;
    std::uint32_t left = 0, top = 0, right = 0, bottom = 0;
};
static_assert(sizeof(WeakAlphaPixel) == 8, "typed uint2 upload layout");
static_assert(sizeof(WeakParameters) == 32, "HLSL constant-buffer layout");

bool ValidSize(int width, int height) {
    return width > 0 && height > 0 && width <= kMaxSurfaceDimension &&
           height <= kMaxSurfaceDimension;
}

std::string HResultText(HRESULT result) {
    std::ostringstream text;
    text << "0x" << std::hex << std::uppercase << std::setw(8)
         << std::setfill('0') << static_cast<std::uint32_t>(result);
    return text.str();
}

void ClassifyAdapter(AdapterInfo& adapter) {
    std::wstring name = adapter.description + L" " + adapter.descriptor1Description;
    std::transform(name.begin(), name.end(), name.begin(),
        [](wchar_t value) { return static_cast<wchar_t>(std::towlower(value)); });
    const auto contains = [&name](const wchar_t* token) {
        return name.find(token) != std::wstring::npos;
    };
    const bool createdWithWarp = adapter.createdDriverType == D3D_DRIVER_TYPE_WARP;
    const bool softwareFlag = adapter.descriptor1Available &&
        (adapter.descriptor1Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
    const bool knownSoftwareIdentity = contains(L"basic render driver") || contains(L"warp") ||
        contains(L"software renderer") || contains(L"software rasterizer") ||
        contains(L"swiftshader") || contains(L"llvmpipe") ||
        (adapter.vendorId == 0x1414 && adapter.deviceId == 0x008c) ||
        (adapter.descriptor1VendorId == 0x1414 && adapter.descriptor1DeviceId == 0x008c);
    adapter.software = createdWithWarp || softwareFlag || knownSoftwareIdentity;
    adapter.hardwareAccelerated = false;
    if (adapter.software) {
        adapter.kind = "software";
        adapter.classificationReason = createdWithWarp ? "device-created-with-warp"
            : softwareFlag ? "dxgi-software-flag" : "known-software-adapter-identity";
        return;
    }
    const bool remoteFlag = adapter.descriptor1Available &&
        (adapter.descriptor1Flags & DXGI_ADAPTER_FLAG_REMOTE) != 0;
    const bool virtualIdentity = contains(L"virtual") || contains(L"vmware") ||
        contains(L"parallels") || contains(L"citrix") || contains(L"remote display") ||
        contains(L"hyper-v") || contains(L"virtio") || contains(L"qxl") ||
        adapter.vendorId == 0x15ad || adapter.vendorId == 0x80ee ||
        adapter.vendorId == 0x1af4 || adapter.vendorId == 0x1ab8;
    if (remoteFlag || virtualIdentity) {
        adapter.kind = "virtual";
        adapter.classificationReason = remoteFlag ? "dxgi-remote-flag" : "virtual-adapter-identity";
        return;
    }
    // A successful HARDWARE request alone is insufficient: Windows sessions can
    // still expose Basic Render Driver. Require a usable descriptor and known
    // physical GPU vendor; unfamiliar adapters remain usable but unclassified.
    const bool knownGpuVendor = adapter.vendorId == 0x8086 || adapter.vendorId == 0x10de ||
        adapter.vendorId == 0x1002 || adapter.vendorId == 0x5143 || adapter.vendorId == 0x17cb;
    const bool consistentIdentity = adapter.vendorId == adapter.descriptor1VendorId &&
        adapter.deviceId == adapter.descriptor1DeviceId;
    if (adapter.descriptor1Available && consistentIdentity && knownGpuVendor &&
        !adapter.description.empty() &&
        adapter.createdDriverType == D3D_DRIVER_TYPE_HARDWARE &&
        SUCCEEDED(adapter.hardwareCreateResult)) {
        adapter.kind = "hardware";
        adapter.classificationReason = "recognized-gpu-with-nonsoftware-dxgi-descriptor";
        adapter.hardwareAccelerated = true;
        return;
    }
    adapter.kind = "unknown";
    adapter.classificationReason = !adapter.descriptor1Available ? "adapter1-description-unavailable"
        : !consistentIdentity ? "inconsistent-adapter-descriptions" : "unrecognized-adapter-identity";
}
}  // namespace

struct D3D11Renderer::Impl {
    struct Texture {
        ComPtr<ID3D11ShaderResourceView> view;
        std::uint64_t bytes = 0;
    };

    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain1> swapChain;
    ComPtr<ID3D11RenderTargetView> targetView;
    ComPtr<IDCompositionDevice> composition;
    ComPtr<IDCompositionTarget> compositionTarget;
    ComPtr<IDCompositionVisual> visual;
    ComPtr<ID3D11VertexShader> vertexShader;
    ComPtr<ID3D11PixelShader> pixelShader;
    ComPtr<ID3D11InputLayout> inputLayout;
    ComPtr<ID3D11Buffer> vertices;
    ComPtr<ID3D11Buffer> weakBuffer;
    ComPtr<ID3D11ShaderResourceView> weakView;
    ComPtr<ID3D11Buffer> weakConstants;
    ComPtr<ID3D11BlendState> blend;
    ComPtr<ID3D11RasterizerState> rasterizer;
    ComPtr<ID3D11SamplerState> sampler;
    std::unordered_map<std::uint32_t, Texture> textures;
    std::vector<Vertex> uploadVertices;
    std::vector<WeakAlphaPixel> uploadWeakPixels;
    std::vector<WeakParameters> uploadWeakParameters;
    AdapterInfo adapter;
    RendererStats stats;
    HRESULT lastError = S_OK;
    std::string lastErrorMessage;
    std::uint32_t nextTexture = 1;
    std::size_t vertexCapacity = 0;
    std::size_t weakCapacity = 0;
    DWORD ownerThread = 0;
    bool initialized = false;
    bool framePending = false;

    bool Fail(HRESULT result, const std::string& operation) {
        lastError = result;
        lastErrorMessage = operation + ": " + HResultText(result);
        if (device && (result == DXGI_ERROR_DEVICE_REMOVED ||
                       result == DXGI_ERROR_DEVICE_RESET)) {
            lastErrorMessage += "; device reason " +
                                HResultText(device->GetDeviceRemovedReason());
        }
        return false;
    }

    void Succeed() {
        lastError = S_OK;
        lastErrorMessage.clear();
    }

    bool Ready(const char* operation) {
        if (!initialized) return Fail(E_UNEXPECTED, std::string(operation) + " before Initialize");
        if (ownerThread != GetCurrentThreadId()) {
            return Fail(RPC_E_WRONG_THREAD, std::string(operation) + " on another thread");
        }
        return true;
    }

    void Release() {
        initialized = false;
        framePending = false;
        if (visual) visual->SetContent(nullptr);
        if (compositionTarget) compositionTarget->SetRoot(nullptr);
        if (composition) composition->Commit();
        visual.Reset();
        compositionTarget.Reset();
        composition.Reset();
        if (context) {
            context->ClearState();
            context->Flush();
        }
        textures.clear();
        std::vector<Vertex>().swap(uploadVertices);
        std::vector<WeakAlphaPixel>().swap(uploadWeakPixels);
        std::vector<WeakParameters>().swap(uploadWeakParameters);
        weakView.Reset();
        weakBuffer.Reset();
        weakConstants.Reset();
        vertices.Reset();
        inputLayout.Reset();
        vertexShader.Reset();
        pixelShader.Reset();
        blend.Reset();
        rasterizer.Reset();
        sampler.Reset();
        targetView.Reset();
        swapChain.Reset();
        context.Reset();
        device.Reset();
        vertexCapacity = 0;
        weakCapacity = 0;
        nextTexture = 1;
        ownerThread = 0;
        stats = {};
        adapter = {};
    }

    bool CreateTarget() {
        ComPtr<ID3D11Texture2D> backBuffer;
        HRESULT result = swapChain->GetBuffer(0, IID_PPV_ARGS(backBuffer.GetAddressOf()));
        if (FAILED(result)) return Fail(result, "Get swapchain buffer");
        result = device->CreateRenderTargetView(backBuffer.Get(), nullptr,
                                               targetView.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create swapchain render target");
        return true;
    }

    bool CreatePipeline() {
        ComPtr<ID3DBlob> vertexCode, pixelCode, errors;
        const auto shaderFailure = [&](HRESULT result, const char* stage) {
            Fail(result, stage);
            if (errors && errors->GetBufferSize() > 0) {
                lastErrorMessage += "; ";
                lastErrorMessage.append(static_cast<const char*>(errors->GetBufferPointer()),
                    errors->GetBufferSize());
                while (!lastErrorMessage.empty() && lastErrorMessage.back() == '\0') {
                    lastErrorMessage.pop_back();
                }
            }
            return false;
        };
        constexpr UINT flags = D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3;
        HRESULT result = D3DCompile(kShader, sizeof(kShader) - 1, "niuma-sprite", nullptr,
                                   nullptr, "VSMain", "vs_4_0", flags, 0,
                                   vertexCode.GetAddressOf(), errors.GetAddressOf());
        if (FAILED(result)) return shaderFailure(result, "Compile fixed sprite vertex shader");
        errors.Reset();
        result = D3DCompile(kShader, sizeof(kShader) - 1, "niuma-sprite", nullptr,
                            nullptr, "PSMain", "ps_4_0", flags, 0,
                            pixelCode.GetAddressOf(), errors.GetAddressOf());
        if (FAILED(result)) return shaderFailure(result, "Compile fixed sprite pixel shader");
        result = device->CreateVertexShader(vertexCode->GetBufferPointer(),
            vertexCode->GetBufferSize(), nullptr, vertexShader.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sprite vertex shader");
        result = device->CreatePixelShader(pixelCode->GetBufferPointer(),
            pixelCode->GetBufferSize(), nullptr, pixelShader.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sprite pixel shader");
        const D3D11_INPUT_ELEMENT_DESC elements[] = {
            {"POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 1, DXGI_FORMAT_R32_FLOAT, 0, 16, D3D11_INPUT_PER_VERTEX_DATA, 0},
        };
        result = device->CreateInputLayout(elements, 3, vertexCode->GetBufferPointer(),
            vertexCode->GetBufferSize(), inputLayout.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sprite input layout");

        D3D11_BLEND_DESC blendDesc{};
        auto& blendTarget = blendDesc.RenderTarget[0];
        blendTarget.BlendEnable = TRUE;
        blendTarget.SrcBlend = D3D11_BLEND_ONE;
        blendTarget.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        blendTarget.BlendOp = D3D11_BLEND_OP_ADD;
        blendTarget.SrcBlendAlpha = D3D11_BLEND_ONE;
        blendTarget.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        blendTarget.BlendOpAlpha = D3D11_BLEND_OP_ADD;
        blendTarget.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        result = device->CreateBlendState(&blendDesc, blend.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create premultiplied blend state");

        D3D11_RASTERIZER_DESC rasterDesc{};
        rasterDesc.FillMode = D3D11_FILL_SOLID;
        rasterDesc.CullMode = D3D11_CULL_NONE;
        rasterDesc.ScissorEnable = TRUE;
        rasterDesc.DepthClipEnable = TRUE;
        result = device->CreateRasterizerState(&rasterDesc, rasterizer.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sprite rasterizer");

        D3D11_SAMPLER_DESC samplerDesc{};
        samplerDesc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        samplerDesc.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
        samplerDesc.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
        samplerDesc.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        samplerDesc.MaxAnisotropy = 1;
        samplerDesc.ComparisonFunc = D3D11_COMPARISON_NEVER;
        samplerDesc.MinLOD = 0;
        samplerDesc.MaxLOD = D3D11_FLOAT32_MAX;
        result = device->CreateSamplerState(&samplerDesc, sampler.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sprite sampler");
        D3D11_BUFFER_DESC weakDesc{};
        weakDesc.ByteWidth = sizeof(WeakParameters);
        weakDesc.Usage = D3D11_USAGE_DYNAMIC;
        weakDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        weakDesc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        result = device->CreateBuffer(&weakDesc, nullptr, weakConstants.GetAddressOf());
        if (FAILED(result)) return Fail(result, "Create sparse alpha constants");
        return true;
    }
};

D3D11Renderer::D3D11Renderer() : impl_(std::make_unique<Impl>()) {}
D3D11Renderer::~D3D11Renderer() { Shutdown(); }

bool D3D11Renderer::Initialize(HWND window, int width, int height, bool allowSoftwareForTest) {
    auto& state = *impl_;
    state.Release();
    state.Succeed();
    if (!IsWindow(window) || !ValidSize(width, height)) {
        return state.Fail(E_INVALIDARG, "Initialize HWND or surface size");
    }
    // A failed initialization releases every partial COM resource, while keeping
    // its original error available to the caller.
    const auto releaseFailed = [&state]() {
        auto adapterDetails = std::move(state.adapter);
        state.Release();
        state.adapter = std::move(adapterDetails);
        return false;
    };
    const auto failed = [&state, &releaseFailed](HRESULT result, const char* operation) {
        state.Fail(result, operation);
        return releaseFailed();
    };
    constexpr D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL level{};
    state.adapter.requestedDriverType = D3D_DRIVER_TYPE_HARDWARE;
    HRESULT result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 3, D3D11_SDK_VERSION,
        state.device.GetAddressOf(), &level, state.context.GetAddressOf());
    state.adapter.hardwareCreateResult = result;
    if (SUCCEEDED(result)) state.adapter.createdDriverType = D3D_DRIVER_TYPE_HARDWARE;
    if (FAILED(result) && allowSoftwareForTest) {
        state.context.Reset();
        state.device.Reset();
        result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 3, D3D11_SDK_VERSION,
            state.device.GetAddressOf(), &level, state.context.GetAddressOf());
        state.adapter.warpCreateResult = result;
        state.adapter.createdDriverType = SUCCEEDED(result)
            ? D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_UNKNOWN;
    }
    if (FAILED(result)) return failed(result, "Create D3D11 device");

    ComPtr<IDXGIDevice> dxgiDevice;
    result = state.device.As(&dxgiDevice);
    if (FAILED(result)) return failed(result, "Get DXGI device");
    ComPtr<IDXGIAdapter> adapter;
    result = dxgiDevice->GetAdapter(adapter.GetAddressOf());
    if (FAILED(result)) return failed(result, "Get DXGI adapter");
    DXGI_ADAPTER_DESC adapterDesc{};
    result = adapter->GetDesc(&adapterDesc);
    state.adapter.getDescResult = result;
    if (FAILED(result)) return failed(result, "Read adapter description");
    state.adapter.description = adapterDesc.Description;
    state.adapter.vendorId = adapterDesc.VendorId;
    state.adapter.deviceId = adapterDesc.DeviceId;
    state.adapter.featureLevel = static_cast<std::uint32_t>(level);
    ComPtr<IDXGIAdapter1> adapter1;
    state.adapter.queryAdapter1Result = adapter.As(&adapter1);
    if (SUCCEEDED(state.adapter.queryAdapter1Result)) {
        DXGI_ADAPTER_DESC1 desc1{};
        state.adapter.getDesc1Result = adapter1->GetDesc1(&desc1);
        if (SUCCEEDED(state.adapter.getDesc1Result)) {
            state.adapter.descriptor1Available = true;
            state.adapter.descriptor1Flags = desc1.Flags;
            state.adapter.descriptor1Description = desc1.Description;
            state.adapter.descriptor1VendorId = desc1.VendorId;
            state.adapter.descriptor1DeviceId = desc1.DeviceId;
        }
    }
    ClassifyAdapter(state.adapter);
    if (state.adapter.software && !allowSoftwareForTest) {
        return failed(DXGI_ERROR_UNSUPPORTED, "Software adapter disallowed");
    }

    ComPtr<IDXGIFactory2> factory;
    result = adapter->GetParent(IID_PPV_ARGS(factory.GetAddressOf()));
    if (FAILED(result)) return failed(result, "Get composition swapchain factory");
    DXGI_SWAP_CHAIN_DESC1 swapDesc{};
    swapDesc.Width = static_cast<UINT>(width);
    swapDesc.Height = static_cast<UINT>(height);
    swapDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    swapDesc.SampleDesc.Count = 1;
    swapDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swapDesc.BufferCount = 2;
    swapDesc.Scaling = DXGI_SCALING_STRETCH;
    swapDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    swapDesc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
    result = factory->CreateSwapChainForComposition(state.device.Get(), &swapDesc,
        nullptr, state.swapChain.GetAddressOf());
    if (FAILED(result)) return failed(result, "Create transparent composition swapchain");
    result = DCompositionCreateDevice(dxgiDevice.Get(),
        __uuidof(IDCompositionDevice), reinterpret_cast<void**>(state.composition.GetAddressOf()));
    if (FAILED(result)) return failed(result, "Create DirectComposition device");
    result = state.composition->CreateTargetForHwnd(window, TRUE,
        state.compositionTarget.GetAddressOf());
    if (FAILED(result)) return failed(result, "Attach composition target to HWND");
    result = state.composition->CreateVisual(state.visual.GetAddressOf());
    if (FAILED(result)) return failed(result, "Create composition visual");
    result = state.visual->SetContent(state.swapChain.Get());
    if (FAILED(result)) return failed(result, "Attach swapchain content");
    result = state.compositionTarget->SetRoot(state.visual.Get());
    if (FAILED(result)) return failed(result, "Set composition root");
    if (!state.CreateTarget() || !state.CreatePipeline()) {
        return releaseFailed();
    }
    result = state.composition->Commit();
    if (FAILED(result)) return failed(result, "Commit composition tree");
    state.stats.width = width;
    state.stats.height = height;
    state.ownerThread = GetCurrentThreadId();
    state.initialized = true;
    state.Succeed();
    return true;
}

bool D3D11Renderer::Resize(int width, int height) {
    auto& state = *impl_;
    if (!state.Ready("Resize")) return false;
    if (!ValidSize(width, height)) return state.Fail(E_INVALIDARG, "Resize dimensions");
    if (state.stats.width == width && state.stats.height == height && state.targetView) {
        state.Succeed();
        return true;
    }
    state.framePending = false;
    state.context->OMSetRenderTargets(0, nullptr, nullptr);
    state.targetView.Reset();
    HRESULT result = state.swapChain->ResizeBuffers(0, static_cast<UINT>(width),
        static_cast<UINT>(height), DXGI_FORMAT_UNKNOWN, 0);
    if (FAILED(result)) return state.Fail(result, "Resize swapchain buffers");
    state.stats.width = width;
    state.stats.height = height;
    if (!state.CreateTarget()) return false;
    state.Succeed();
    return true;
}

std::uint32_t D3D11Renderer::AddTexture(const PixelImage& image) {
    auto& state = *impl_;
    if (!state.Ready("AddTexture")) return 0;
    const std::uint64_t rowBytes = static_cast<std::uint64_t>(image.width) * 4;
    if (image.width == 0 || image.height == 0 ||
        image.width > kMaxSurfaceDimension || image.height > kMaxSurfaceDimension ||
        image.strideBytes < rowBytes ||
        image.bgraPremultiplied.size() <
            static_cast<std::uint64_t>(image.strideBytes) * (image.height - 1) + rowBytes ||
        state.nextTexture == 0) {
        state.Fail(E_INVALIDARG, "AddTexture dimensions, bytes, or exhausted identifiers");
        return 0;
    }
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = image.width;
    desc.Height = image.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_IMMUTABLE;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA data{};
    data.pSysMem = image.bgraPremultiplied.data();
    data.SysMemPitch = image.strideBytes;
    ComPtr<ID3D11Texture2D> texture;
    HRESULT result = state.device->CreateTexture2D(&desc, &data, texture.GetAddressOf());
    if (FAILED(result)) {
        state.Fail(result, "Upload immutable BGRA texture");
        return 0;
    }
    Impl::Texture entry;
    result = state.device->CreateShaderResourceView(texture.Get(), nullptr, entry.view.GetAddressOf());
    if (FAILED(result)) {
        state.Fail(result, "Create texture view");
        return 0;
    }
    entry.bytes = rowBytes * image.height;
    const auto id = state.nextTexture++;
    state.textures.emplace(id, std::move(entry));
    state.stats.textureBytes += rowBytes * image.height;
    state.stats.textureCount = static_cast<std::uint32_t>(state.textures.size());
    state.Succeed();
    return id;
}

bool D3D11Renderer::RemoveTexture(std::uint32_t textureId) {
    auto& state = *impl_;
    if (!state.Ready("RemoveTexture")) return false;
    const auto found = state.textures.find(textureId);
    if (found == state.textures.end()) return state.Fail(E_INVALIDARG, "Unknown texture identifier");
    ID3D11ShaderResourceView* none = nullptr;
    state.context->PSSetShaderResources(0, 1, &none);
    state.stats.textureBytes -= found->second.bytes;
    state.textures.erase(found);
    state.stats.textureCount = static_cast<std::uint32_t>(state.textures.size());
    state.Succeed();
    return true;
}

void D3D11Renderer::ClearTextures() {
    auto& state = *impl_;
    if (!state.Ready("ClearTextures")) return;
    ID3D11ShaderResourceView* none = nullptr;
    state.context->PSSetShaderResources(0, 1, &none);
    state.textures.clear();
    state.stats.textureBytes = 0;
    state.stats.textureCount = 0;
    state.Succeed();
}

bool D3D11Renderer::Draw(const std::vector<Quad>& quads, bool present,
                         const WeakAlphaOverrides* weak) {
    auto& state = *impl_;
    if (!state.Ready("Draw")) return false;
    if (!state.targetView) return state.Fail(E_UNEXPECTED, "Draw has no valid render target");
    if (quads.size() > kMaxQuads) return state.Fail(E_INVALIDARG, "Draw exceeds 4096 quad limit");
    if (weak && weak->size() != quads.size())
        return state.Fail(E_INVALIDARG, "Sparse alpha list count differs from quad count");
    const auto surfacePixels = static_cast<std::uint64_t>(state.stats.width) * state.stats.height;
    std::size_t totalWeak = 0;
    try {
        state.uploadWeakParameters.assign(quads.size(), WeakParameters{});
        for (std::size_t q = 0; q < quads.size(); ++q) {
            auto& parameters = state.uploadWeakParameters[q];
            parameters.width = static_cast<std::uint32_t>(state.stats.width);
            parameters.offset = static_cast<std::uint32_t>(totalWeak);
            if (!weak || (*weak)[q].empty()) continue;
            const auto& entries = (*weak)[q];
            if (entries.size() > kMaxWeakAlphaEntries - totalWeak)
                return state.Fail(E_INVALIDARG, "Sparse alpha exceeds one-million entry limit");
            parameters.count = static_cast<std::uint32_t>(entries.size());
            parameters.left = parameters.width;
            parameters.top = static_cast<std::uint32_t>(state.stats.height);
            bool firstEntry = true;
            std::uint32_t previous = 0;
            for (const auto& entry : entries) {
                if (entry.alphaByte > 1 || entry.pixelKey >= surfacePixels ||
                    (!firstEntry && entry.pixelKey <= previous))
                    return state.Fail(E_INVALIDARG, "Sparse alpha value, pixel bounds, or ordering");
                firstEntry = false;
                previous = entry.pixelKey;
                const auto x = entry.pixelKey % parameters.width;
                const auto y = entry.pixelKey / parameters.width;
                parameters.left = std::min(parameters.left, x);
                parameters.top = std::min(parameters.top, y);
                parameters.right = std::max(parameters.right, x + 1);
                parameters.bottom = std::max(parameters.bottom, y + 1);
            }
            totalWeak += entries.size();
        }
        state.uploadWeakPixels.clear();
        if (state.uploadWeakPixels.capacity() < totalWeak)
            state.uploadWeakPixels.reserve(totalWeak);
        if (weak) for (const auto& entries : *weak)
            state.uploadWeakPixels.insert(state.uploadWeakPixels.end(), entries.begin(), entries.end());
    } catch (const std::bad_alloc&) {
        return state.Fail(E_OUTOFMEMORY, "Allocate bounded sparse alpha upload");
    }
    auto& data = state.uploadVertices;
    data.clear();
    data.reserve(quads.size() * 6);
    constexpr int indices[] = {0, 1, 2, 0, 2, 3};
    for (const auto& quad : quads) {
        if (state.textures.find(quad.textureId) == state.textures.end() ||
            !std::isfinite(quad.opacity) || quad.opacity < 0 || quad.opacity > 1 ||
            (quad.scissor && (quad.scissor->width < 0 || quad.scissor->height < 0))) {
            return state.Fail(E_INVALIDARG, "Draw texture, opacity, or scissor");
        }
        for (int i = 0; i < 4; ++i) {
            if (!std::isfinite(quad.positions[i].x) || !std::isfinite(quad.positions[i].y) ||
                !std::isfinite(quad.uv[i].x) || !std::isfinite(quad.uv[i].y)) {
                return state.Fail(E_INVALIDARG, "Draw non-finite vertex");
            }
        }
        for (const auto index : indices) {
            const auto x = static_cast<float>(static_cast<double>(quad.positions[index].x) *
                                             2.0 / state.stats.width - 1.0);
            const auto y = static_cast<float>(1.0 - static_cast<double>(quad.positions[index].y) *
                                             2.0 / state.stats.height);
            if (!std::isfinite(x) || !std::isfinite(y)) {
                return state.Fail(E_INVALIDARG, "Draw vertex outside representable clip space");
            }
            data.push_back({x, y, quad.uv[index].x, quad.uv[index].y, quad.opacity});
        }
    }
    if (data.size() > state.vertexCapacity) {
        const std::size_t capacity = std::min(kMaxQuads * 6,
            std::max(data.size(), std::max<std::size_t>(6, state.vertexCapacity * 2)));
        D3D11_BUFFER_DESC desc{};
        desc.ByteWidth = static_cast<UINT>(capacity * sizeof(Vertex));
        desc.Usage = D3D11_USAGE_DYNAMIC;
        desc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        ComPtr<ID3D11Buffer> next;
        HRESULT result = state.device->CreateBuffer(&desc, nullptr, next.GetAddressOf());
        if (FAILED(result)) return state.Fail(result, "Allocate bounded vertex buffer");
        state.vertices = std::move(next);
        state.vertexCapacity = capacity;
    }
    if (!data.empty()) {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        const HRESULT result = state.context->Map(state.vertices.Get(), 0,
            D3D11_MAP_WRITE_DISCARD, 0, &mapped);
        if (FAILED(result)) return state.Fail(result, "Upload quad vertices");
        std::memcpy(mapped.pData, data.data(), data.size() * sizeof(Vertex));
        state.context->Unmap(state.vertices.Get(), 0);
    }
    // Reuse a bounded typed uint2 upload buffer. Unbind before discard-map;
    // callers own only the input vectors, never these renderer resources.
    ID3D11ShaderResourceView* noWeak = nullptr;
    state.context->PSSetShaderResources(1, 1, &noWeak);
    if (totalWeak > state.weakCapacity) {
        const std::size_t capacity = std::min(kMaxWeakAlphaEntries,
            std::max(totalWeak, std::max<std::size_t>(64, state.weakCapacity * 2)));
        D3D11_BUFFER_DESC desc{};
        desc.ByteWidth = static_cast<UINT>(capacity * sizeof(WeakAlphaPixel));
        desc.Usage = D3D11_USAGE_DYNAMIC;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        ComPtr<ID3D11Buffer> buffer;
        HRESULT result = state.device->CreateBuffer(&desc, nullptr, buffer.GetAddressOf());
        if (FAILED(result)) return state.Fail(result, "Allocate bounded sparse alpha buffer");
        D3D11_SHADER_RESOURCE_VIEW_DESC viewDesc{};
        viewDesc.Format = DXGI_FORMAT_R32G32_UINT;
        viewDesc.ViewDimension = D3D11_SRV_DIMENSION_BUFFER;
        viewDesc.Buffer.NumElements = static_cast<UINT>(capacity);
        ComPtr<ID3D11ShaderResourceView> view;
        result = state.device->CreateShaderResourceView(buffer.Get(), &viewDesc, view.GetAddressOf());
        if (FAILED(result)) return state.Fail(result, "Create sparse alpha typed view");
        state.weakBuffer = std::move(buffer);
        state.weakView = std::move(view);
        state.weakCapacity = capacity;
        state.stats.weakAlphaBufferBytes = capacity * sizeof(WeakAlphaPixel);
    }
    if (totalWeak) {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        const HRESULT result = state.context->Map(state.weakBuffer.Get(), 0,
            D3D11_MAP_WRITE_DISCARD, 0, &mapped);
        if (FAILED(result)) return state.Fail(result, "Upload sparse alpha decisions");
        std::memcpy(mapped.pData, state.uploadWeakPixels.data(), totalWeak * sizeof(WeakAlphaPixel));
        state.context->Unmap(state.weakBuffer.Get(), 0);
    }
    state.framePending = false;
    ID3D11RenderTargetView* target = state.targetView.Get();
    state.context->OMSetRenderTargets(1, &target, nullptr);
    constexpr float transparent[] = {0, 0, 0, 0};
    state.context->ClearRenderTargetView(target, transparent);
    state.context->OMSetBlendState(state.blend.Get(), nullptr, 0xffffffffu);
    state.context->RSSetState(state.rasterizer.Get());
    D3D11_VIEWPORT viewport{};
    viewport.Width = static_cast<float>(state.stats.width);
    viewport.Height = static_cast<float>(state.stats.height);
    viewport.MaxDepth = 1;
    state.context->RSSetViewports(1, &viewport);
    state.context->IASetInputLayout(state.inputLayout.Get());
    state.context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    state.context->VSSetShader(state.vertexShader.Get(), nullptr, 0);
    state.context->PSSetShader(state.pixelShader.Get(), nullptr, 0);
    ID3D11Buffer* constants = state.weakConstants.Get();
    state.context->PSSetConstantBuffers(0, 1, &constants);
    ID3D11ShaderResourceView* weakResource = totalWeak ? state.weakView.Get() : nullptr;
    state.context->PSSetShaderResources(1, 1, &weakResource);
    ID3D11SamplerState* sample = state.sampler.Get();
    state.context->PSSetSamplers(0, 1, &sample);
    if (!data.empty()) {
        ID3D11Buffer* buffer = state.vertices.Get();
        constexpr UINT stride = sizeof(Vertex), offset = 0;
        state.context->IASetVertexBuffers(0, 1, &buffer, &stride, &offset);
    }
    UINT first = 0;
    std::size_t quadIndex = 0;
    for (const auto& quad : quads) {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        const HRESULT mappedResult = state.context->Map(state.weakConstants.Get(), 0,
            D3D11_MAP_WRITE_DISCARD, 0, &mapped);
        if (FAILED(mappedResult)) return state.Fail(mappedResult, "Upload sparse alpha draw bounds");
        std::memcpy(mapped.pData, &state.uploadWeakParameters[quadIndex], sizeof(WeakParameters));
        state.context->Unmap(state.weakConstants.Get(), 0);
        D3D11_RECT clip{0, 0, state.stats.width, state.stats.height};
        if (quad.scissor) {
            const auto& rect = *quad.scissor;
            const auto clampX = [&](std::int64_t value) {
                return static_cast<LONG>(std::clamp<std::int64_t>(value, 0, state.stats.width));
            };
            const auto clampY = [&](std::int64_t value) {
                return static_cast<LONG>(std::clamp<std::int64_t>(value, 0, state.stats.height));
            };
            clip = {clampX(rect.x), clampY(rect.y),
                clampX(static_cast<std::int64_t>(rect.x) + rect.width),
                clampY(static_cast<std::int64_t>(rect.y) + rect.height)};
        }
        state.context->RSSetScissorRects(1, &clip);
        ID3D11ShaderResourceView* texture = state.textures.at(quad.textureId).view.Get();
        state.context->PSSetShaderResources(0, 1, &texture);
        state.context->Draw(6, first);
        first += 6;
        ++quadIndex;
    }
    ID3D11ShaderResourceView* none[] = {nullptr, nullptr};
    state.context->PSSetShaderResources(0, 2, none);
    ++state.stats.drawCalls;
    state.stats.quads += quads.size();
    state.stats.weakAlphaEntries = totalWeak;
    state.stats.weakAlphaBytes = totalWeak * sizeof(WeakAlphaPixel);
    state.framePending = true;
    state.Succeed();
    return !present || Present();
}

bool D3D11Renderer::Present() {
    auto& state = *impl_;
    if (!state.Ready("Present")) return false;
    if (!state.framePending) return state.Fail(E_UNEXPECTED, "Present without a new frame");
    // Waiting for vertical sync is confined to this renderer's owning thread.
    const HRESULT result = state.swapChain->Present(1, 0);
    state.framePending = false;
    if (FAILED(result)) return state.Fail(result, "Present composition surface");
    ++state.stats.presents;
    state.Succeed();
    return true;
}

bool D3D11Renderer::Capture(PixelImage& image) {
    auto& state = *impl_;
    if (!state.Ready("Capture")) return false;
    if (!state.framePending) return state.Fail(E_UNEXPECTED, "Capture requires Draw with present=false");
    ComPtr<ID3D11Texture2D> source;
    HRESULT result = state.swapChain->GetBuffer(0, IID_PPV_ARGS(source.GetAddressOf()));
    if (FAILED(result)) return state.Fail(result, "Diagnostic capture buffer");
    D3D11_TEXTURE2D_DESC desc{};
    source->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> staging;
    result = state.device->CreateTexture2D(&desc, nullptr, staging.GetAddressOf());
    if (FAILED(result)) return state.Fail(result, "Diagnostic staging texture");
    state.context->CopyResource(staging.Get(), source.Get());
    PixelImage captured;
    captured.width = desc.Width;
    captured.height = desc.Height;
    captured.strideBytes = desc.Width * 4;
    captured.bgraPremultiplied.resize(static_cast<std::size_t>(captured.strideBytes) * desc.Height);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    result = state.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(result)) return state.Fail(result, "Diagnostic staging readback");
    for (UINT row = 0; row < desc.Height; ++row) {
        std::memcpy(captured.bgraPremultiplied.data() +
                        static_cast<std::size_t>(row) * captured.strideBytes,
                    static_cast<const std::uint8_t*>(mapped.pData) +
                        static_cast<std::size_t>(row) * mapped.RowPitch,
                    captured.strideBytes);
    }
    state.context->Unmap(staging.Get(), 0);
    image = std::move(captured);
    ++state.stats.diagnosticReadbacks;
    state.Succeed();
    return true;
}

void D3D11Renderer::Shutdown() { impl_->Release(); }
const AdapterInfo& D3D11Renderer::Adapter() const { return impl_->adapter; }
const RendererStats& D3D11Renderer::Stats() const { return impl_->stats; }
HRESULT D3D11Renderer::LastError() const { return impl_->lastError; }
const std::string& D3D11Renderer::LastErrorMessage() const { return impl_->lastErrorMessage; }

}  // namespace niuma::runtime
