#include "runtime-p0-fixtures.h"

#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <limits>
#include <sstream>
#include <utility>

namespace niuma::runtime::p0 {
namespace {
using Microsoft::WRL::ComPtr;

bool Failure(HRESULT result, const char* operation, std::string& error) {
    std::ostringstream message;
    message << operation << ": 0x" << std::hex << std::setw(8) << std::setfill('0')
            << static_cast<std::uint32_t>(result);
    error = message.str();
    return false;
}

bool Factory(ComPtr<IWICImagingFactory>& factory, std::string& error) {
    const HRESULT result = CoCreateInstance(CLSID_WICImagingFactory, nullptr,
        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.GetAddressOf()));
    return SUCCEEDED(result) || Failure(result, "Create WIC factory", error);
}

float SmoothStep(float amount) {
    const float t = std::clamp(amount, 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

Point2 Rotate(Point2 point, float degrees) {
    constexpr float radiansPerDegree = 3.14159265358979323846f / 180.0f;
    const float c = std::cos(degrees * radiansPerDegree);
    const float s = std::sin(degrees * radiansPerDegree);
    return {point.x * c - point.y * s, point.x * s + point.y * c};
}

Quad Rectangle(std::uint32_t texture, float x, float y, float width, float height) {
    Quad quad;
    quad.textureId = texture;
    quad.positions = {{{x, y}, {x + width, y}, {x + width, y + height}, {x, y + height}}};
    return quad;
}

void PhysicalCanvas(Quad& quad, float scale) {
    for (auto& point : quad.positions) {
        point.x *= scale;
        point.y *= scale;
    }
    const int top = static_cast<int>(std::ceil(80.0f * scale));
    const int bottom = static_cast<int>(std::ceil(250.0f * scale));
    quad.scissor = ScissorRect{0, top, static_cast<int>(std::ceil(240.0f * scale)), bottom - top};
}

// A tiny procedural coverage texture reproduces the existing shadow's geometry
// and alpha. It is not a screenshot or a substitute for the real artwork.
PixelImage WoodfishShadow() {
    PixelImage image;
    image.width = 320;
    image.height = 32;
    image.strideBytes = image.width * 4;
    image.bgraPremultiplied.resize(static_cast<std::size_t>(image.strideBytes) * image.height);
    for (std::uint32_t y = 0; y < image.height; ++y) {
        for (std::uint32_t x = 0; x < image.width; ++x) {
            unsigned coverage = 0;
            for (unsigned sy = 0; sy < 4; ++sy) {
                for (unsigned sx = 0; sx < 4; ++sx) {
                    const float nx = (x + (sx + 0.5f) / 4.0f - 160.0f) / 160.0f;
                    const float ny = (y + (sy + 0.5f) / 4.0f - 16.0f) / 16.0f;
                    if (nx * nx + ny * ny <= 1.0f) ++coverage;
                }
            }
            image.bgraPremultiplied[static_cast<std::size_t>(y) * image.strideBytes + x * 4 + 3] =
                static_cast<std::uint8_t>((64 * coverage + 8) / 16);
        }
    }
    return image;
}

struct Key {
    float t, x, y;
};

struct Layer {
    float x, y, width, height;
    std::vector<Key> keys;
};

Key Interpolate(const std::vector<Key>& keys, float progress) {
    if (progress <= keys.front().t) return keys.front();
    if (progress >= keys.back().t) return keys.back();
    for (std::size_t i = 1; i < keys.size(); ++i) {
        if (progress <= keys[i].t) {
            const auto& left = keys[i - 1];
            const auto& right = keys[i];
            const float t = (progress - left.t) / (right.t - left.t);
            return {progress, left.x + (right.x - left.x) * t,
                              left.y + (right.y - left.y) * t};
        }
    }
    return keys.back();
}

// Exact source-number transcription of the pinned manifest. All three layers
// have anchor [.5,.5], rotation 0, scale 1, alpha 1 and linear interpolation.
// CI must verify kFixtureSources; a different manifest requires regeneration.
std::vector<Layer> OffworkLayers() {
    return {
        {22.0f, 22.910685805422645f, 182.30303030303028f, 147.08931419457736f,
            {{0.0f, 0.0f, 6.778309409888357f}}},
        {24.098883572567782f, 9.354066985645945f, 177.6555023923445f, 160.64593301435406f,
            {{0.0f, 0.0f, 10.303030303030305f},
             {0.25f, 0.0f, 10.303030303030305f},
             {0.43f, 0.0f, 6.236044657097288f},
             {0.6f, 0.0f, 6.236044657097288f},
             {0.78f, 0.0f, 10.303030303030305f},
             {1.0f, 0.0f, 10.303030303030305f}}},
        {22.0f, 0.0f, 187.99999999999997f, 170.0f,
            {{0.0f, 5.247208931419458f, -13.556618819776714f},
             {0.25f, 0.0f, 0.0f},
             {0.43f, 0.0f, -4.0669856459330145f},
             {0.6f, 0.0f, -4.0669856459330145f},
             {0.78f, 0.0f, 0.0f},
             {1.0f, 5.247208931419458f, -13.556618819776714f}}},
    };
}
}  // namespace

bool LoadPng(const std::filesystem::path& path, PixelImage& image, std::string& error) {
    error.clear();
    ComPtr<IWICImagingFactory> factory;
    if (!Factory(factory, error)) return false;
    ComPtr<IWICBitmapDecoder> decoder;
    HRESULT result = factory->CreateDecoderFromFilename(path.c_str(), nullptr,
        GENERIC_READ, WICDecodeMetadataCacheOnLoad, decoder.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Open source PNG", error);
    GUID container{};
    result = decoder->GetContainerFormat(&container);
    if (FAILED(result)) return Failure(result, "Read source container format", error);
    if (!IsEqualGUID(container, GUID_ContainerFormatPng)) {
        return Failure(WINCODEC_ERR_UNKNOWNIMAGEFORMAT, "Source fixture is not PNG", error);
    }
    ComPtr<IWICBitmapFrameDecode> frame;
    result = decoder->GetFrame(0, frame.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Read PNG frame", error);
    UINT width = 0, height = 0;
    result = frame->GetSize(&width, &height);
    if (FAILED(result)) return Failure(result, "Read PNG dimensions", error);
    constexpr std::uint64_t maxFixtureBytes = 64ull * 1024 * 1024;
    const std::uint64_t bytes = static_cast<std::uint64_t>(width) * height * 4;
    if (width == 0 || height == 0 || width > 16384 || height > 16384 ||
        bytes > maxFixtureBytes) {
        return Failure(E_INVALIDARG, "PNG exceeds diagnostic fixture dimensions or 64 MiB", error);
    }
    ComPtr<IWICFormatConverter> converter;
    result = factory->CreateFormatConverter(converter.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Create PNG converter", error);
    result = converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppPBGRA,
        WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom);
    if (FAILED(result)) return Failure(result, "Convert PNG to premultiplied BGRA", error);
    PixelImage loaded;
    loaded.width = width;
    loaded.height = height;
    loaded.strideBytes = width * 4;
    loaded.bgraPremultiplied.resize(static_cast<std::size_t>(bytes));
    result = converter->CopyPixels(nullptr, loaded.strideBytes, static_cast<UINT>(bytes),
                                   loaded.bgraPremultiplied.data());
    if (FAILED(result)) return Failure(result, "Decode PNG pixels", error);
    image = std::move(loaded);
    return true;
}

bool SavePng(const std::filesystem::path& path, const PixelImage& image, std::string& error) {
    error.clear();
    const std::uint64_t bytes = static_cast<std::uint64_t>(image.strideBytes) * image.height;
    if (image.width == 0 || image.height == 0 || image.width > 16384 || image.height > 16384 ||
        image.strideBytes < image.width * 4 || image.bgraPremultiplied.size() < bytes ||
        bytes > std::numeric_limits<UINT>::max()) {
        return Failure(E_INVALIDARG, "Save PNG image dimensions or bytes", error);
    }
    ComPtr<IWICImagingFactory> factory;
    if (!Factory(factory, error)) return false;
    ComPtr<IWICStream> stream;
    HRESULT result = factory->CreateStream(stream.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Create PNG output stream", error);
    result = stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE);
    if (FAILED(result)) return Failure(result, "Open PNG output", error);
    ComPtr<IWICBitmapEncoder> encoder;
    result = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Create PNG encoder", error);
    result = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
    if (FAILED(result)) return Failure(result, "Initialize PNG encoder", error);
    ComPtr<IWICBitmapFrameEncode> frame;
    result = encoder->CreateNewFrame(frame.GetAddressOf(), nullptr);
    if (FAILED(result)) return Failure(result, "Create output PNG frame", error);
    result = frame->Initialize(nullptr);
    if (FAILED(result)) return Failure(result, "Initialize output PNG frame", error);
    result = frame->SetSize(image.width, image.height);
    if (FAILED(result)) return Failure(result, "Set output PNG dimensions", error);
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    result = frame->SetPixelFormat(&format);
    if (FAILED(result)) return Failure(result, "Set output PNG format", error);
    if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) {
        return Failure(WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT, "PNG encoder did not retain alpha", error);
    }
    ComPtr<IWICBitmap> bitmap;
    result = factory->CreateBitmapFromMemory(image.width, image.height,
        GUID_WICPixelFormat32bppPBGRA, image.strideBytes, static_cast<UINT>(bytes),
        const_cast<BYTE*>(image.bgraPremultiplied.data()), bitmap.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Create diagnostic bitmap", error);
    ComPtr<IWICFormatConverter> converter;
    result = factory->CreateFormatConverter(converter.GetAddressOf());
    if (FAILED(result)) return Failure(result, "Create PNG unpremultiply converter", error);
    result = converter->Initialize(bitmap.Get(), GUID_WICPixelFormat32bppBGRA,
        WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom);
    if (FAILED(result)) return Failure(result, "Unpremultiply PNG output", error);
    result = frame->WriteSource(converter.Get(), nullptr);
    if (FAILED(result)) return Failure(result, "Write PNG pixels", error);
    result = frame->Commit();
    if (FAILED(result)) return Failure(result, "Commit PNG frame", error);
    result = encoder->Commit();
    if (FAILED(result)) return Failure(result, "Commit PNG output", error);
    return true;
}

struct FixtureScene::Impl {
    std::vector<std::pair<std::uint32_t, PixelImage>> textures;
    std::vector<Layer> layers;
    std::string error;
    bool offwork = false;
};

FixtureScene::FixtureScene() : impl_(std::make_unique<Impl>()) {}
FixtureScene::~FixtureScene() = default;

bool FixtureScene::Load(D3D11Renderer& renderer, const std::filesystem::path& repoRoot, bool offwork) {
    Clear(renderer);
    auto& state = *impl_;
    state.error.clear();
    state.offwork = offwork;
    const auto upload = [&](PixelImage image) {
        const auto id = renderer.AddTexture(image);
        if (id == 0) {
            state.error = renderer.LastErrorMessage();
            return false;
        }
        state.textures.emplace_back(id, std::move(image));
        return true;
    };
    const auto load = [&](const std::filesystem::path& path) {
        PixelImage image;
        return LoadPng(path, image, state.error) && upload(std::move(image));
    };
    bool loaded = false;
    if (offwork) {
        const auto directory = repoRoot / "assets/appearance-packs/offwork-button";
        loaded = load(directory / "base.png") && load(directory / "cap.png") &&
                 load(directory / "hand.png");
        if (loaded) state.layers = OffworkLayers();
    } else {
        loaded = upload(WoodfishShadow()) && load(repoRoot / "assets/woodfish.png") &&
                 load(repoRoot / "assets/mallet.png");
    }
    if (!loaded) {
        const auto error = state.error;
        Clear(renderer);
        state.error = error;
    }
    return loaded;
}

const std::vector<std::pair<std::uint32_t, PixelImage>>& FixtureScene::Textures() const {
    return impl_->textures;
}

std::vector<Quad> FixtureScene::Quads(float phase, float scale) const {
    const auto& state = *impl_;
    if (state.textures.size() != 3 || !std::isfinite(phase) || !std::isfinite(scale) ||
        scale <= 0 || scale > 16) return {};
    phase = std::clamp(phase, 0.0f, 1.0f);
    std::vector<Quad> result;
    if (state.offwork) {
        for (std::size_t i = 0; i < state.layers.size(); ++i) {
            const auto& layer = state.layers[i];
            const auto key = Interpolate(layer.keys, phase);
            // Manifest y is bottom-origin; the Windows surface is top-origin.
            const float top = 250.0f - layer.y - layer.height;
            auto quad = Rectangle(state.textures[i].first, layer.x + key.x,
                                  top - key.y, layer.width, layer.height);
            PhysicalCanvas(quad, scale);
            result.push_back(quad);
        }
    } else {
        // Match app.cpp's outer .88 scale, separate mallet source crops,
        // negative clockwise-screen rotation, clipping, and shadow dimensions.
        constexpr float contact = 0.42f;
        const float strike = phase < contact ? SmoothStep(phase / contact)
            : 1.0f - SmoothStep((phase - contact) / (1.0f - contact));
        result.push_back(Rectangle(state.textures[0].first, 40, 231, 160, 16));
        result.push_back(Rectangle(state.textures[1].first, 26, 121, 214, 129));
        const float sourceWidth = static_cast<float>(state.textures[2].second.width);
        auto shaft = Rectangle(state.textures[2].first, -260, -28, 266, 54);
        shaft.uv = {{{108.0f / sourceWidth, 0}, {1, 0}, {1, 1}, {108.0f / sourceWidth, 1}}};
        auto head = Rectangle(state.textures[2].first, -309, -27, 60, 54);
        const float headRight = std::min(145.0f, sourceWidth) / sourceWidth;
        head.uv = {{{0, 0}, {headRight, 0}, {headRight, 1}, {0, 1}}};
        result.push_back(shaft);
        result.push_back(head);
        for (std::size_t i = 0; i < result.size(); ++i) {
            for (auto& point : result[i].positions) {
                if (i >= 2) {
                    point = Rotate(point, -(3.0f + 2.2f * strike));
                    point.x += 417.0f;
                    point.y += 70.0f;
                }
                point.x = 120.0f + (point.x - 120.0f) * 0.88f;
                point.y = 250.0f + (point.y - 250.0f) * 0.88f;
            }
            PhysicalCanvas(result[i], scale);
        }
    }
    return result;
}

void FixtureScene::Clear(D3D11Renderer& renderer) {
    for (const auto& texture : impl_->textures) renderer.RemoveTexture(texture.first);
    impl_->textures.clear();
    impl_->layers.clear();
}

std::string FixtureScene::Name() const { return impl_->offwork ? "offwork" : "woodfish"; }
std::string FixtureScene::LastError() const { return impl_->error; }

}  // namespace niuma::runtime::p0
