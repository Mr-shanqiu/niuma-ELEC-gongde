// Run the independent support/transform contracts with every optimized axis
// span checked against the unmodified general edge-intersection calculation.
// This translation unit owns prepared_alpha_region, avoiding any test branch
// or reference checks in the production library.
#define NIUMA_PREPARED_ALPHA_VERIFY_SPANS
#include "../src/windows/runtime/prepared_alpha_region.cpp"
#define main PreparedAlphaContractMain
#include "test-windows-prepared-alpha-region.cpp"
#undef main

int main() {
    if (PreparedAlphaContractMain() != 0) return 1;
    try {
        // Fractional placement, minification, flips and strip/edge equality.
        // The retained generic algorithm is the independent geometry oracle.
        for (float x : {-37.25f, -0.125f, 0.0f, 128.75f})
            for (float y : {-11.5f, -0.125f, 0.0f, 512.25f})
                for (float w : {-128.5f, -0.25f, 0.25f, 128.5f})
                    for (float h : {-64.25f, -0.125f, 0.125f, 64.25f})
                        for (double allowance : {0.0, 1.0 / 128.0, 0.5}) {
                            const std::array<AlphaRegionPoint, 4> points{{
                                {x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}}};
                            for (double center : {static_cast<double>(y) - allowance,
                                 static_cast<double>(y) + allowance, static_cast<double>(y + h) - allowance,
                                 static_cast<double>(y + h) + allowance, static_cast<double>(y) + h / 2.0,
                                 static_cast<double>(y) - 1000.0}) {
                                double left = 0, right = 0;
                                niuma::runtime::SpanAtRow(points, center, allowance, left, right);
                            }
                        }
        Require(niuma::runtime::verifiedAxisSpans >= 4608, "optimized axis path was actually exercised");
        std::cout << "axis spans equal original intersections: "
            << niuma::runtime::verifiedAxisSpans << " comparisons\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL axis span reference: " << error.what() << '\n';
        return 1;
    }
}
