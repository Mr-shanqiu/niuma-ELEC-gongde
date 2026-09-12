#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#include <algorithm>
#include <cmath>
#include <climits>
#include <cstdio>

// Decode chroma-keyed artwork once, never during an animation frame.
static NSImage *LoadHamsterSprite(NSString *name) {
  static NSMutableDictionary<NSString *, NSImage *> *cache;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cache = [NSMutableDictionary dictionary]; });
  if (cache[name]) return cache[name];
  NSString *path = [NSBundle.mainBundle pathForResource:name ofType:@"png"];
  NSBitmapImageRep *source = path ? [[NSBitmapImageRep alloc] initWithData:[NSData dataWithContentsOfFile:path]] : nil;
  if (!source) return nil;
  NSInteger width = source.pixelsWide, height = source.pixelsHigh;
  NSBitmapImageRep *rgba = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:height
      bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
      colorSpaceName:NSDeviceRGBColorSpace
      bitmapFormat:0 bytesPerRow:width * 4 bitsPerPixel:32];
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(rgba.bitmapData, width, height, 8,
      rgba.bytesPerRow, space, kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  if (!context) return nil;
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), source.CGImage);
  CGContextRelease(context);
  for (NSInteger y = 0; y < height; ++y) {
    for (NSInteger x = 0; x < width; ++x) {
      unsigned char *pixel = rgba.bitmapData + y * rgba.bytesPerRow + x * 4;
      CGFloat originalAlpha = pixel[3] / 255.0;
      if (originalAlpha == 0) continue;
      CGFloat r = pixel[0] / (255.0 * originalAlpha);
      CGFloat g = pixel[1] / (255.0 * originalAlpha);
      CGFloat b = pixel[2] / (255.0 * originalAlpha);
      CGFloat a = originalAlpha;
      CGFloat excess = g - std::max(r, b);
      if (excess > .08) {
        a *= 1.0 - std::clamp((excess - .08) / .22, 0.0, 1.0);
        g = std::min(g, std::max(r, b));
      }
      pixel[0] = (unsigned char)(r * a * 255); pixel[1] = (unsigned char)(g * a * 255);
      pixel[2] = (unsigned char)(b * a * 255); pixel[3] = (unsigned char)(a * 255);
    }
  }
  NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(width, height)];
  [image addRepresentation:rgba];
  cache[name] = image;
  return image;
}

static NSString *const kTotal = @"total";
static NSString *const kDailyTotals = @"dailyTotals";
static NSString *const kSelectedScene = @"selectedScene";
static NSString *const kLaunchAtLoginConfigured = @"launchAtLoginConfigured";
static NSString *const kLaunchAtLoginEnabled = @"launchAtLoginEnabled";
static NSString *const kLaunchAgentLabel = @"cn.niuma.merit.autostart";
static BOOL IsChineseUI(void) {
  NSString *override = NSProcessInfo.processInfo.environment[@"NIUMA_UI_LANGUAGE"];
  if ([override isEqualToString:@"zh"]) return YES;
  if ([override isEqualToString:@"en"]) return NO;
  NSString *language = NSLocale.preferredLanguages.firstObject.lowercaseString;
  return [language hasPrefix:@"zh"];
}

static NSString *UiText(NSString *chinese, NSString *english) {
  return IsChineseUI() ? chinese : english;
}

static NSString *DateKeyForDate(NSDate *date) {
  static NSDateFormatter *formatter;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.dateFormat = @"yyyy-MM-dd";
  });
  formatter.timeZone = NSTimeZone.localTimeZone;
  return [formatter stringFromDate:date];
}

static const CGFloat kUiScale = 0.5;
static const CGFloat kWindowWidth = 240;
static const CGFloat kWindowHeight = 250;
static const CGFloat kWindowScaleWidth = kWindowWidth * kUiScale;
static const CGFloat kWindowScaleHeight = kWindowHeight * kUiScale;

static const NSTimeInterval kDefaultStrikeDuration = 0.220;
static const NSTimeInterval kMinStrikeDuration = 0.120;
static const NSTimeInterval kMaxStrikeDuration = 0.240;
static const NSTimeInterval kPauseForResetGap = 0.600;
static const NSTimeInterval kScrollGestureIdleGap = 0.180;
static const NSTimeInterval kPermissionPollInterval = 1.0;
static constexpr double kEmaWeight = 0.35;

static NSAffineTransform *LuckyCatPawTransform(NSRect actorRect, double amount) {
  // The sprite's attachment point is (362, 488) in its 600px top-down canvas.
  // Convert it to AppKit coordinates. Foreshorten vertically around the fixed
  // attachment to suggest a forward/downward beckon without a sideways swing.
  NSPoint shoulder = NSMakePoint(NSMinX(actorRect) + NSWidth(actorRect) * 362.0 / 600.0,
      NSMinY(actorRect) + NSHeight(actorRect) * (600.0 - 488.0) / 600.0);
  NSAffineTransform *transform = [NSAffineTransform transform];
  [transform translateXBy:shoulder.x yBy:shoulder.y];
  [transform scaleXBy:1.0 yBy:1.0 - .20 * amount];
  [transform translateXBy:-shoulder.x yBy:-shoulder.y];
  return transform;
}

typedef NS_ENUM(NSInteger, MeritScene) {
  MeritSceneWoodfish = 0,
  MeritSceneLuckyCat = 1,
  MeritSceneChickPecking = 2,
  MeritSceneHamsterWheel = 3,
};

@class MeritController;
@class MeritCalendarView;
static CGEventRef EventTapCallback(CGEventTapProxy, CGEventType, CGEventRef, void *);

@interface MeritView : NSView
@property(nonatomic, weak) MeritController *controller;
@property(nonatomic, strong) NSImage *woodfishImage;
@property(nonatomic, strong) NSImage *malletImage;
@property(nonatomic, strong) NSImage *luckyCatBaseImage;
@property(nonatomic, strong) NSImage *luckyCatActorImage;
@property(nonatomic, strong) NSImage *chickBaseImage;
@property(nonatomic, strong) NSImage *chickActorImage;
@property(nonatomic, strong) NSImage *hamsterBaseImage;
@property(nonatomic, strong) NSImage *hamsterWheelImage;
@property(nonatomic, strong) NSImage *hamsterActorImage;
@property(nonatomic) MeritScene scene;
@property(nonatomic) BOOL previewOnly;
@end

