#include "../src/windows/runtime/prepared_alpha_region.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace niuma::runtime;

namespace {
void Require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
struct Image {
    unsigned width, height, stride;
    std::vector<std::uint8_t> pixels;
    Image(unsigned w, unsigned h, unsigned padding = 0)
        : width(w), height(h), stride(4 * w + padding), pixels(stride * h, 0) {}
    void Set(unsigned x, unsigned y, std::uint8_t alpha) {
        pixels[static_cast<std::size_t>(y) * stride + 4 * x + 3] = alpha;
    }
    AlphaRegionImageView View() const { return {pixels.data(), pixels.size(), width, height, stride}; }
};
bool Contains(const PreparedAlphaMask& mask, int x, int y) {
    for (const auto& rect : mask.supportRectangles)
        if (rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom) return true;
    return false;
}
void ValidateBands(const PreparedAlphaMask& mask) {
    Require(mask.success, mask.error.c_str());
    int previousTop = -1, previousBottom = -1, previousRight = -1;
    for (const auto& rect : mask.supportRectangles) {
        Require(rect.left >= 0 && rect.top >= 0 && rect.right <= static_cast<int>(mask.width * 2) &&
            rect.bottom <= static_cast<int>(mask.height * 2) && rect.left < rect.right && rect.top < rect.bottom,
            "valid source-domain rectangle");
        Require(rect.top >= previousTop, "source bands sorted");
        if (rect.top == previousTop)
            Require(rect.bottom == previousBottom && rect.left >= previousRight, "disjoint same band");
        else
            Require(rect.top >= previousBottom, "disjoint vertical bands");
        previousTop = rect.top; previousBottom = rect.bottom; previousRight = rect.right;
    }
}
void SourceSupportAndHoles() {
    Image image(7, 7, 12);
    auto mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.empty() && mask.nonzeroSourcePixels == 0, "transparent mask empty");
    image.Set(3, 3, 1);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.size() == 1 && mask.nonzeroSourcePixels == 1, "one faint texel retained");
    const auto& rect = mask.supportRectangles[0];
    Require(rect.left == 5 && rect.top == 5 && rect.right == 9 && rect.bottom == 9,
            "one texel has exact half-texel linear-filter support");
    image.Set(3, 3, 0);
    for (unsigned y = 0; y < 7; ++y) for (unsigned x = 0; x < 7; ++x)
        if (x == 0 || y == 0 || x == 6 || y == 6) image.Set(x, y, 255);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(Contains(mask, 0, 0) && Contains(mask, 13, 13) && !Contains(mask, 7, 7),
            "source support preserves interior transparent hole");
    for (unsigned y = 0; y < 7; ++y) for (unsigned x = 0; x < 7; ++x) image.Set(x, y, 255);
    mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    Require(mask.supportRectangles.size() == 1 && mask.supportRectangles[0].right == 14 &&
        mask.supportRectangles[0].bottom == 14, "solid source compacts to one domain rectangle");
}

void SupportMatchesIndependentTexelUnion() {
    // A small non-convex source with gaps, edges and adjacent spans. Compare
    // every doubled-coordinate cell to the direct union of texel supports.
    Image image(9, 6);
    for (unsigned y = 0; y < image.height; ++y) for (unsigned x = 0; x < image.width; ++x)
        if ((x * 7 + y * 11) % 9 == 0 || (y == 2 && x >= 3 && x <= 5)) image.Set(x, y, 255);
    const auto mask = PrepareAlphaMask(image.View());
    ValidateBands(mask);
    for (int y = 0; y < static_cast<int>(2 * image.height); ++y) {
        for (int x = 0; x < static_cast<int>(2 * image.width); ++x) {
            bool expected = false;
            for (unsigned sy = 0; sy < image.height; ++sy) for (unsigned sx = 0; sx < image.width; ++sx) {
                if (!image.pixels[sy * image.stride + sx * 4 + 3]) continue;
                if (x >= static_cast<int>(2 * sx) - 1 && x < static_cast<int>(2 * sx) + 3 &&
                    y >= static_cast<int>(2 * sy) - 1 && y < static_cast<int>(2 * sy) + 3) expected = true;
            }
            Require(Contains(mask, x, y) == expected, "prepared support equals independent texel union");
        }
    }
}

