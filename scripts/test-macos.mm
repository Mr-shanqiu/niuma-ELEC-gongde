#define main MeritApplicationMain
#include "../src/macos/app.mm"
#undef main
#include <cassert>

static void Snapshot(NSView *view, NSString *name) {
  NSBitmapImageRep *rep = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];
  NSData *data = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  assert([data writeToFile:[@"/tmp/niuma-acceptance/" stringByAppendingString:name] atomically:YES]);
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    const char *expectedLanguage = getenv("NIUMA_UI_LANGUAGE");
    assert(expectedLanguage != nullptr);
    const BOOL expectChinese = strcmp(expectedLanguage, "zh") == 0;
    assert(IsChineseUI() == expectChinese);
    assert([UiText(@"中文", @"English")
        isEqualToString:(expectChinese ? @"中文" : @"English")]);
    [NSFileManager.defaultManager createDirectoryAtPath:@"/tmp/niuma-acceptance"
        withIntermediateDirectories:YES attributes:nil error:nil];
    MeritController *controller = [[MeritController alloc] init];
    [controller loadState];
    controller.total = 0;
    controller.view = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, 120, 125)];
    controller.view.controller = controller;
    for (int i = 0; i < 100; ++i)
      EventTapCallback(NULL, kCGEventKeyDown, NULL, (__bridge void *)controller);
    assert(controller.total == 100);
    NSTimeInterval start = controller.strikeStartTime;
    EventTapCallback(NULL, kCGEventLeftMouseDown, NULL, (__bridge void *)controller);
    EventTapCallback(NULL, kCGEventRightMouseDown, NULL, (__bridge void *)controller);
    EventTapCallback(NULL, kCGEventOtherMouseDown, NULL, (__bridge void *)controller);
    assert(controller.total == 103 && controller.strikeStartTime == start);
    for (int i = 0; i < 20; ++i)
      EventTapCallback(NULL, kCGEventScrollWheel, NULL, (__bridge void *)controller);
    assert(controller.total == 104);
    controller.lastScrollEventTime -= .3;
    EventTapCallback(NULL, kCGEventScrollWheel, NULL, (__bridge void *)controller);
    assert(controller.total == 105);
    EventTapCallback(NULL, kCGEventKeyUp, NULL, (__bridge void *)controller);
    assert(controller.total == 105);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:.35];
    while (deadline.timeIntervalSinceNow > 0)
      [NSRunLoop.mainRunLoop runMode:NSModalPanelRunLoopMode beforeDate:deadline];
    assert(!controller.strikeActive && !controller.animationTimer);
    controller.total = LLONG_MAX;
    [controller count];
    assert(controller.total == LLONG_MAX);
    controller.total = 13700;
    controller.selectedScene = MeritSceneWoodfish;
    controller.pendingScene = MeritSceneWoodfish;
    NSView *grid = [controller appearanceGrid];
    assert(controller.appearanceButtons.count == 4);
    [controller selectAppearance:controller.appearanceButtons[3]];
    assert(controller.pendingScene == MeritSceneHamsterWheel);
    assert(controller.selectedScene == MeritSceneWoodfish);
    for (NSButton *button in controller.appearanceButtons)
      assert((button.state == NSControlStateValueOn) == (button.tag == 3));
    Snapshot(grid, @"appearance-grid.png");
    assert(controller.view.hamsterBaseImage && controller.view.hamsterActorImage);
    for (NSImage *sprite in @[controller.view.hamsterBaseImage, controller.view.hamsterActorImage]) {
      NSBitmapImageRep *rep = (NSBitmapImageRep *)sprite.representations.firstObject;
      assert([rep colorAtX:0 y:0].alphaComponent < .01);
      NSUInteger opaque = 0, green = 0;
      for (NSInteger y = 0; y < rep.pixelsHigh; ++y) for (NSInteger x = 0; x < rep.pixelsWide; ++x) {
        NSColor *c = [[rep colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
        if (c.alphaComponent > .5) {
          ++opaque;
          if (c.greenComponent > std::max(c.redComponent, c.blueComponent) + .15) ++green;
        }
      }
      assert(opaque > 1000 && green == 0);
    }
    controller.view.scene = MeritSceneHamsterWheel;
    Snapshot(controller.view, @"hamster-rest.png");
    controller.strikeActive = YES;
    controller.activeStrikeDuration = 100;
    controller.strikeStartTime = [NSDate timeIntervalSinceReferenceDate] - 42;
    Snapshot(controller.view, @"hamster-stride.png");
    controller.strikeActive = NO;
    NSRect pawRect = NSMakeRect(30, -35, 230, 230);
    NSPoint anchor = NSMakePoint(30 + 230 * 362.0 / 600.0, -35 + 230 * 112.0 / 600.0);
    NSPoint tip = NSMakePoint(anchor.x, anchor.y + 60);
    for (int frame = 0; frame <= 100; ++frame) {
      NSAffineTransform *pose = LuckyCatPawTransform(pawRect, frame / 100.0);
      NSPoint fixed = [pose transformPoint:anchor];
      assert(std::hypot(fixed.x - anchor.x, fixed.y - anchor.y) < 1e-8);
      NSPoint moved = [pose transformPoint:tip];
      assert(std::abs(moved.x - tip.x) < 1e-8);
      assert(moved.y <= tip.y + 1e-8);
      assert(std::hypot(moved.x - tip.x, moved.y - tip.y) < 13);
    }
    controller.view.scene = MeritSceneLuckyCat;
    Snapshot(controller.view, @"cat-rest.png");
    controller.strikeActive = YES;
    controller.strikeStartTime = [NSDate timeIntervalSinceReferenceDate] - 42;
    Snapshot(controller.view, @"cat-wave.png");
    controller.strikeActive = NO;
    printf("PASS: 101 cat poses keep attachment fixed; paw moves vertically with zero horizontal drift\n");
    printf("PASS: %s UI localization; 100 key events; all mouse buttons; scroll grouping; ignored key-up; no animation queue; modal timer completion; overflow guard; four-card selection isolation; alpha and green-key checks; scene renders\n", expectedLanguage);
  }
}