@interface MeritController : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MeritView *view;
@property(nonatomic, strong) NSTimer *animationTimer;
@property(nonatomic, strong) NSTimer *permissionPollTimer;
@property(nonatomic, strong) NSTimer *saveTimer;
@property(nonatomic, strong) NSTimer *dayTimer;
@property(nonatomic, strong) NSWindow *calendarWindow;
@property(nonatomic, strong) MeritCalendarView *calendarView;
@property(nonatomic) CFMachPortRef eventTap;
@property(nonatomic) CFRunLoopSourceRef eventSource;
@property(nonatomic) long long total;
@property(nonatomic) long long todayTotal;
@property(nonatomic, copy) NSString *currentDayKey;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *dailyTotals;
@property(nonatomic) BOOL dirty;
@property(nonatomic) BOOL strikeActive;
@property(nonatomic) BOOL inputMonitoringAuthorized;
@property(nonatomic) BOOL launchedAutomatically;
@property(nonatomic) NSTimeInterval lastInputTime;
@property(nonatomic) NSTimeInterval lastScrollEventTime;
@property(nonatomic) double smoothedInputInterval;
@property(nonatomic) NSTimeInterval strikeStartTime;
@property(nonatomic) NSTimeInterval activeStrikeDuration;
@property(nonatomic) MeritScene selectedScene;
@property(nonatomic) NSInteger pendingScene;
@property(nonatomic, strong) NSArray<NSButton *> *appearanceButtons;
@property(nonatomic) BOOL diagnostics;
@property(nonatomic) NSUInteger receivedEvents;
@property(nonatomic) NSUInteger receivedKeys;
@property(nonatomic) NSUInteger receivedClicks;
@property(nonatomic) NSUInteger receivedScrolls;
- (void)count;
- (void)countScrollGesture;
- (void)showContextMenu:(NSEvent *)event;
- (void)startStrikeWithDuration:(NSTimeInterval)duration;
- (void)animate:(NSTimer *)timer;
- (void)showPermissionIntroIfNeeded;
- (void)requestListenPermission;
- (void)installEventTap;
- (void)removeEventTap;
- (void)handleEventTapDisabled;
- (void)showAbout:(id)sender;
- (void)showAppearancePicker:(id)sender;
- (void)showMeritCalendar:(id)sender;
- (void)shiftCalendarMonth:(NSButton *)sender;
- (void)ensureCurrentDay;
- (void)checkPermission:(NSTimer *)timer;
- (void)stopPermissionPoll;
- (void)configureLaunchAtLogin;
- (void)toggleLaunchAtLogin:(id)sender;
- (NSView *)appearanceGrid;
- (void)selectAppearance:(NSButton *)sender;
@end

@implementation MeritView

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    NSBundle *bundle = NSBundle.mainBundle;
    NSString *woodfishPath = [bundle pathForResource:@"woodfish" ofType:@"png"];
    NSString *malletPath = [bundle pathForResource:@"mallet" ofType:@"png"];
    if (woodfishPath) self.woodfishImage = [[NSImage alloc] initWithContentsOfFile:woodfishPath];
    if (malletPath) self.malletImage = [[NSImage alloc] initWithContentsOfFile:malletPath];
    NSArray<NSString *> *names = @[
      @"lucky-cat-base", @"lucky-cat-actor",
      @"chick-pecking-base", @"chick-pecking-actor",
      @"hamster-wheel-base", @"hamster-wheel-wheel", @"hamster-wheel-actor"
    ];
    NSMutableArray<NSImage *> *images = [NSMutableArray arrayWithCapacity:names.count];
    for (NSString *name in names) {
      NSString *path = [bundle pathForResource:name ofType:@"png"];
      NSImage *image = path ? [[NSImage alloc] initWithContentsOfFile:path] : nil;
      [images addObject:image ?: [[NSImage alloc] init]];
    }
    self.luckyCatBaseImage = images[0];
    self.luckyCatActorImage = images[1];
    self.chickBaseImage = images[2];
    self.chickActorImage = images[3];
    self.hamsterBaseImage = LoadHamsterSprite(@"hamster-habitat");
    self.hamsterActorImage = LoadHamsterSprite(@"hamster-pet");
  }
  return self;
}

- (BOOL)isOpaque { return NO; }

- (BOOL)mouseDownCanMoveWindow { return YES; }

- (void)rightMouseDown:(NSEvent *)event {
  [self.controller showContextMenu:event];
}

