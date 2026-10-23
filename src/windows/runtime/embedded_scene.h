#pragma once
#include "appearance_scene.h"
namespace niuma::windows::runtime {
// Identity covers the executable's two immutable PNG resources and shadow rule.
// Reading resource bytes here does not decode or open any user files.
bool EmbeddedWoodfishRequest(niuma::AppearanceResourceRequest& request);
AppearanceSceneStatus PrepareEmbeddedWoodfishScene(
    const niuma::AppearanceResourceRequest& expected,
    std::unique_ptr<PreparedAppearanceScene>* output,std::wstring* error);
}