void TransformMapsCroppedCorners() {
    Image image(200, 100);
    const auto mask = PrepareAlphaMask(image.View());
    PreparedAlphaQuad quad;
    quad.mask = &mask;
    quad.positions = {{{20, 30}, {140, 70}, {120, 130}, {0, 90}}};
    quad.uv = {{{0.25f, 0.125f}, {0.75f, 0.125f}, {0.75f, 0.875f}, {0.25f, 0.875f}}};
    PreparedAlphaAffine transform;
    std::string error;
    Require(ResolvePreparedAlphaTransform(quad, transform, error), error.c_str());
    for (std::size_t i = 0; i < 4; ++i) {
        const double x = quad.uv[i].x * mask.width * 2;
        const double y = quad.uv[i].y * mask.height * 2;
        Require(std::abs(transform.xx * x + transform.yx * y + transform.tx - quad.positions[i].x) < 1e-8 &&
            std::abs(transform.xy * x + transform.yy * y + transform.ty - quad.positions[i].y) < 1e-8,
            "cropped affine source corners map to renderer positions");
    }
    quad.uv = {{{0.75f, 0.875f}, {0.25f, 0.875f}, {0.25f, 0.125f}, {0.75f, 0.125f}}};
    Require(ResolvePreparedAlphaTransform(quad, transform, error), "flipped crop supported");
    for (std::size_t i = 0; i < 4; ++i) {
        const double x = quad.uv[i].x * mask.width * 2;
        const double y = quad.uv[i].y * mask.height * 2;
        Require(std::abs(transform.xx * x + transform.yx * y + transform.tx - quad.positions[i].x) < 1e-8 &&
            std::abs(transform.xy * x + transform.yy * y + transform.ty - quad.positions[i].y) < 1e-8,
            "flipped affine corners map exactly");
    }
}

void SubpixelBandsSurviveMinification() {
    Image image(256,256);
    // Disconnected one-texel strokes disappear if integer native regions are
    // transformed first. They must survive whenever a destination sample sees them.
    for (unsigned x=0;x<256;++x) image.Set(x,97,255);
    for (unsigned y=0;y<256;++y) image.Set(113,y,255);
    for (unsigned y=150;y<220;++y) for(unsigned x=40;x<90;++x) image.Set(x,y,255);
    auto mask=PrepareAlphaMask(image.View());
    for (int step=0;step<16;++step) {
        PreparedAlphaQuad quad; quad.mask=&mask;
        const double angle=step*0.07, scale=0.22+step*0.01;
        const double c=std::cos(angle)*scale, t=std::sin(angle)*scale;
        const double xs[]={0,256,256,0}, ys[]={0,0,256,256};
        AlphaRegionQuad reference; reference.image=image.View();
        for (int i=0;i<4;++i) {
            quad.positions[i]={static_cast<float>(80+c*xs[i]-t*ys[i]),static_cast<float>(10+t*xs[i]+c*ys[i])};
            reference.positions[i]=quad.positions[i];
        }
        auto actual=TransformPreparedAlphaRegion(160,160,{quad});
        auto expected=RasterizeAlphaRegion(160,160,{reference});
        Require(actual.success && expected.success,"both support paths succeed");
        std::vector<unsigned char> a(160*160),e(160*160);
        for(const auto& r:actual.rectangles) for(int y=r.top;y<r.bottom;++y) for(int x=r.left;x<r.right;++x) a[y*160+x]=1;
        for(const auto& r:expected.rectangles) for(int y=r.top;y<r.bottom;++y) for(int x=r.left;x<r.right;++x) e[y*160+x]=1;
        for(int y=0;y<160;++y) for(int x=0;x<160;++x) {
            Require(!e[y*160+x] || a[y*160+x],"prepared support does not drop thin reference samples");
            if(a[y*160+x] && !e[y*160+x]) {
                bool nearby=false;
                for(int dy=-1;dy<=1;++dy) for(int dx=-1;dx<=1;++dx)
                    if(x+dx>=0 && x+dx<160 && y+dy>=0 && y+dy<160 && e[(y+dy)*160+x+dx]) nearby=true;
                Require(nearby,"prepared support never fills distant empty areas");
            }
        }
    }
}

