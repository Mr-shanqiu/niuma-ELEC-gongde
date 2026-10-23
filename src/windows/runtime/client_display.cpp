#include "client_display.h"
#include <cmath>
#include <limits>

namespace niuma::windows::runtime {
namespace {
namespace graphics = niuma::runtime;
constexpr std::uint64_t kTextKey = 0x100;
constexpr graphics::WidgetTextSlot kSlots[] = {graphics::WidgetTextSlot::Merit,
    graphics::WidgetTextSlot::PlusOne, graphics::WidgetTextSlot::Countdown};
void TextQuad(const graphics::WidgetTextImage& image, graphics::WidgetTextSlot slot,
              float scale, float plusY, std::vector<graphics::CompositionQuad>& quads) {
  const auto& r = image.logicalRect;
  const float x = r.x * scale, y = (r.y + (slot == graphics::WidgetTextSlot::PlusOne ? plusY : 0)) * scale;
  graphics::CompositionQuad q;
  q.textureKey = kTextKey + static_cast<unsigned>(slot);
  q.mask = &image.mask;
  q.geometry.positions = {{{x,y},{x+r.width*scale,y},{x+r.width*scale,y+r.height*scale},{x,y+r.height*scale}}};
  quads.push_back(q);
}
}
bool ClientDisplay::Initialize(HWND window,int width,int height,bool software) {
  if (!presenter_.Initialize(window,width,height,software)) {
    initialized_ = false; error_ = presenter_.LastErrorMessage(); return false;
  }
  window_ = window; width_ = width; height_ = height; softwareForTest_ = software;
  initialized_ = true; error_.clear();
  return true;
}
bool ClientDisplay::InstallTextures(const PreparedAppearanceScene* scene,std::uint64_t version) {
  std::vector<graphics::CompositionTexture> textures;
  textures.reserve(9);
  if (scene) for (const auto& image : scene->images)
    textures.push_back({image.id,version,&image.pixels});
  for (auto slot : kSlots) if (const auto* t = text_.Get(slot))
    textures.push_back({kTextKey+static_cast<unsigned>(slot),t->version,&t->pixels});
  if (textures.empty()) return true;
  if (!presenter_.SetTextures(textures)) { error_=presenter_.LastErrorMessage(); return false; }
  return true;
}
bool ClientDisplay::SetScene(std::unique_ptr<PreparedAppearanceScene>& candidate) {
  if (!initialized_ || !candidate || !candidate->HasColorPixels() ||
      sceneVersion_ == std::numeric_limits<std::uint64_t>::max()) {
    error_="Prepared appearance is unavailable"; return false;
  }
  niuma::client::core::AnimationPlayer next;
  if (!candidate->Configure(next)) { error_="Prepared appearance geometry is invalid"; return false; }
  if (!InstallTextures(candidate.get(),sceneVersion_+1)) return false;
  player_=std::move(next); scene_=std::move(candidate); ++sceneVersion_;
  error_.clear(); return true;
}
bool ClientDisplay::DrawLatest(const ClientDisplayState& state,std::uint64_t now,int width,int height) {
  if (!initialized_) { error_="Display device is not initialized"; return false; }
  if (width != width_ || height != height_) {
    if (!presenter_.Resize(width,height)) { error_=presenter_.LastErrorMessage(); return false; }
    width_=width; height_=height;
  }
  auto textInput=state.text;
  const niuma::client::core::AnimationFrame* frame=nullptr;
  if (scene_) {
    if (!player_.SetAction(state.action)) { error_="Invalid display action"; return false; }
    frame=&player_.Sample(now,state.text.pixelScale);
    if (!frame->valid) { error_="Shared animation evaluation failed"; return false; }
    textInput.plusVisible=frame->showPlusOne;
  } else textInput.plusVisible=false;
  const auto textResult=text_.Update(textInput);
  if (!textResult.success) { error_=textResult.error; return false; }
  if (!InstallTextures(scene_.get(),sceneVersion_)) return false;
  std::vector<graphics::CompositionQuad> quads;
  quads.reserve(9);
  if (frame) for(std::size_t i=0;i<frame->quadCount;++i) {
    const auto& source=frame->quads[i];
    const auto* image=scene_->Find(source.image);
    if (!image) { error_="Shared frame references an absent image"; return false; }
    graphics::CompositionQuad q;
    q.textureKey=image->id; q.mask=&image->alpha; q.geometry.opacity=source.opacity;
    for(unsigned p=0;p<4;++p) {
      q.geometry.positions[p]={source.positions[p].x,source.positions[p].y};
      q.geometry.uv[p]={source.uv[p].x,source.uv[p].y};
    }
    const auto& clip=source.clip;
    const auto left=static_cast<int>(std::floor(clip.x)),top=static_cast<int>(std::floor(clip.y));
    q.geometry.scissor=graphics::ScissorRect{left,top,
      static_cast<int>(std::ceil(clip.x+clip.width))-left,
      static_cast<int>(std::ceil(clip.y+clip.height))-top};
    quads.push_back(q);
  }
  const float plusY=frame ? frame->plusOneRect.y/state.text.pixelScale : 46.f;
  // Preserve existing order: artwork, +1, merit and the separate clock band.
  for(auto slot : {graphics::WidgetTextSlot::PlusOne,graphics::WidgetTextSlot::Merit,
                  graphics::WidgetTextSlot::Countdown})
    if (text_.Visible(slot)) {
      const auto* image=text_.Get(slot);
      if (!image) { error_="Visible text has no prepared image"; return false; }
      TextQuad(*image,slot,state.text.pixelScale,plusY,quads);
    }
  if (!presenter_.DrawLatest(quads)) { error_=presenter_.LastErrorMessage(); return false; }
  if (frame) player_.MarkPresented(frame->revision);
  error_.clear(); return true;
}
bool ClientDisplay::RecreateDevice() {
  if (!window_) { error_="Display window is unavailable"; return false; }
  presenter_.Shutdown(); initialized_=false;
  if (!presenter_.Initialize(window_,width_,height_,softwareForTest_)) {
    error_=presenter_.LastErrorMessage(); return false;
  }
  initialized_=true;
  if (!InstallTextures(scene_.get(),sceneVersion_)) { initialized_=false; return false; }
  player_.Invalidate(); error_.clear(); return true;
}
void ClientDisplay::Shutdown() {
  presenter_.Shutdown(); scene_.reset(); text_.Clear();
  initialized_=false; window_=nullptr; width_=height_=0;
}
}  // namespace niuma::windows::runtime