- (void)drawCenteredText:(NSString *)text
                    rect:(NSRect)rect
                    font:(NSFont *)font
                   color:(NSColor *)color {
  NSColor *glow = [color colorWithAlphaComponent:0.45];
  NSMutableParagraphStyle *center = [[NSMutableParagraphStyle alloc] init];
  center.alignment = NSTextAlignmentCenter;
  NSShadow *shadow = [[NSShadow alloc] init];
  shadow.shadowColor = glow;
  shadow.shadowOffset = NSMakeSize(0, -1);
  shadow.shadowBlurRadius = 3;
  NSDictionary *attributes = @{
    NSFontAttributeName: font,
    NSForegroundColorAttributeName: color,
    NSParagraphStyleAttributeName: center,
    NSShadowAttributeName: shadow
  };
  [text drawInRect:rect withAttributes:attributes];
}

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSGraphicsContext *ctx = NSGraphicsContext.currentContext;
  [ctx saveGraphicsState];
  ctx.imageInterpolation = NSImageInterpolationHigh;
  NSAffineTransform *canvas = [NSAffineTransform transform];
  [canvas scaleBy:kUiScale];
  [canvas concat];

  MeritController *controller = self.controller;
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  NSTimeInterval age = now - controller.strikeStartTime;
  BOOL striking = controller.strikeActive && age >= 0 &&
                  age < controller.activeStrikeDuration;
  double phase = 0.0;
  if (striking && controller.activeStrikeDuration > 0) {
    phase = std::clamp(age / controller.activeStrikeDuration, 0.0, 1.0);
  }

  double strikeAmount = 0.0;
  if (striking && phase < 0.42) {
    double t = phase / 0.42;
    strikeAmount = t * t * (3.0 - 2.0 * t);
  } else if (striking) {
    double t = (phase - 0.42) / 0.58;
    double eased = t * t * (3.0 - 2.0 * t);
    strikeAmount = 1.0 - eased;
  }

  if (self.scene == MeritSceneLuckyCat) {
    NSRect baseRect = NSMakeRect(5, -35, 230, 230);
    NSRect actorRect = NSMakeRect(30, -35, 230, 230);
    [self.luckyCatBaseImage drawInRect:baseRect
                              fromRect:NSZeroRect
                             operation:NSCompositingOperationSourceOver
                              fraction:1.0
                        respectFlipped:YES
                                 hints:nil];
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *paw = LuckyCatPawTransform(actorRect, strikeAmount);
    [paw concat];
    [self.luckyCatActorImage drawInRect:actorRect
                                fromRect:NSZeroRect
                               operation:NSCompositingOperationSourceOver
                                fraction:1.0
                          respectFlipped:YES
                                   hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  } else if (self.scene == MeritSceneChickPecking) {
    NSRect chickRect = NSMakeRect(5, -10, 230, 230);
    [self.chickBaseImage drawInRect:chickRect
                           fromRect:NSZeroRect
                          operation:NSCompositingOperationSourceOver
                           fraction:1.0
                     respectFlipped:YES
                              hints:nil];
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *head = [NSAffineTransform transform];
    [head translateXBy:168 yBy:119];
    [head rotateByDegrees:-12.0 * strikeAmount];
    [head translateXBy:-168 yBy:-119];
    [head translateXBy:5.0 * strikeAmount yBy:-18.0 * strikeAmount];
    [head concat];
    [self.chickActorImage drawInRect:chickRect
                            fromRect:NSZeroRect
                           operation:NSCompositingOperationSourceOver
                            fraction:1.0
                      respectFlipped:YES
                               hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  } else if (self.scene == MeritSceneHamsterWheel) {
    NSRect hamsterRect = NSMakeRect(27, -3, 186, 186);
    [self.hamsterBaseImage drawInRect:hamsterRect
                             fromRect:NSZeroRect
                            operation:NSCompositingOperationSourceOver
                             fraction:1.0
                       respectFlipped:YES
                                hints:nil];
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *hamster = [NSAffineTransform transform];
    // Keep the perspective wheel fixed. A small foot-anchored stride moves
    // the animal; rotating a projected ellipse would make the whole wheel wobble.
    [hamster translateXBy:130 yBy:58];
    [hamster rotateByDegrees:-2.0 * strikeAmount];
    [hamster scaleXBy:1.0 + .012 * strikeAmount yBy:1.0 - .025 * strikeAmount];
    [hamster translateXBy:-130 yBy:-58];
    [hamster concat];
    [self.hamsterActorImage drawInRect:NSMakeRect(33, 13, 168, 168)
                              fromRect:NSZeroRect
                             operation:NSCompositingOperationSourceOver
                              fraction:1.0
                        respectFlipped:YES
                                 hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  } else {
    NSRect shadowRect = NSMakeRect(34, 5, 172, 18);
    NSBezierPath *groundShadow = [NSBezierPath bezierPathWithOvalInRect:shadowRect];
    [[NSColor colorWithWhite:0 alpha:0.25] setFill];
    [groundShadow fill];

    [self.woodfishImage drawInRect:NSMakeRect(18, 8, 232, 140)
                          fromRect:NSZeroRect
                         operation:NSCompositingOperationSourceOver
                          fraction:1.0
                    respectFlipped:YES
                             hints:nil];

    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *malletTransform = [NSAffineTransform transform];
    [malletTransform translateXBy:280 yBy:160];
    [malletTransform rotateByDegrees:-6.0 + 9.0 * strikeAmount];
    [malletTransform concat];
    [self.malletImage drawInRect:NSMakeRect(-208, -26, 214, 54)
                        fromRect:NSZeroRect
                       operation:NSCompositingOperationSourceOver
                        fraction:1.0
                  respectFlipped:YES
                           hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  }

  if (!self.previewOnly && striking && phase >= .30 && phase <= .70) {
    CGFloat plusY = self.scene == MeritSceneWoodfish ? 148 : 180;
    [self drawCenteredText:@"+1"
                      rect:NSMakeRect(0, plusY, kWindowWidth, 30)
                      font:[NSFont monospacedDigitSystemFontOfSize:23
                                                           weight:NSFontWeightBold]
                     color:[NSColor colorWithCalibratedRed:.94 green:.50 blue:.16 alpha:1]];
  }

  // The counter is the product's source of truth and must never be hidden by
  // a scene or one of its moving layers, so it is deliberately drawn last.
  if (!self.previewOnly) {
  NSString *totalText = [NSString stringWithFormat:@"%lld", controller.todayTotal];
  CGFloat totalFont = totalText.length > 18 ? 24 : 30;
  if (totalText.length > 24) totalFont = 20;
  [self drawCenteredText:totalText
                    rect:NSMakeRect(0, 210, kWindowWidth, 40)
                    font:[NSFont monospacedDigitSystemFontOfSize:totalFont
                                                         weight:NSFontWeightBold]
                   color:[NSColor colorWithCalibratedRed:.78 green:.39 blue:.12 alpha:1]];
  }

[ctx restoreGraphicsState];
}

@end

@interface MeritCalendarView : NSView
@property(nonatomic, weak) MeritController *controller;
@property(nonatomic) NSInteger year;
@property(nonatomic) NSInteger month;
- (void)showCurrentMonth;
- (void)shiftMonth:(NSInteger)delta;
@end

@implementation MeritCalendarView

- (BOOL)isFlipped { return YES; }

- (void)showCurrentMonth {
  NSDateComponents *parts = [NSCalendar.currentCalendar
      components:NSCalendarUnitYear | NSCalendarUnitMonth fromDate:NSDate.date];
  self.year = parts.year;
  self.month = parts.month;
  [self setNeedsDisplay:YES];
}

- (void)shiftMonth:(NSInteger)delta {
  NSDateComponents *parts = [[NSDateComponents alloc] init];
  parts.year = self.year;
  parts.month = self.month + delta;
  parts.day = 1;
  NSDate *date = [NSCalendar.currentCalendar dateFromComponents:parts];
  NSDateComponents *normalized = [NSCalendar.currentCalendar
      components:NSCalendarUnitYear | NSCalendarUnitMonth fromDate:date];
  self.year = normalized.year;
  self.month = normalized.month;
  [self setNeedsDisplay:YES];
}

- (void)drawText:(NSString *)text rect:(NSRect)rect size:(CGFloat)size
           color:(NSColor *)color weight:(NSFontWeight)weight {
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.alignment = NSTextAlignmentCenter;
  paragraph.lineBreakMode = NSLineBreakByClipping;
  [text drawInRect:rect withAttributes:@{
    NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:size weight:weight],
    NSForegroundColorAttributeName: color,
    NSParagraphStyleAttributeName: paragraph
  }];
}

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  [[NSColor colorWithCalibratedRed:.97 green:.94 blue:.88 alpha:1] setFill];
  NSRectFill(self.bounds);

  NSColor *ink = [NSColor colorWithCalibratedRed:.24 green:.18 blue:.12 alpha:1];
  NSColor *muted = [NSColor colorWithCalibratedRed:.49 green:.42 blue:.34 alpha:1];
  NSColor *accent = [NSColor colorWithCalibratedRed:.78 green:.39 blue:.12 alpha:1];
  NSString *monthTitle = IsChineseUI()
      ? [NSString stringWithFormat:@"%ld 年 %ld 月", (long)self.year, (long)self.month]
      : [NSString stringWithFormat:@"%ld / %02ld", (long)self.year, (long)self.month];
  [self drawText:monthTitle rect:NSMakeRect(90, 18, 380, 32) size:22 color:ink weight:NSFontWeightSemibold];

  NSString *prefix = [NSString stringWithFormat:@"%04ld-%02ld-", (long)self.year, (long)self.month];
  unsigned long long monthTotal = 0;
  for (NSString *key in self.controller.dailyTotals) {
    if ([key hasPrefix:prefix]) monthTotal += self.controller.dailyTotals[key].unsignedLongLongValue;
  }
  NSString *allText = [NSString stringWithFormat:@"%@  %lld",
      UiText(@"累计功德", @"Total Merit"), self.controller.total];
  NSString *monthText = [NSString stringWithFormat:@"%@  %llu",
      UiText(@"本月功德", @"This Month"), monthTotal];
  [self drawText:allText rect:NSMakeRect(24, 62, 250, 28) size:17 color:accent weight:NSFontWeightBold];
  [self drawText:monthText rect:NSMakeRect(286, 62, 250, 28) size:17 color:accent weight:NSFontWeightBold];

  NSArray<NSString *> *weekdays = IsChineseUI()
      ? @[@"一", @"二", @"三", @"四", @"五", @"六", @"日"]
      : @[@"MON", @"TUE", @"WED", @"THU", @"FRI", @"SAT", @"SUN"];
  const CGFloat left = 14, top = 112, cellWidth = 76, cellHeight = 51;
  for (NSInteger column = 0; column < 7; ++column) {
    [self drawText:weekdays[column]
              rect:NSMakeRect(left + column * cellWidth, 94, cellWidth, 20)
              size:11 color:muted weight:NSFontWeightMedium];
  }

  NSDateComponents *firstParts = [[NSDateComponents alloc] init];
  firstParts.year = self.year; firstParts.month = self.month; firstParts.day = 1;
  NSDate *firstDate = [NSCalendar.currentCalendar dateFromComponents:firstParts];
  NSInteger firstWeekday = [NSCalendar.currentCalendar component:NSCalendarUnitWeekday
                                                         fromDate:firstDate];
  NSInteger offset = (firstWeekday + 5) % 7;
  NSRange days = [NSCalendar.currentCalendar rangeOfUnit:NSCalendarUnitDay
                                                  inUnit:NSCalendarUnitMonth
                                                 forDate:firstDate];
  NSString *todayKey = DateKeyForDate(NSDate.date);
  for (NSInteger day = 1; day <= (NSInteger)days.length; ++day) {
    NSInteger slot = offset + day - 1;
    NSInteger row = slot / 7, column = slot % 7;
    NSRect cell = NSMakeRect(left + column * cellWidth, top + row * cellHeight,
                             cellWidth - 2, cellHeight - 3);
    NSString *key = [NSString stringWithFormat:@"%04ld-%02ld-%02ld",
        (long)self.year, (long)self.month, (long)day];
    if ([key isEqualToString:todayKey]) {
      [[NSColor colorWithCalibratedRed:.95 green:.77 blue:.49 alpha:.38] setFill];
      [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(cell, 2, 3) xRadius:9 yRadius:9] fill];
    }
    unsigned long long value = self.controller.dailyTotals[key].unsignedLongLongValue;
    NSString *text = IsChineseUI()
        ? [NSString stringWithFormat:@"%llu（%02ld）", value, (long)day]
        : [NSString stringWithFormat:@"%llu (%02ld)", value, (long)day];
    CGFloat size = text.length > 12 ? 10 : (text.length > 8 ? 11 : 15);
    [self drawText:text rect:NSInsetRect(cell, 2, 14) size:size color:ink weight:NSFontWeightSemibold];
  }
}

