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
    controller.dailyTotals = [NSMutableDictionary dictionary];
    controller.currentDayKey = DateKeyForDate(NSDate.date);
    controller.todayTotal = 0;
    controller.view = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, 120, 125)];
    controller.view.controller = controller;
    for (int i = 0; i < 100; ++i)
      EventTapCallback(NULL, kCGEventKeyDown, NULL, (__bridge void *)controller);
    assert(controller.total == 100);
    assert(controller.todayTotal == 100);
    assert(controller.dailyTotals[controller.currentDayKey].longLongValue == 100);
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
    assert(controller.todayTotal == 105);
    EventTapCallback(NULL, kCGEventKeyUp, NULL, (__bridge void *)controller);
    assert(controller.total == 105);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:.35];
    while (deadline.timeIntervalSinceNow > 0)
      [NSRunLoop.mainRunLoop runMode:NSModalPanelRunLoopMode beforeDate:deadline];
    assert(!controller.strikeActive && !controller.animationTimer);
    controller.total = LLONG_MAX;
    [controller count];
    assert(controller.total == LLONG_MAX);
    assert(controller.todayTotal == 105);
    const long long lifetimeBeforeRollover = controller.total;
    NSString *todayKey = DateKeyForDate(NSDate.date);
    [controller.dailyTotals removeObjectForKey:todayKey];
    controller.currentDayKey = @"1900-01-01";
    controller.todayTotal = 999;
    [controller ensureCurrentDay];
    assert([controller.currentDayKey isEqualToString:todayKey]);
    assert(controller.todayTotal == 0);
    assert(controller.total == lifetimeBeforeRollover);
    controller.total = 13700;
    controller.dailyTotals[@"2026-09-01"] = @860;
    controller.dailyTotals[@"2026-09-02"] = @56866;
    controller.selectedScene = MeritSceneWoodfish;
    controller.selectedAppearanceId = @"builtin.woodfish";
    controller.pendingAppearanceId = @"builtin.woodfish";
    controller.installedAppearancePacks = @[];
    NSView *grid = [controller appearanceGrid];
    assert(controller.appearanceButtons.count == 1);
    [controller selectAppearance:controller.appearanceButtons[0]];
    assert([controller.pendingAppearanceId isEqualToString:@"builtin.woodfish"]);
    assert(controller.selectedScene == MeritSceneWoodfish);
    for (NSButton *button in controller.appearanceButtons)
      assert((button.state == NSControlStateValueOn) == (button.tag == 0));
    Snapshot(grid, @"appearance-grid.png");
    MeritCalendarView *calendar = [[MeritCalendarView alloc] initWithFrame:NSMakeRect(0, 0, 560, 430)];
    calendar.controller = controller;
    calendar.year = 2026;
    calendar.month = 9;
    Snapshot(calendar, @"merit-calendar.png");
    assert(controller.view.woodfishImage && controller.view.malletImage);
    assert(controller.view.luckyCatBaseImage.representations.count == 0 &&
           controller.view.luckyCatActorImage.representations.count == 0);
    assert(controller.view.seaLionBodyImage.representations.count == 0 &&
           controller.view.seaLionFlipperImage.representations.count == 0);
    assert(!controller.view.hamsterBaseImage && !controller.view.hamsterActorImage);
    printf("PASS: %s UI localization; daily and lifetime totals; single-line calendar; 100 key events; all mouse buttons; scroll grouping; ignored key-up; no animation queue; modal timer completion; overflow guard; woodfish-only base picker and resources\n", expectedLanguage);
  }
}