void UnsupportedIsExplicit() {
    Image image(2, 2);
    const auto mask = PrepareAlphaMask(image.View());
    PreparedAlphaQuad quad;
    quad.mask = &mask;
    quad.positions = {{{0, 0}, {20, 0}, {20, 20}, {0, 20}}};
    PreparedAlphaAffine transform;
    std::string error;
    quad.positions[2].x = 23;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error) && !error.empty(), "non-affine fails");
    quad.positions[2].x = 20;
    quad.uv[0].x = -0.1f;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "wrapped UV domain fails");
    quad.uv[0].x = 0;
    quad.uv[0].y = 0.2f;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "non-rectangular UV fails");
    quad.uv[0].y = 0;
    quad.opacity = 0;
    Require(ResolvePreparedAlphaTransform(quad, transform, error), "zero opacity is supported to skip");
    quad.opacity = -1;
    Require(!ResolvePreparedAlphaTransform(quad, transform, error), "invalid opacity fails");
    auto shortImage = image.View(); shortImage.byteCount = 1;
    Require(!PrepareAlphaMask(shortImage).success, "short source pixel buffer fails");
}

void WeakPixelsShareOneDecision() {
    Image image(16,16);
    image.Set(4,4,1);
    const auto mask=PrepareAlphaMask(image.View());
    PreparedAlphaQuad q; q.mask=&mask;
    q.positions={{{0,0},{32,0},{32,32},{0,32}}};
    WeakAlphaOverrides overrides;
    const auto r=TransformPreparedAlphaRegion(32,32,{q},&overrides);
    Require(r.success && overrides.size()==1 && !overrides[0].empty(),"weak support emits sparse GPU decisions");
    std::vector<unsigned char> shown(32*32);
    for(const auto& rect:r.rectangles) for(int y=rect.top;y<rect.bottom;++y)
        for(int x=rect.left;x<rect.right;++x) shown[y*32+x]=1;
    std::uint32_t previous=0;bool first=true,zero=false,one=false;
    for(const auto& pixel:overrides[0]) {
        Require(first || pixel.pixelKey>previous,"weak decisions sorted uniquely");
        first=false;previous=pixel.pixelKey;
        Require(pixel.alphaByte<=1 && pixel.pixelKey<shown.size(),"only quantized weak alpha and valid coordinates");
        Require(shown[pixel.pixelKey]==pixel.alphaByte,"region and GPU use identical weak decision");
        zero|=pixel.alphaByte==0;one|=pixel.alphaByte==1;
    }
    Require(zero && one,"both force-transparent and retained visible samples exported");
    Require(shown[8*32+8] && shown[9*32+9] && !shown[7*32+7],"independent bilinear center/corner coverage");
    q.opacity=0.49f;
    const auto repeated=TransformPreparedAlphaRegion(32,32,{q,q},&overrides);
    Require(repeated.success && repeated.rectangles.empty() && overrides.size()==2,
        "each BGRA8 draw quantizes before composition; invisible draws do not accumulate");
    for(const auto& draw:overrides) for(const auto& pixel:draw)
        Require(pixel.alphaByte==0,"explicit zero decision for both weak draws");
    q.opacity=1;
    auto solid=q; Image strong(16,16);strong.Set(4,4,255);const auto strongMask=PrepareAlphaMask(strong.View());solid.mask=&strongMask;
    const auto mixed=TransformPreparedAlphaRegion(32,32,{q,solid},&overrides);
    Require(mixed.success && overrides.size()==2 && overrides[0].empty() && overrides[1].empty(),
        "strong coverage retains original GPU sampling, without weak overrides");
}
}  // namespace

int main() {
    struct Test { const char* name; void (*run)(); };
    const Test tests[] = {
        {"source-support-and-holes", SourceSupportAndHoles},
        {"support-matches-independent-texel-union", SupportMatchesIndependentTexelUnion},
        {"transform-maps-cropped-corners", TransformMapsCroppedCorners},
        {"unsupported-is-explicit", UnsupportedIsExplicit},
        {"subpixel-bands-survive-minification", SubpixelBandsSurviveMinification},
        {"weak-pixels-share-one-decision", WeakPixelsShareOneDecision},
    };
    unsigned passed = 0;
    for (const auto& test : tests) {
        try { test.run(); ++passed; std::cout << "PASS " << test.name << '\n'; }
        catch (const std::exception& error) { std::cerr << "FAIL " << test.name << ": " << error.what() << '\n'; return 1; }
    }
    std::cout << "prepared-alpha-region: " << passed << "/" << std::size(tests) << " passed\n";
    return 0;
}