@end

@implementation MeritController

- (void)loadState {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  self.total = [defaults integerForKey:kTotal];
  NSDictionary *storedDaily = [defaults dictionaryForKey:kDailyTotals];
  self.dailyTotals = storedDaily ? [storedDaily mutableCopy] : [NSMutableDictionary dictionary];
  self.currentDayKey = DateKeyForDate(NSDate.date);
  self.todayTotal = self.dailyTotals[self.currentDayKey].longLongValue;
  self.strikeActive = NO;
  self.strikeStartTime = -1;
  self.lastInputTime = 0;
  self.smoothedInputInterval = kDefaultStrikeDuration;
  self.activeStrikeDuration = kDefaultStrikeDuration;
  self.inputMonitoringAuthorized = NO;
  NSInteger storedScene = [defaults integerForKey:kSelectedScene];
  self.selectedScene = storedScene >= MeritSceneWoodfish &&
                               storedScene <= MeritSceneHamsterWheel
                           ? (MeritScene)storedScene
                           : MeritSceneWoodfish;
}

- (void)saveState {
  if (!self.dirty) return;
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  [defaults setInteger:self.total forKey:kTotal];
  [defaults setObject:self.dailyTotals forKey:kDailyTotals];
  self.dirty = NO;
}

- (void)ensureCurrentDay {
  NSString *today = DateKeyForDate(NSDate.date);
  if ([today isEqualToString:self.currentDayKey]) return;
  self.currentDayKey = today;
  self.todayTotal = self.dailyTotals[today].longLongValue;
  [self.view setNeedsDisplay:YES];
  [self.calendarView setNeedsDisplay:YES];
}

- (NSURL *)launchAgentURL {
  NSURL *libraryURL = [NSFileManager.defaultManager
      URLsForDirectory:NSLibraryDirectory
             inDomains:NSUserDomainMask].firstObject;
  NSURL *launchAgentsURL = [libraryURL URLByAppendingPathComponent:@"LaunchAgents"
                                                       isDirectory:YES];
  NSString *fileName = [kLaunchAgentLabel stringByAppendingString:@".plist"];
  return [launchAgentsURL URLByAppendingPathComponent:fileName];
}

- (BOOL)isLaunchAtLoginEnabled {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  if (![defaults boolForKey:kLaunchAtLoginEnabled]) return NO;
  return [NSFileManager.defaultManager fileExistsAtPath:self.launchAgentURL.path];
}

- (BOOL)setLaunchAtLoginEnabled:(BOOL)enabled showError:(BOOL)showError {
  NSFileManager *fileManager = NSFileManager.defaultManager;
  NSURL *agentURL = self.launchAgentURL;
  NSError *error = nil;
  BOOL succeeded = YES;

  if (enabled) {
    [fileManager createDirectoryAtURL:agentURL.URLByDeletingLastPathComponent
          withIntermediateDirectories:YES
                           attributes:nil
                                error:&error];
    if (!error) {
      NSString *bundlePath = NSBundle.mainBundle.bundlePath;
      NSDictionary *propertyList = @{
        @"Label": kLaunchAgentLabel,
        @"ProgramArguments": @[@"/usr/bin/open", @"-a", bundlePath,
                                @"--args", @"--autostart"],
        @"RunAtLoad": @YES,
        @"KeepAlive": @NO
      };
      NSData *data = [NSPropertyListSerialization
          dataWithPropertyList:propertyList
                        format:NSPropertyListXMLFormat_v1_0
                       options:0
                         error:&error];
      if (data && !error) {
        succeeded = [data writeToURL:agentURL
                             options:NSDataWritingAtomic
                               error:&error];
      } else {
        succeeded = NO;
      }
    } else {
      succeeded = NO;
    }
  } else if ([fileManager fileExistsAtPath:agentURL.path]) {
    succeeded = [fileManager removeItemAtURL:agentURL error:&error];
  }

  if (succeeded) {
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    [defaults setBool:YES forKey:kLaunchAtLoginConfigured];
    [defaults setBool:enabled forKey:kLaunchAtLoginEnabled];
  } else if (showError) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = UiText(@"无法修改登录启动项", @"Unable to change login startup");
    alert.informativeText = error.localizedDescription ?:
        UiText(@"请稍后重试。", @"Please try again later.");
    [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
    [alert runModal];
  }
  return succeeded;
}

- (void)configureLaunchAtLogin {
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  if ([defaults objectForKey:kLaunchAtLoginConfigured] == nil) {
    [self setLaunchAtLoginEnabled:YES showError:NO];
  } else if ([defaults boolForKey:kLaunchAtLoginEnabled]) {
    // Refresh the bundle path after the user moves or updates the app.
    [self setLaunchAtLoginEnabled:YES showError:NO];
  }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.launchedAutomatically =
      [NSProcessInfo.processInfo.arguments containsObject:@"--autostart"];
  self.diagnostics = [NSProcessInfo.processInfo.arguments containsObject:@"--diagnostics"];
  NSString *bundleIdentifier = NSBundle.mainBundle.bundleIdentifier;
  if (bundleIdentifier.length > 0) {
    pid_t currentProcess = NSProcessInfo.processInfo.processIdentifier;
    for (NSRunningApplication *running in
         [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
      if (running.processIdentifier != currentProcess) {
        if (!self.launchedAutomatically) {
          [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        }
        [NSApp terminate:nil];
        return;
      }
    }
  }
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [self loadState];
  [self configureLaunchAtLogin];

  self.view = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, kWindowScaleWidth, kWindowScaleHeight)];
  self.view.controller = self;
  self.view.scene = self.selectedScene;
  self.window = [[NSWindow alloc] initWithContentRect:self.view.bounds
                                            styleMask:NSWindowStyleMaskBorderless
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.contentView = self.view;
  self.window.backgroundColor = NSColor.clearColor;
  self.window.opaque = NO;
  self.window.hasShadow = NO;
  self.window.level = NSFloatingWindowLevel;
  self.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorFullScreenAuxiliary;
  self.window.movableByWindowBackground = YES;
  [self.window setFrameAutosaveName:@"NiuMaMeritPosition"];
  BOOL restoredFrame = [self.window setFrameUsingName:@"NiuMaMeritPosition"];
  if (restoredFrame) {
    NSRect frame = self.window.frame;
    frame.size = NSMakeSize(kWindowScaleWidth, kWindowScaleHeight);
    [self.window setFrame:frame display:NO];
  }
  BOOL frameIsVisible = NO;
  for (NSScreen *screen in NSScreen.screens) {
    NSRect intersection = NSIntersectionRect(self.window.frame, screen.visibleFrame);
    if (NSWidth(intersection) >= 24 && NSHeight(intersection) >= 24) {
      frameIsVisible = YES;
      break;
    }
  }
  if (!restoredFrame || !frameIsVisible) {
    NSScreen *screen = NSScreen.mainScreen;
    [self.window setFrameOrigin:NSMakePoint(NSMaxX(screen.visibleFrame) - 280 * kUiScale,
                                           NSMaxY(screen.visibleFrame) - 270 * kUiScale)];
  }
  [self.window orderFrontRegardless];

  self.saveTimer = [NSTimer scheduledTimerWithTimeInterval:5
                                                    target:self
                                                  selector:@selector(saveState)
                                                  userInfo:nil
                                                   repeats:YES];
  [NSRunLoop.mainRunLoop addTimer:self.saveTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.saveTimer forMode:NSModalPanelRunLoopMode];
  self.dayTimer = [NSTimer scheduledTimerWithTimeInterval:30
                                                   target:self
                                                 selector:@selector(ensureCurrentDay)
                                                 userInfo:nil
                                                  repeats:YES];
  [NSRunLoop.mainRunLoop addTimer:self.dayTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.dayTimer forMode:NSModalPanelRunLoopMode];
  // Monitor tap health even on a silent autostart or after a failed installation.
  self.permissionPollTimer = [NSTimer timerWithTimeInterval:kPermissionPollInterval * 2
      target:self selector:@selector(checkPermission:) userInfo:nil repeats:YES];
  [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSModalPanelRunLoopMode];
  [self installEventTap];
  if (!self.launchedAutomatically) [self showPermissionIntroIfNeeded];
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  [self ensureCurrentDay];
  [self checkPermission:nil];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  [self saveState];
  [self.dayTimer invalidate];
  [self removeEventTap];
  [self stopPermissionPoll];
}

- (void)startStrikeWithDuration:(NSTimeInterval)duration {
  if (self.strikeActive) return;
  self.strikeActive = YES;
  self.strikeStartTime = [NSDate timeIntervalSinceReferenceDate];
  self.activeStrikeDuration = duration;
  if (!self.animationTimer) {
    self.animationTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 60.0
                                                          target:self
                                                        selector:@selector(animate:)
                                                        userInfo:nil
                                                         repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.animationTimer forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:self.animationTimer forMode:NSModalPanelRunLoopMode];
  }
}

- (void)showPermissionIntroIfNeeded {
  if (self.inputMonitoringAuthorized) return;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = UiText(@"需要输入监控权限", @"Input Monitoring Permission Required");
  alert.informativeText = UiText(
      @"为了在其他软件中也能计数，macOS 需要“输入监控”权限。"
       @"本应用只判断是否发生按键或鼠标事件，不读取具体按键、鼠标坐标、窗口名或内容。\n\n"
       @"本版本不包含联网功能，数据只保存在本机。",
      @"To count while you use other apps, macOS requires Input Monitoring permission. "
       @"This app only detects that a keyboard or mouse event occurred. It does not read "
       @"specific keys, mouse coordinates, window names, or content.\n\n"
       @"This version has no network features. All data stays on this Mac.");
  [alert addButtonWithTitle:UiText(@"开启全局计数", @"Enable Global Counting")];
  [alert addButtonWithTitle:UiText(@"暂不开启", @"Not Now")];
  if ([alert runModal] == NSAlertFirstButtonReturn) {
    [self requestListenPermission];
  }
}

- (void)requestListenPermission {
  BOOL granted = CGRequestListenEventAccess();
  if (granted) {
    [self checkPermission:nil];
    return;
  }
  NSURL *url = [NSURL URLWithString:
      @"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"];
  [NSWorkspace.sharedWorkspace openURL:url];
  if (!self.inputMonitoringAuthorized) {
    if (!self.permissionPollTimer) {
      self.permissionPollTimer =
        [NSTimer scheduledTimerWithTimeInterval:kPermissionPollInterval
                                         target:self
                                       selector:@selector(checkPermission:)
                                       userInfo:nil
                                        repeats:YES];
    }
  }
}

- (void)checkPermission:(NSTimer *)timer {
  (void)timer;
  BOOL allowed = CGPreflightListenEventAccess();
  // Preflight is advisory: creation/enabled state is the actual result.
  // In particular, do not tear down a working tap on a stale preflight answer.
  if (self.eventTap && !CFMachPortIsValid(self.eventTap)) [self removeEventTap];
  if (self.eventTap && !CGEventTapIsEnabled(self.eventTap)) CGEventTapEnable(self.eventTap, true);
  if (self.eventTap && !CGEventTapIsEnabled(self.eventTap)) [self removeEventTap];
  [self installEventTap];
  self.inputMonitoringAuthorized = self.eventTap && CGEventTapIsEnabled(self.eventTap);
  if (self.diagnostics) {
    fprintf(stderr, "listen_allowed=%d tap_valid=%d tap_enabled=%d received=%lu keys=%lu clicks=%lu scrolls=%lu total=%lld\n",
        allowed, self.eventTap && CFMachPortIsValid(self.eventTap),
        self.eventTap && CGEventTapIsEnabled(self.eventTap),
        (unsigned long)self.receivedEvents, (unsigned long)self.receivedKeys,
        (unsigned long)self.receivedClicks, (unsigned long)self.receivedScrolls, self.total);
    fflush(stderr);
  }
}

- (void)stopPermissionPoll {
  if (!self.permissionPollTimer) return;
  [self.permissionPollTimer invalidate];
  self.permissionPollTimer = nil;
}

- (void)installEventTap {
  if (self.eventTap) {
    return;
  }
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventLeftMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseDown) |
                     CGEventMaskBit(kCGEventScrollWheel);
  self.eventTap = CGEventTapCreate(kCGHIDEventTap,
                                   kCGHeadInsertEventTap,
                                   kCGEventTapOptionListenOnly,
                                   mask,
                                   EventTapCallback,
                                   (__bridge void *)self);
  if (self.eventTap) {
    CGEventTapEnable(self.eventTap, true);
    if (!CGEventTapIsEnabled(self.eventTap)) {
      CFRelease(self.eventTap);
      self.eventTap = nullptr;
    }
  }
  if (!self.eventTap) {
    self.eventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly, mask, EventTapCallback, (__bridge void *)self);
  }
  if (self.diagnostics) {
    fprintf(stderr, "tap_create=%s\n", self.eventTap ? "success" : "denied_or_unavailable");
    fflush(stderr);
  }
  if (!self.eventTap) {
    self.inputMonitoringAuthorized = NO;
    [self.view setNeedsDisplay:YES];
    return;
  }

  self.eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, self.eventTap, 0);
  if (!self.eventSource) { [self removeEventTap]; return; }
  CFRunLoopAddSource(CFRunLoopGetMain(), self.eventSource, kCFRunLoopCommonModes);
  CFRunLoopAddSource(CFRunLoopGetMain(), self.eventSource, (__bridge CFStringRef)NSModalPanelRunLoopMode);
  CGEventTapEnable(self.eventTap, true);
  self.inputMonitoringAuthorized = CGEventTapIsEnabled(self.eventTap);
  if (!self.inputMonitoringAuthorized) [self removeEventTap];
  [self.view setNeedsDisplay:YES];
}

- (void)removeEventTap {
  if (!self.eventTap && !self.eventSource) return;
  if (self.eventTap) {
    CGEventTapEnable(self.eventTap, false);
    CFRelease(self.eventTap);
    self.eventTap = nullptr;
  }
  if (self.eventSource) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), self.eventSource, kCFRunLoopCommonModes);
    CFRunLoopRemoveSource(CFRunLoopGetMain(), self.eventSource, (__bridge CFStringRef)NSModalPanelRunLoopMode);
    CFRelease(self.eventSource);
    self.eventSource = nullptr;
  }
  self.inputMonitoringAuthorized = NO;
}

- (void)handleEventTapDisabled {
  if (self.eventTap && CFMachPortIsValid(self.eventTap)) {
    CGEventTapEnable(self.eventTap, true);
  }
  self.inputMonitoringAuthorized = self.eventTap && CGEventTapIsEnabled(self.eventTap);
}

- (void)count {
  [self ensureCurrentDay];
  if (self.total == LLONG_MAX) return;
  self.total++;
  if (self.todayTotal < LLONG_MAX) self.todayTotal++;
  self.dailyTotals[self.currentDayKey] = @(self.todayTotal);
  self.dirty = YES;
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  if (self.lastInputTime > 0) {
    NSTimeInterval gap = now - self.lastInputTime;
    if (gap > kPauseForResetGap) {
      self.smoothedInputInterval = kDefaultStrikeDuration;
    } else {
      self.smoothedInputInterval =
          self.smoothedInputInterval * (1.0 - kEmaWeight) + gap * kEmaWeight;
    }
  } else {
    self.smoothedInputInterval = kDefaultStrikeDuration;
  }
  self.lastInputTime = now;
  NSTimeInterval desiredDuration = std::clamp(
      self.smoothedInputInterval * 1.05, kMinStrikeDuration, kMaxStrikeDuration);
  [self startStrikeWithDuration:desiredDuration];
  [self.view setNeedsDisplay:YES];
  [self.calendarView setNeedsDisplay:YES];
}

- (void)countScrollGesture {
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  BOOL beginsNewGesture = self.lastScrollEventTime <= 0 ||
                          now - self.lastScrollEventTime > kScrollGestureIdleGap;
  self.lastScrollEventTime = now;
  if (beginsNewGesture) [self count];
}

- (void)animate:(NSTimer *)timer {
  (void)timer;
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  NSTimeInterval age = now - self.strikeStartTime;
  [self.view setNeedsDisplay:YES];
  if (!self.strikeActive) return;
  if (age >= self.activeStrikeDuration) {
    self.strikeActive = NO;
    [self.animationTimer invalidate];
    self.animationTimer = nil;
  }
}

- (void)stopAnimation {
  if (!self.animationTimer) return;
  [self.animationTimer invalidate];
  self.animationTimer = nil;
}

- (void)showContextMenu:(NSEvent *)event {
  NSMenu *menu = [[NSMenu alloc] init];
  NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:UiText(@"关于牛马电子功德", @"About NiuMa Merit")
                                                action:@selector(showAbout:)
                                         keyEquivalent:@""];
  about.target = self;
  [menu addItem:about];
  NSMenuItem *launchAtLogin = [[NSMenuItem alloc]
      initWithTitle:UiText(@"登录后自动启动", @"Start at Login")
             action:@selector(toggleLaunchAtLogin:)
      keyEquivalent:@""];
  launchAtLogin.target = self;
  launchAtLogin.state = self.isLaunchAtLoginEnabled
      ? NSControlStateValueOn
      : NSControlStateValueOff;
  [menu addItem:launchAtLogin];
  NSMenuItem *appearance = [[NSMenuItem alloc] initWithTitle:UiText(@"更换形象", @"Change Appearance")
                                                     action:@selector(showAppearancePicker:)
                                              keyEquivalent:@""];
  appearance.target = self;
  [menu addItem:appearance];
  NSMenuItem *calendar = [[NSMenuItem alloc]
      initWithTitle:UiText(@"功德日历…", @"Merit Calendar…")
             action:@selector(showMeritCalendar:)
      keyEquivalent:@""];
  calendar.target = self;
  [menu addItem:calendar];
  [menu addItem:NSMenuItem.separatorItem];
  NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:UiText(@"退出", @"Quit")
                                                action:@selector(terminate:)
                                         keyEquivalent:@""];
  quit.target = NSApp;
  [menu addItem:quit];
  [NSMenu popUpContextMenu:menu withEvent:event forView:self.view];
}

- (void)toggleLaunchAtLogin:(id)sender {
  (void)sender;
  [self setLaunchAtLoginEnabled:!self.isLaunchAtLoginEnabled showError:YES];
}

- (void)showMeritCalendar:(id)sender {
  (void)sender;
  [self ensureCurrentDay];
  if (!self.calendarWindow) {
    NSRect frame = NSMakeRect(0, 0, 560, 430);
    self.calendarView = [[MeritCalendarView alloc] initWithFrame:frame];
    self.calendarView.controller = self;
    [self.calendarView showCurrentMonth];
    NSButton *previous = [[NSButton alloc] initWithFrame:NSMakeRect(24, 18, 44, 28)];
    previous.title = @"<"; previous.tag = -1; previous.target = self;
    previous.action = @selector(shiftCalendarMonth:);
    NSButton *next = [[NSButton alloc] initWithFrame:NSMakeRect(492, 18, 44, 28)];
    next.title = @">"; next.tag = 1; next.target = self;
    next.action = @selector(shiftCalendarMonth:);
    [self.calendarView addSubview:previous];
    [self.calendarView addSubview:next];
    self.calendarWindow = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
          backing:NSBackingStoreBuffered defer:NO];
    self.calendarWindow.title = UiText(@"功德日历", @"Merit Calendar");
    self.calendarWindow.contentView = self.calendarView;
    self.calendarWindow.releasedWhenClosed = NO;
    [self.calendarWindow center];
  }
  [NSApp activateIgnoringOtherApps:YES];
  [self.calendarWindow makeKeyAndOrderFront:nil];
}

- (void)shiftCalendarMonth:(NSButton *)sender {
  [self.calendarView shiftMonth:sender.tag];
}

- (void)selectAppearance:(NSButton *)sender {
  self.pendingScene = sender.tag;
  for (NSButton *button in self.appearanceButtons) {
    button.state = button.tag == self.pendingScene ? NSControlStateValueOn : NSControlStateValueOff;
  }
}

- (NSView *)appearanceGrid {
  NSView *grid = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 324, 316)];
  NSArray *titles = IsChineseUI()
      ? @[@"默认木鱼", @"招财猫", @"小鸡啄米", @"仓鼠跑轮"]
      : @[@"Woodfish", @"Lucky Cat", @"Pecking Chick", @"Hamster Wheel"];
  NSMutableArray *buttons = [NSMutableArray array];
  for (NSInteger i = 0; i < 4; ++i) {
    MeritView *preview = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, 120, 125)];
    preview.previewOnly = YES;
    preview.scene = (MeritScene)i;
    NSBitmapImageRep *rep = [preview bitmapImageRepForCachingDisplayInRect:preview.bounds];
    [preview cacheDisplayInRect:preview.bounds toBitmapImageRep:rep];
    NSImage *thumbnail = [[NSImage alloc] initWithSize:preview.bounds.size];
    [thumbnail addRepresentation:rep];
    NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect((i % 2) * 168, (1 - i / 2) * 162, 156, 154)];
    button.title = titles[i];
    button.image = thumbnail;
    button.imagePosition = NSImageAbove;
    button.imageScaling = NSImageScaleProportionallyDown;
    button.bezelStyle = NSBezelStyleRegularSquare;
    [button setButtonType:NSButtonTypePushOnPushOff];
    button.tag = i;
    button.target = self;
    button.action = @selector(selectAppearance:);
    button.state = i == self.pendingScene ? NSControlStateValueOn : NSControlStateValueOff;
    [grid addSubview:button];
    [buttons addObject:button];
  }
  self.appearanceButtons = buttons;
  return grid;
}

- (void)showAppearancePicker:(id)sender {
  (void)sender;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = UiText(@"更换形象", @"Change Appearance");
  alert.informativeText = @"";
  self.pendingScene = self.selectedScene;
  alert.accessoryView = [self appearanceGrid];
  [alert addButtonWithTitle:UiText(@"确认", @"Confirm")];
  [alert addButtonWithTitle:UiText(@"取消", @"Cancel")];
  if ([alert runModal] == NSAlertFirstButtonReturn) {
    self.selectedScene = (MeritScene)self.pendingScene;
    self.view.scene = self.selectedScene;
    [NSUserDefaults.standardUserDefaults setInteger:self.selectedScene
                                             forKey:kSelectedScene];
    [self.view setNeedsDisplay:YES];
    [self stopAnimation];
    self.strikeActive = NO;
    [self startStrikeWithDuration:0.800];
  }
}

- (void)showAbout:(id)sender {
  (void)sender;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = UiText(@"牛马电子功德", @"NiuMa Merit");
  alert.informativeText = UiText(
      @"版本 0.4.0\n\n"
       @"只统计按键、鼠标按键和滚轮手势发生的次数，不读取具体内容、鼠标位置或窗口信息。\n"
       @"所有数据仅保存在本机，本软件不包含网络请求、遥测或自动更新。\n\n"
       @"客户端源代码依 GPLv3 许可证开放。\n\n"
       @"项目主页：\n"
       @"https://github.com/Mr-shanqiu/niuma-ELEC-gongde",
      @"Version 0.4.0\n\n"
       @"Counts keyboard presses, mouse button presses, and scroll gestures. It does not read "
       @"specific input, mouse positions, or window information.\n"
       @"All data stays on this computer. The app contains no network requests, telemetry, or automatic updates.\n\n"
       @"Client source code is available under GPLv3.\n\n"
       @"Project page:\n"
       @"https://github.com/Mr-shanqiu/niuma-ELEC-gongde");
  [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
  if (!self.inputMonitoringAuthorized) {
    [alert addButtonWithTitle:UiText(@"开启输入监控", @"Enable Input Monitoring")];
  }
  NSModalResponse response = [alert runModal];
  if (!self.inputMonitoringAuthorized && response == NSAlertSecondButtonReturn) {
    [self requestListenPermission];
  }
}

@end

static CGEventRef EventTapCallback(CGEventTapProxy proxy,
                                   CGEventType type,
                                   CGEventRef event,
                                   void *context) {
  (void)proxy;
  (void)event;
  MeritController *controller = (__bridge MeritController *)context;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    [controller handleEventTapDisabled];
  } else if (type == kCGEventScrollWheel) {
    controller.receivedEvents++;
    controller.receivedScrolls++;
    [controller countScrollGesture];
  } else if (type == kCGEventKeyDown || type == kCGEventLeftMouseDown ||
             type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown) {
    controller.receivedEvents++;
    if (type == kCGEventKeyDown) controller.receivedKeys++;
    else controller.receivedClicks++;
    [controller count];
  }
  return event;
}

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    MeritController *controller = [[MeritController alloc] init];
    app.delegate = controller;
    [app run];
  }
  return 0;
}
