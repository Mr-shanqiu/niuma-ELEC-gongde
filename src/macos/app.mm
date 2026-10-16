#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "appearance_pack.mm"
#include "../offwork_clock.h"

#include <algorithm>
#include <cmath>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <sys/stat.h>
#include <unistd.h>

// Explicit acceptance launches never consult the user's product preferences.
// The pack root must be an empty, private directory supplied by the runner;
// invalid or incomplete isolation settings fail before NSApplication starts.
static BOOL gIsolatedAcceptance = NO;

@protocol NMMeritPreferences <NSObject>
- (id)objectForKey:(NSString *)key;
- (NSInteger)integerForKey:(NSString *)key;
- (BOOL)boolForKey:(NSString *)key;
- (NSString *)stringForKey:(NSString *)key;
- (NSDictionary *)dictionaryForKey:(NSString *)key;
- (void)setInteger:(NSInteger)value forKey:(NSString *)key;
- (void)setBool:(BOOL)value forKey:(NSString *)key;
- (void)setObject:(id)value forKey:(NSString *)key;
@end

@interface NMEphemeralMeritPreferences : NSObject <NMMeritPreferences>
@property(nonatomic, strong) NSMutableDictionary<NSString *, id> *values;
@end

@implementation NMEphemeralMeritPreferences
- (instancetype)init {
  self = [super init];
  if (self) self.values = [NSMutableDictionary dictionary];
  return self;
}
- (id)objectForKey:(NSString *)key { return self.values[key]; }
- (NSInteger)integerForKey:(NSString *)key { return [self.values[key] integerValue]; }
- (BOOL)boolForKey:(NSString *)key { return [self.values[key] boolValue]; }
- (NSString *)stringForKey:(NSString *)key {
  id value = self.values[key];
  return [value isKindOfClass:NSString.class] ? value : nil;
}
- (NSDictionary *)dictionaryForKey:(NSString *)key {
  id value = self.values[key];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
- (void)setInteger:(NSInteger)value forKey:(NSString *)key { self.values[key] = @(value); }
- (void)setBool:(BOOL)value forKey:(NSString *)key { self.values[key] = @(value); }
- (void)setObject:(id)value forKey:(NSString *)key {
  if (value) self.values[key] = [value copy];
  else [self.values removeObjectForKey:key];
}
@end

static NMEphemeralMeritPreferences *gAcceptancePreferences;

static BOOL InitializeAcceptanceContext(int argc, const char *argv[]) {
  BOOL requested = NO;
  for (int index = 1; index < argc; ++index) {
    if (strcmp(argv[index], "--isolated-acceptance") == 0) requested = YES;
  }
  const char *rootValue = getenv("NIUMA_ACCEPTANCE_ROOT");
  if (!requested && !rootValue) return YES;
  if (!requested || !rootValue || !rootValue[0]) return NO;
  NSString *root = [NSString stringWithUTF8String:rootValue];
  if (!root.isAbsolutePath ||
      ![root.stringByDeletingLastPathComponent isEqualToString:@"/private/tmp"] ||
      ![root.lastPathComponent hasPrefix:@"niuma-merit-acceptance-"]) return NO;
  char resolved[PATH_MAX];
  struct stat attributes;
  if (!realpath(rootValue, resolved) || strcmp(rootValue, resolved) != 0 ||
      lstat(rootValue, &attributes) != 0 || !S_ISDIR(attributes.st_mode) ||
      attributes.st_uid != geteuid() || (attributes.st_mode & 0777) != 0700) return NO;
  const char *packValue = getenv("NIUMA_PACK_ROOT");
  NSString *packRoot = packValue ? [NSString stringWithUTF8String:packValue] : nil;
  if (![packRoot isEqualToString:[root stringByAppendingPathComponent:@"AppearancePacks"]]) return NO;
  NSError *error = nil;
  NSArray *entries = [NSFileManager.defaultManager contentsOfDirectoryAtPath:root error:&error];
  if (!entries || error || entries.count != 0) return NO;
  gAcceptancePreferences = [[NMEphemeralMeritPreferences alloc] init];
  gIsolatedAcceptance = YES;
  return YES;
}

static id<NMMeritPreferences> MeritPreferences(void) {
  if (gIsolatedAcceptance) return gAcceptancePreferences;
  return (id<NMMeritPreferences>)NSUserDefaults.standardUserDefaults;
}

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
static NSString *const kSelectedAppearance = @"selectedAppearanceId";
// Keep countdown preferences and snapshots independent of merit persistence.
static NSString *const kOffworkEnabled = @"offwork.enabled";
static NSString *const kOffworkHour = @"offwork.hour";
static NSString *const kOffworkMinute = @"offwork.minute";
static NSString *const kOffworkDailySnapshots = @"offwork.dailySnapshots";
static constexpr CGFloat kOffworkRegionHeight = 96.0;
static constexpr CGFloat kCalendarLeft = 14.0;
static constexpr CGFloat kCalendarTop = 112.0;
static constexpr CGFloat kCalendarCellWidth = 76.0;
static constexpr CGFloat kCalendarCellHeight = 64.0;
static constexpr CGFloat kArtworkTop = 170.0;
static constexpr CGFloat kFeedbackY = 174.0;
static constexpr CGFloat kCounterY = 210.0;
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

static NSString *OffworkDurationText(long long seconds) {
  return [NSString stringWithUTF8String:niuma::OffworkDuration(seconds).c_str()];
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
  MeritSceneSeaLionBellyPat = 2,
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
@property(nonatomic, strong) NSImage *seaLionBodyImage;
@property(nonatomic, strong) NSImage *seaLionFlipperImage;
@property(nonatomic, strong) NSImage *hamsterBaseImage;
@property(nonatomic, strong) NSImage *hamsterWheelImage;
@property(nonatomic, strong) NSImage *hamsterActorImage;
@property(nonatomic, strong) NMAppearancePack *appearancePack;
@property(nonatomic) MeritScene scene;
@property(nonatomic) BOOL previewOnly;
@end

@interface MeritController : NSObject <NSApplicationDelegate, NSWindowDelegate> {
  niuma::OffworkSnapshot _offworkSnapshot;
}
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) MeritView *view;
@property(nonatomic, strong) NSTimer *animationTimer;
@property(nonatomic, strong) NSTimer *permissionPollTimer;
@property(nonatomic, strong) NSTimer *saveTimer;
@property(nonatomic, strong) NSTimer *dayTimer;
@property(nonatomic, strong) NSWindow *calendarWindow;
@property(nonatomic, strong) MeritCalendarView *calendarView;
@property(nonatomic, strong) NSTimer *offworkTimer;
@property(nonatomic, strong) NSWindow *offworkSettingsWindow;
@property(nonatomic, strong) NSButton *offworkEnableControl;
@property(nonatomic, strong) NSPopUpButton *offworkHourControl;
@property(nonatomic, strong) NSPopUpButton *offworkMinuteControl;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *offworkDailySnapshots;
@property(nonatomic) BOOL offworkEnabled;
@property(nonatomic) NSInteger offworkHour;
@property(nonatomic) NSInteger offworkMinute;
@property(nonatomic) BOOL offworkDirty;
@property(nonatomic) BOOL offworkHasSnapshot;
@property(nonatomic) BOOL offworkSuspended;
@property(nonatomic) BOOL offworkLayoutExpanded;
@property(nonatomic) BOOL offworkIsOvertime;
@property(nonatomic, copy) NSString *offworkDayKey;
@property(nonatomic, copy) NSString *offworkDisplayLabel;
@property(nonatomic, copy) NSString *offworkDisplayDuration;
@property(nonatomic) NSTimeInterval offworkLastSampleUptime;
@property(nonatomic) NSTimeInterval offworkLastFlushUptime;
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
@property(nonatomic, copy) NSString *selectedAppearanceId;
@property(nonatomic, copy) NSString *pendingAppearanceId;
@property(nonatomic, copy) NSString *suggestedAppearanceId;
@property(nonatomic, strong) NSArray<NMAppearancePack *> *installedAppearancePacks;
@property(nonatomic, strong) NSArray<NSDictionary *> *appearanceItems;
@property(nonatomic) BOOL diagnostics;
@property(nonatomic) NSUInteger receivedEvents;
@property(nonatomic) NSUInteger receivedKeys;
@property(nonatomic) NSUInteger receivedClicks;
@property(nonatomic) NSUInteger receivedScrolls;
@property(nonatomic, strong) NSWindow *countStatusWindow;
@property(nonatomic, strong) NSTextView *countStatusText;
@property(nonatomic, strong) NSButton *selfCheckButton;
@property(nonatomic, strong) NSTimer *countStatusTimer;
@property(nonatomic) BOOL globalCountConfirmed;
@property(nonatomic) BOOL listenerNeedsCheck;
@property(nonatomic) BOOL selfCheckActive;
@property(nonatomic) BOOL selfCheckCountingEvent;
@property(nonatomic) BOOL selfCheckInterrupted;
@property(nonatomic) NSTimeInterval selfCheckStarts;
@property(nonatomic) NSTimeInterval selfCheckEnds;
@property(nonatomic) NSTimeInterval selfCheckLastEvent;
@property(nonatomic) NSUInteger selfCheckKeys;
@property(nonatomic) NSUInteger selfCheckClicks;
@property(nonatomic) NSUInteger selfCheckScrolls;
@property(nonatomic) NSUInteger selfCheckExpected;
@property(nonatomic) NSUInteger selfCheckCounted;
@property(nonatomic, copy) NSString *selfCheckResult;
@property(nonatomic, copy) NSSet<NSString *> *newlyImportedIds;
@property(nonatomic, copy) NSSet<NSString *> *lastImportedIds;
@property(nonatomic, strong) NSAlert *appearancePickerAlert;
@property(nonatomic, strong) NSError *appearanceLoadError;
- (BOOL)hasLiveEventTap;
- (NSString *)countStatusTitle;
- (void)receiveGlobalEvent:(CGEventType)type;
- (void)countPetClickIfNeeded;
- (void)showCountStatus:(id)sender;
- (void)refreshCountStatus:(NSTimer *)timer;
- (void)startSelfCheck:(id)sender;
- (void)retryListener:(id)sender;
- (void)closeCountStatus:(id)sender;
- (void)showFirstUseGuide:(id)sender;
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
- (void)reloadAppearancePacks;
- (NMAppearancePack *)appearancePackWithId:(NSString *)identifier;
- (void)applyAppearanceId:(NSString *)identifier;
- (void)loadOffworkState;
- (void)startOffworkTimer;
- (void)refreshOffworkAllowRollover:(BOOL)allowRollover;
- (void)flushOffwork:(BOOL)durable;
- (void)showOffworkSettings:(id)sender;
- (void)offworkEnableChanged:(id)sender;
- (void)saveOffworkSettings:(id)sender;
- (void)cancelOffworkSettings:(id)sender;
- (NSDictionary *)offworkRecordForDay:(NSString *)key;
- (void)showCalendarDay:(NSString *)key;
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
      @"sea-lion-body", @"sea-lion-flipper",
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
    self.seaLionBodyImage = images[2];
    self.seaLionFlipperImage = images[3];
    self.hamsterBaseImage = LoadHamsterSprite(@"hamster-habitat");
    self.hamsterActorImage = LoadHamsterSprite(@"hamster-pet");
  }
  return self;
}

- (BOOL)isOpaque { return NO; }

- (BOOL)mouseDownCanMoveWindow { return YES; }

- (void)mouseDown:(NSEvent *)event {
  if (self.previewOnly) return;
  [self.controller countPetClickIfNeeded];
  [self.window performWindowDragWithEvent:event];
}

- (void)otherMouseDown:(NSEvent *)event {
  (void)event;
  if (!self.previewOnly) [self.controller countPetClickIfNeeded];
}

- (void)rightMouseDown:(NSEvent *)event {
  if (self.previewOnly) return;
  [self.controller countPetClickIfNeeded];
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

  // Extend below the existing canvas, leaving every artwork/counter coordinate intact.
  [ctx saveGraphicsState];
  if (!self.previewOnly && self.controller.offworkEnabled) {
    NSAffineTransform *layout = [NSAffineTransform transform];
    [layout translateXBy:0 yBy:kOffworkRegionHeight];
    [layout concat];
  }

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

  // Three non-overlapping layout regions: artwork 0...170, transient feedback
  // 174...204, and the daily counter 210...250. Artwork is clipped so a
  // malformed or oversized appearance can never cover either number.
  [ctx saveGraphicsState];
  [[NSBezierPath bezierPathWithRect:NSMakeRect(0, 0, kWindowWidth, kArtworkTop)] addClip];
  if (self.appearancePack) {
    [self.appearancePack drawAtPhase:striking ? phase : 0.0];
  } else if (self.scene == MeritSceneLuckyCat) {
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
  } else if (self.scene == MeritSceneSeaLionBellyPat) {
    [self.seaLionBodyImage drawInRect:NSMakeRect(34, 0, 172, 168)
                             fromRect:NSZeroRect
                            operation:NSCompositingOperationSourceOver
                             fraction:1.0
                       respectFlipped:NO
                                hints:nil];
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *flipper = [NSAffineTransform transform];
    [flipper translateXBy:159.65 - 3.0 * strikeAmount
                      yBy:103.4 - 2.0 * strikeAmount];
    [flipper rotateByDegrees:-48.0 * strikeAmount];
    [flipper translateXBy:-159.65 yBy:-103.4];
    [flipper concat];
    [self.seaLionFlipperImage drawInRect:NSMakeRect(152, 44, 51, 66)
                                fromRect:NSZeroRect
                               operation:NSCompositingOperationSourceOver
                                fraction:1.0
                          respectFlipped:NO
                                   hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  } else if (self.scene == MeritSceneHamsterWheel) {
    // Fit the complete perspective wheel inside the shared 0...170 artwork zone.
    NSRect hamsterRect = NSMakeRect(35, 0, 170, 170);
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
    [hamster translateXBy:129 yBy:56];
    [hamster rotateByDegrees:-2.0 * strikeAmount];
    [hamster scaleXBy:1.0 + .012 * strikeAmount yBy:1.0 - .025 * strikeAmount];
    [hamster translateXBy:-129 yBy:-56];
    [hamster concat];
    [self.hamsterActorImage drawInRect:NSMakeRect(41, 15, 154, 154)
                              fromRect:NSZeroRect
                             operation:NSCompositingOperationSourceOver
                              fraction:1.0
                        respectFlipped:YES
                                 hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  } else {
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *woodfishScale = [NSAffineTransform transform];
    [woodfishScale translateXBy:120 yBy:0];
    [woodfishScale scaleBy:0.88];
    [woodfishScale translateXBy:-120 yBy:0];
    [woodfishScale concat];
    NSRect shadowRect = NSMakeRect(40, 3, 160, 16);
    NSBezierPath *groundShadow = [NSBezierPath bezierPathWithOvalInRect:shadowRect];
    [[NSColor colorWithWhite:0 alpha:0.25] setFill];
    [groundShadow fill];

    [self.woodfishImage drawInRect:NSMakeRect(26, 0, 214, 129)
                          fromRect:NSZeroRect
                         operation:NSCompositingOperationSourceOver
                          fraction:1.0
                    respectFlipped:YES
                             hints:nil];

    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *malletTransform = [NSAffineTransform transform];
    // Keep the round head undistorted and extend only the wooden shaft by 30%.
    // The farther off-screen pivot uses a smaller arc to land on the same apex.
    [malletTransform translateXBy:417 yBy:180];
    [malletTransform rotateByDegrees:3.0 + 2.2 * strikeAmount];
    [malletTransform concat];
    NSSize malletSourceSize = self.malletImage.size;
    NSRect shaftSource = NSMakeRect(108, 0, MAX(1, malletSourceSize.width - 108),
                                    malletSourceSize.height);
    [self.malletImage drawInRect:NSMakeRect(-260, -26, 266, 54)
                        fromRect:shaftSource
                       operation:NSCompositingOperationSourceOver
                        fraction:1.0
                  respectFlipped:YES
                           hints:nil];
    NSRect headSource = NSMakeRect(0, 0, MIN(145, malletSourceSize.width),
                                   malletSourceSize.height);
    [self.malletImage drawInRect:NSMakeRect(-309, -27, 60, 54)
                        fromRect:headSource
                       operation:NSCompositingOperationSourceOver
                        fraction:1.0
                  respectFlipped:YES
                           hints:nil];
    [NSGraphicsContext restoreGraphicsState];
    [NSGraphicsContext restoreGraphicsState];
  }
  [ctx restoreGraphicsState];

  if (!self.previewOnly && striking && phase >= .30 && phase <= .70) {
    [self drawCenteredText:@"+1"
                      rect:NSMakeRect(0, kFeedbackY, kWindowWidth, 30)
                      font:[NSFont monospacedDigitSystemFontOfSize:23
                                                           weight:NSFontWeightBold]
                     color:[NSColor colorWithCalibratedRed:.94 green:.50 blue:.16 alpha:1]];
  }

  // The counter is the product's source of truth and must never be hidden by
  // a scene or one of its moving layers, so it is deliberately drawn last.
  if (!self.previewOnly) {
  NSString *totalText = [NSString stringWithFormat:@"%lld", controller.todayTotal];
  CGFloat totalFont = totalText.length > 18 ? 22 : 26;
  if (totalText.length > 24) totalFont = 18;
  [self drawCenteredText:totalText
                    rect:NSMakeRect(0, kCounterY, kWindowWidth, 40)
                    font:[NSFont monospacedDigitSystemFontOfSize:totalFont
                                                         weight:NSFontWeightRegular]
                   color:[NSColor colorWithCalibratedRed:.78 green:.39 blue:.12 alpha:1]];
  }

  [ctx restoreGraphicsState];
  if (!self.previewOnly && controller.offworkEnabled) {
    NSColor *color = controller.offworkIsOvertime
        ? [NSColor colorWithCalibratedRed:.91 green:.46 blue:.13 alpha:1]
        : [NSColor colorWithCalibratedWhite:.42 alpha:1];
    [self drawCenteredText:controller.offworkDisplayLabel ?: UiText(@"距下班", @"Until off work")
                     rect:NSMakeRect(0, 55, kWindowWidth, 28)
                     font:[NSFont systemFontOfSize:24 weight:NSFontWeightMedium]
                    color:color];
    [self drawCenteredText:controller.offworkDisplayDuration ?: @"--:--:--"
                     rect:NSMakeRect(0, 14, kWindowWidth, 35)
                     font:[NSFont monospacedDigitSystemFontOfSize:24 weight:NSFontWeightRegular]
                    color:color];
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
  const CGFloat left = kCalendarLeft, top = kCalendarTop;
  const CGFloat cellWidth = kCalendarCellWidth, cellHeight = kCalendarCellHeight;
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
    NSString *meritText = [NSString stringWithFormat:@"%llu", value];
    NSString *dateText = [NSString stringWithFormat:@"%02ld", (long)day];
    CGFloat meritSize = meritText.length > 10 ? 10 : (meritText.length > 7 ? 12 : 15);
    [self drawText:meritText
              rect:NSMakeRect(NSMinX(cell) + 2, NSMinY(cell) + 5, NSWidth(cell) - 4, 22)
              size:meritSize color:ink weight:NSFontWeightSemibold];
    [self drawText:dateText
              rect:NSMakeRect(NSMinX(cell) + 2, NSMinY(cell) + 27, NSWidth(cell) - 4, 16)
              size:10 color:muted weight:NSFontWeightMedium];
    NSDictionary *overtime = [self.controller offworkRecordForDay:key];
    if (overtime) {
      NSString *text = [NSString stringWithFormat:@"%@ %@", UiText(@"加班", @"OT"),
          OffworkDurationText([overtime[@"seconds"] longLongValue])];
      [self drawText:text
                rect:NSMakeRect(NSMinX(cell) + 1, NSMinY(cell) + 44, NSWidth(cell) - 2, 14)
                size:9 color:accent weight:NSFontWeightMedium];
    }
  }
}

- (void)mouseDown:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (point.x < kCalendarLeft || point.y < kCalendarTop) return;
  NSInteger column = (NSInteger)((point.x - kCalendarLeft) / kCalendarCellWidth);
  NSInteger row = (NSInteger)((point.y - kCalendarTop) / kCalendarCellHeight);
  if (column > 6 || row > 5) return;
  NSDateComponents *parts = [[NSDateComponents alloc] init];
  parts.year = self.year; parts.month = self.month; parts.day = 1;
  NSDate *firstDate = [NSCalendar.currentCalendar dateFromComponents:parts];
  NSInteger weekday = [NSCalendar.currentCalendar component:NSCalendarUnitWeekday fromDate:firstDate];
  NSInteger day = row * 7 + column - (weekday + 5) % 7 + 1;
  NSRange days = [NSCalendar.currentCalendar rangeOfUnit:NSCalendarUnitDay
      inUnit:NSCalendarUnitMonth forDate:firstDate];
  if (day < 1 || day > (NSInteger)days.length) return;
  [self.controller showCalendarDay:[NSString stringWithFormat:@"%04ld-%02ld-%02ld",
      (long)self.year, (long)self.month, (long)day]];
}

@end

@implementation MeritController

- (void)loadOffworkState {
  id<NMMeritPreferences> defaults = MeritPreferences();
  self.offworkEnabled = [defaults boolForKey:kOffworkEnabled];
  NSInteger hour = [defaults objectForKey:kOffworkHour] ? [defaults integerForKey:kOffworkHour] : 18;
  NSInteger minute = [defaults objectForKey:kOffworkMinute] ? [defaults integerForKey:kOffworkMinute] : 0;
  self.offworkHour = hour >= 0 && hour <= 23 ? hour : 18;
  self.offworkMinute = minute >= 0 && minute <= 59 ? minute : 0;
  NSDictionary *stored = [defaults dictionaryForKey:kOffworkDailySnapshots];
  self.offworkDailySnapshots = stored ? [stored mutableCopy] : [NSMutableDictionary dictionary];
  self.offworkLastFlushUptime = NSProcessInfo.processInfo.systemUptime;
}

- (NSDictionary *)offworkRecordForDay:(NSString *)key {
  id record = self.offworkDailySnapshots[key];
  if (![record isKindOfClass:NSDictionary.class]) return nil;
  id seconds = record[@"seconds"], target = record[@"targetMinutes"], sampled = record[@"sampledAt"];
  if (![seconds isKindOfClass:NSNumber.class] || [seconds longLongValue] <= 0 ||
      ![target isKindOfClass:NSNumber.class] || [target integerValue] < 0 ||
      [target integerValue] >= 1440 || ![sampled isKindOfClass:NSNumber.class] ||
      !std::isfinite([sampled doubleValue])) return nil;
  return record;
}

- (void)flushOffwork:(BOOL)durable {
  if (self.offworkDirty) {
    [MeritPreferences() setObject:[self.offworkDailySnapshots copy] forKey:kOffworkDailySnapshots];
    self.offworkDirty = NO;
  }
  self.offworkLastFlushUptime = NSProcessInfo.processInfo.systemUptime;
  // Best effort at lifecycle boundaries only; normal per-second updates stay in memory.
  if (durable && !gIsolatedAcceptance) [NSUserDefaults.standardUserDefaults synchronize];
}

- (void)updateOffworkWindowLayout {
  if (!self.window || self.offworkLayoutExpanded == self.offworkEnabled) return;
  CGFloat delta = kOffworkRegionHeight * kUiScale * (self.offworkEnabled ? 1 : -1);
  NSRect frame = self.window.frame;
  frame.origin.y -= delta;
  frame.size.height += delta;
  NSScreen *screen = self.window.screen ?: NSScreen.mainScreen;
  if (screen) {
    NSRect visible = screen.visibleFrame;
    frame.origin.x = MAX(NSMinX(visible), MIN(frame.origin.x, NSMaxX(visible) - NSWidth(frame)));
    frame.origin.y = MAX(NSMinY(visible), MIN(frame.origin.y, NSMaxY(visible) - NSHeight(frame)));
  }
  self.offworkLayoutExpanded = self.offworkEnabled;
  [self.window setFrame:frame display:NO];
  [self.view setFrameSize:frame.size];
  [self.view setNeedsDisplay:YES];
}

- (void)refreshOffworkAllowRollover:(BOOL)allowRollover {
  if (!self.offworkEnabled || self.offworkSuspended) return;
  const time_t now = std::time(nullptr);
  const NSTimeInterval uptime = NSProcessInfo.processInfo.systemUptime;
  const auto next = niuma::EvaluateOffwork(now, (int)self.offworkHour, (int)self.offworkMinute);
  if (!next.valid) {
    self.offworkHasSnapshot = NO;
    self.offworkIsOvertime = NO;
    self.offworkDisplayLabel = UiText(@"时间不可用", @"Time unavailable");
    self.offworkDisplayDuration = @"--:--:--";
    [self.view setNeedsDisplay:YES];
    return;
  }
  NSString *key = DateKeyForDate([NSDate dateWithTimeIntervalSince1970:next.sampledAt]);
  BOOL changedDay = self.offworkHasSnapshot && ![key isEqualToString:self.offworkDayKey];
  if (changedDay) {
    double wallGap = std::difftime(next.sampledAt, _offworkSnapshot.sampledAt);
    double uptimeGap = uptime - self.offworkLastSampleUptime;
    // Only adjacent live samples may finalize yesterday. Sleep, unlock, clock changes,
    // long run-loop stalls and missed days must never fabricate a historical day.
    BOOL continuousMidnight = allowRollover && wallGap >= 0 && wallGap <= 5 &&
        uptimeGap >= 0 && uptimeGap <= 5 && std::abs(wallGap - uptimeGap) <= 2 &&
        next.sampledAt >= _offworkSnapshot.nextMidnightAt &&
        std::difftime(next.sampledAt, _offworkSnapshot.nextMidnightAt) <= 5 &&
        _offworkSnapshot.targetMinutes == self.offworkHour * 60 + self.offworkMinute;
    if (continuousMidnight) {
      long long seconds = niuma::OffworkFinalDaySeconds(_offworkSnapshot);
      if (seconds > 0) {
        self.offworkDailySnapshots[self.offworkDayKey] = @{
          @"seconds": @(seconds), @"targetMinutes": @(_offworkSnapshot.targetMinutes),
          @"sampledAt": @(_offworkSnapshot.nextMidnightAt - 1),
          @"targetAt": @(_offworkSnapshot.targetAt)
        };
        self.offworkDirty = YES;
      }
    }
  }
  _offworkSnapshot = next;
  self.offworkHasSnapshot = YES;
  self.offworkDayKey = key;
  self.offworkLastSampleUptime = uptime;
  self.offworkIsOvertime = next.overtime;
  self.offworkDisplayLabel = next.overtime ? UiText(@"已加班", @"Overtime")
                                          : UiText(@"距下班", @"Until off work");
  self.offworkDisplayDuration = OffworkDurationText(next.overtime ? next.overtimeSeconds : next.remainingSeconds);
  if (next.overtime && next.overtimeSeconds > 0) {
    self.offworkDailySnapshots[key] = @{
      @"seconds": @(next.overtimeSeconds), @"targetMinutes": @(next.targetMinutes),
      @"sampledAt": @(next.sampledAt), @"targetAt": @(next.targetAt)
    };
    self.offworkDirty = YES;
  } else if (self.offworkDailySnapshots[key]) {
    // Rewinding the clock or moving today's target forward removes only today's result.
    [self.offworkDailySnapshots removeObjectForKey:key];
    self.offworkDirty = YES;
  }
  self.view.accessibilityLabel = [NSString stringWithFormat:@"%@ %lld, %@ %@",
      UiText(@"今日功德", @"Today's merit"), self.todayTotal,
      self.offworkDisplayLabel, self.offworkDisplayDuration];
  [self.view setNeedsDisplay:YES];
  if (self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
  if (changedDay) [self flushOffwork:YES];
  else if (uptime - self.offworkLastFlushUptime >= 60) [self flushOffwork:NO];
}

- (void)offworkTick:(NSTimer *)timer {
  (void)timer;
  [self refreshOffworkAllowRollover:YES];
}

- (void)startOffworkTimer {
  [self.offworkTimer invalidate];
  self.offworkTimer = nil;
  [self updateOffworkWindowLayout];
  if (!self.offworkEnabled) {
    self.offworkHasSnapshot = NO;
    self.view.accessibilityLabel = nil;
    return;
  }
  [self refreshOffworkAllowRollover:NO];
  NSDate *firstTick = [NSDate dateWithTimeIntervalSince1970:std::floor(NSDate.date.timeIntervalSince1970) + 1];
  self.offworkTimer = [[NSTimer alloc] initWithFireDate:firstTick interval:1
      target:self selector:@selector(offworkTick:) userInfo:nil repeats:YES];
  self.offworkTimer.tolerance = .05;
  [NSRunLoop.mainRunLoop addTimer:self.offworkTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.offworkTimer forMode:NSModalPanelRunLoopMode];
}

- (void)offworkWillSleep:(NSNotification *)notification {
  (void)notification;
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
  self.offworkSuspended = YES;
}

- (void)offworkClockChanged:(NSNotification *)notification {
  (void)notification;
  [NSTimeZone resetSystemTimeZone];
  tzset();
  self.offworkSuspended = NO;
  [self ensureCurrentDay];
  [self refreshOffworkAllowRollover:NO];
  [self flushOffwork:YES];
}

- (void)offworkWillPowerOff:(NSNotification *)notification {
  (void)notification;
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
}

- (void)showOffworkSettings:(id)sender {
  (void)sender;
  if (!self.offworkSettingsWindow) {
    self.offworkSettingsWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 440, 290)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.offworkSettingsWindow.title = UiText(@"下班倒计时", @"Off-work Countdown");
    self.offworkSettingsWindow.releasedWhenClosed = NO;
    self.offworkSettingsWindow.delegate = self;
    if (gIsolatedAcceptance) self.offworkSettingsWindow.restorable = NO;
    NSView *content = self.offworkSettingsWindow.contentView;
    self.offworkEnableControl = [NSButton checkboxWithTitle:UiText(@"启用下班倒计时", @"Enable off-work countdown")
        target:self action:@selector(offworkEnableChanged:)];
    self.offworkEnableControl.frame = NSMakeRect(24, 240, 392, 26);
    [content addSubview:self.offworkEnableControl];
    NSTextField *label = [NSTextField labelWithString:UiText(@"下班时间（24小时制）", @"Off-work time (24-hour)")];
    label.frame = NSMakeRect(24, 196, 214, 24);
    [content addSubview:label];
    self.offworkHourControl = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(244, 192, 70, 28) pullsDown:NO];
    self.offworkMinuteControl = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(336, 192, 70, 28) pullsDown:NO];
    for (NSInteger hour = 0; hour < 24; ++hour)
      [self.offworkHourControl addItemWithTitle:[NSString stringWithFormat:@"%02ld", (long)hour]];
    for (NSInteger minute = 0; minute < 60; ++minute)
      [self.offworkMinuteControl addItemWithTitle:[NSString stringWithFormat:@"%02ld", (long)minute]];
    self.offworkHourControl.accessibilityLabel = UiText(@"下班小时", @"Off-work hour");
    self.offworkMinuteControl.accessibilityLabel = UiText(@"下班分钟", @"Off-work minute");
    [content addSubview:self.offworkHourControl];
    [content addSubview:self.offworkMinuteControl];
    NSTextField *colon = [NSTextField labelWithString:@":"];
    colon.frame = NSMakeRect(319, 197, 12, 22);
    [content addSubview:colon];
    NSTextField *explanation = [NSTextField wrappingLabelWithString:UiText(
        @"每天按本地下班时间重新计算，超过即为加班。开启时自动保存当天加班快照，关闭保留历史。仅本地运行，不需要输入监控权限，不判断实际劳动或离岗时间。",
        @"Recalculates daily using local time. Time past your target is overtime. While enabled, daily snapshots are saved; disabling keeps history. Local only, no Input Monitoring needed. This is not work or attendance detection.")];
    explanation.frame = NSMakeRect(24, 66, 392, 108);
    explanation.font = [NSFont systemFontOfSize:13];
    [content addSubview:explanation];
    NSButton *cancel = [NSButton buttonWithTitle:UiText(@"取消", @"Cancel")
        target:self action:@selector(cancelOffworkSettings:)];
    cancel.frame = NSMakeRect(232, 20, 88, 30);
    cancel.keyEquivalent = @"\033";
    [content addSubview:cancel];
    NSButton *save = [NSButton buttonWithTitle:UiText(@"保存", @"Save")
        target:self action:@selector(saveOffworkSettings:)];
    save.frame = NSMakeRect(328, 20, 88, 30);
    save.keyEquivalent = @"\r";
    [content addSubview:save];
    [self.offworkSettingsWindow center];
  }
  if (!self.offworkSettingsWindow.isVisible) {
    self.offworkEnableControl.state = self.offworkEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    [self.offworkHourControl selectItemAtIndex:self.offworkHour];
    [self.offworkMinuteControl selectItemAtIndex:self.offworkMinute];
    [self offworkEnableChanged:nil];
  }
  [NSApp activateIgnoringOtherApps:YES];
  [self.offworkSettingsWindow makeKeyAndOrderFront:nil];
}

- (void)offworkEnableChanged:(id)sender {
  (void)sender;
  BOOL enabled = self.offworkEnableControl.state == NSControlStateValueOn;
  self.offworkHourControl.enabled = enabled;
  self.offworkMinuteControl.enabled = enabled;
}

- (void)cancelOffworkSettings:(id)sender {
  (void)sender;
  [self.offworkSettingsWindow close];
}

- (void)saveOffworkSettings:(id)sender {
  (void)sender;
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
  self.offworkEnabled = self.offworkEnableControl.state == NSControlStateValueOn;
  self.offworkHour = self.offworkHourControl.indexOfSelectedItem;
  self.offworkMinute = self.offworkMinuteControl.indexOfSelectedItem;
  id<NMMeritPreferences> defaults = MeritPreferences();
  [defaults setBool:self.offworkEnabled forKey:kOffworkEnabled];
  [defaults setInteger:self.offworkHour forKey:kOffworkHour];
  [defaults setInteger:self.offworkMinute forKey:kOffworkMinute];
  [self startOffworkTimer];
  [self flushOffwork:YES];
  [self.calendarView setNeedsDisplay:YES];
  [self.offworkSettingsWindow close];
}

- (void)showCalendarDay:(NSString *)key {
  [self refreshOffworkAllowRollover:YES];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = key;
  NSString *merit = [NSString stringWithFormat:@"%@ %llu", UiText(@"功德", @"Merit"),
      self.dailyTotals[key].unsignedLongLongValue];
  NSDictionary *record = [self offworkRecordForDay:key];
  if (record) {
    NSInteger minutes = [record[@"targetMinutes"] integerValue];
    NSString *updated = [NSDateFormatter localizedStringFromDate:
        [NSDate dateWithTimeIntervalSince1970:[record[@"sampledAt"] doubleValue]]
        dateStyle:NSDateFormatterMediumStyle timeStyle:NSDateFormatterMediumStyle];
    alert.informativeText = [NSString stringWithFormat:UiText(
        @"%@\n加班快照：%@\n当日预定下班：%02ld:%02ld\n最后更新：%@\n\n本地时间快照，不代表实际劳动或离岗时刻。历史日期不随当前设置回算。",
        @"%@\nOvertime snapshot: %@\nOff-work target: %02ld:%02ld\nLast updated: %@\n\nA local time snapshot, not actual work or departure time. Historical dates are not recalculated with current settings."),
        merit, OffworkDurationText([record[@"seconds"] longLongValue]),
        (long)(minutes / 60), (long)(minutes % 60), updated];
  } else {
    alert.informativeText = [NSString stringWithFormat:@"%@\n\n%@", merit,
        UiText(@"没有加班快照，不代表当天准时下班。", @"No overtime snapshot. This does not mean an on-time departure.")];
  }
  [alert addButtonWithTitle:UiText(@"关闭", @"Close")];
  [alert runModal];
}

- (void)loadState {
  id<NMMeritPreferences> defaults = MeritPreferences();
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
  self.selectedScene = MeritSceneWoodfish;
  self.selectedAppearanceId = [defaults stringForKey:kSelectedAppearance];
  if (!self.selectedAppearanceId.length ||
      ([self.selectedAppearanceId hasPrefix:@"builtin."] &&
       ![self.selectedAppearanceId isEqualToString:@"builtin.woodfish"])) {
    self.selectedAppearanceId = @"builtin.woodfish";
  }
}

- (void)saveState {
  if (!self.dirty) return;
  id<NMMeritPreferences> defaults = MeritPreferences();
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
  if (gIsolatedAcceptance) return nil;
  NSURL *libraryURL = [NSFileManager.defaultManager
      URLsForDirectory:NSLibraryDirectory
             inDomains:NSUserDomainMask].firstObject;
  NSURL *launchAgentsURL = [libraryURL URLByAppendingPathComponent:@"LaunchAgents"
                                                       isDirectory:YES];
  NSString *fileName = [kLaunchAgentLabel stringByAppendingString:@".plist"];
  return [launchAgentsURL URLByAppendingPathComponent:fileName];
}

- (BOOL)isLaunchAtLoginEnabled {
  if (gIsolatedAcceptance) return NO;
  id<NMMeritPreferences> defaults = MeritPreferences();
  if (![defaults boolForKey:kLaunchAtLoginEnabled]) return NO;
  return [NSFileManager.defaultManager fileExistsAtPath:self.launchAgentURL.path];
}

- (BOOL)setLaunchAtLoginEnabled:(BOOL)enabled showError:(BOOL)showError {
  if (gIsolatedAcceptance) return NO;
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
    id<NMMeritPreferences> defaults = MeritPreferences();
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
  if (gIsolatedAcceptance) return;
  id<NMMeritPreferences> defaults = MeritPreferences();
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
  if (bundleIdentifier.length > 0 && !gIsolatedAcceptance) {
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
  [self loadOffworkState];
  [self configureLaunchAtLogin];

  self.view = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, kWindowScaleWidth, kWindowScaleHeight)];
  self.view.controller = self;
  self.view.scene = self.selectedScene;
  NSString *restoredAppearanceId = [self.selectedAppearanceId copy];
  [self reloadAppearancePacks];
  BOOL previousAppearanceMissing = restoredAppearanceId.length &&
      ![restoredAppearanceId isEqualToString:@"builtin.woodfish"] &&
      ![self appearancePackWithId:restoredAppearanceId];
  [self applyAppearanceId:self.selectedAppearanceId];
  self.window = [[NSWindow alloc] initWithContentRect:self.view.bounds
                                            styleMask:NSWindowStyleMaskBorderless
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.contentView = self.view;
  self.window.backgroundColor = NSColor.clearColor;
  self.window.opaque = NO;
  self.window.hasShadow = NO;
  self.window.level = NSFloatingWindowLevel;
  // Keep the existing floating-window Space behavior. There is no
  // application-fullscreen detection or automatic hiding preference.
  self.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorFullScreenAuxiliary;
  self.window.movableByWindowBackground = YES;
  BOOL restoredFrame = NO;
  if (gIsolatedAcceptance) {
    self.window.restorable = NO;
  } else {
    [self.window setFrameAutosaveName:@"NiuMaMeritPosition"];
    restoredFrame = [self.window setFrameUsingName:@"NiuMaMeritPosition"];
  }
  if (restoredFrame) {
    NSRect frame = self.window.frame;
    // Saved expanded frames use a lower origin; normalize without launch-to-launch drift.
    frame.origin.y += MAX(0.0, NSHeight(frame) - kWindowScaleHeight);
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
  NSNotificationCenter *workspaceCenter = NSWorkspace.sharedWorkspace.notificationCenter;
  [workspaceCenter addObserver:self selector:@selector(offworkWillSleep:) name:NSWorkspaceWillSleepNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkClockChanged:) name:NSWorkspaceDidWakeNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkClockChanged:) name:NSWorkspaceSessionDidBecomeActiveNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkWillPowerOff:) name:NSWorkspaceWillPowerOffNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:NSSystemClockDidChangeNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:NSSystemTimeZoneDidChangeNotification object:nil];
  [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:@"com.apple.screenIsUnlocked" object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [self startOffworkTimer];
  [self.window orderFrontRegardless];
  if (previousAppearanceMissing || self.appearanceLoadError) {
    NSAlert *notice = [[NSAlert alloc] init];
    notice.alertStyle = NSAlertStyleWarning;
    notice.messageText = UiText(@"部分本地形象未能加载", @"Some Local Packs Are Unavailable");
    notice.informativeText = self.appearanceLoadError.localizedDescription ?: UiText(
        @"上次使用的形象文件缺失或未通过校验，暂时显示木鱼。原文件、功德和日历不删除；可重新导入原包。",
        @"The previous appearance is missing or failed verification. Woodfish is shown for now. Original files, counts and calendar are kept; re-import the pack.");
    [notice runModal];
  }

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
  if (!gIsolatedAcceptance) {
    // Monitor tap health even on a silent autostart or after a failed installation.
    self.permissionPollTimer = [NSTimer timerWithTimeInterval:kPermissionPollInterval * 2
        target:self selector:@selector(checkPermission:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSModalPanelRunLoopMode];
    [self installEventTap];
    if (!self.launchedAutomatically) [self showPermissionIntroIfNeeded];
  }
}

- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)filenames {
  NSMutableSet<NSString *> *previousIds = [NSMutableSet set];
  for (NMAppearancePack *pack in self.installedAppearancePacks)
    [previousIds addObject:pack.identifier];
  NSMutableArray<NMAppearancePack *> *imported = [NSMutableArray array];
  NSMutableArray<NSString *> *failures = [NSMutableArray array];
  BOOL batch = filenames.count > 1;
  for (NSString *filename in filenames) {
    NSURL *source = [NSURL fileURLWithPath:filename];
    NSError *error = nil;
    if (![NSFileManager.defaultManager fileExistsAtPath:filename]) {
      [failures addObject:[NSString stringWithFormat:
          UiText(@"%@：文件已移动或不存在。", @"%@: file moved or missing."), source.lastPathComponent]];
      continue;
    }
    if ([source.pathExtension.lowercaseString isEqualToString:@"nmgpacks"]) {
      batch = YES;
      NSArray<NMAppearancePack *> *packs =
          [NMAppearancePackStore installBatchArchiveAtURL:source error:&error];
      // Failed batches may already contain safely installed, verified members.
      NSArray *partial = error.userInfo[@"NMSuccessfulImports"];
      if (packs) [imported addObjectsFromArray:packs];
      else if ([partial isKindOfClass:NSArray.class]) [imported addObjectsFromArray:partial];
    } else {
      NMAppearancePack *pack = [NMAppearancePackStore installArchiveAtURL:source error:&error];
      if (pack) [imported addObject:pack];
    }
    if (error) [failures addObject:[NSString stringWithFormat:@"%@：%@",
        source.lastPathComponent, error.localizedDescription]];
  }

  const BOOL importsSucceeded = failures.count == 0;
  NSError *loadError = nil;
  self.installedAppearancePacks = [NMAppearancePackStore loadInstalledPacks:&loadError];
  if (loadError) [failures addObject:loadError.localizedDescription];
  NSMutableSet<NSString *> *newIds = [NSMutableSet set];
  NSMutableSet<NSString *> *availableIds = [NSMutableSet set];
  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  for (NMAppearancePack *pack in imported) {
    if (![self appearancePackWithId:pack.identifier]) {
      [failures addObject:[NSString stringWithFormat:
          UiText(@"%@：已保存但未能加载，未启用，原文件保留。",
                 @"%@: saved but unavailable; not enabled; original files kept."), pack.localizedName]];
      continue;
    }
    [availableIds addObject:pack.identifier];
    NSString *kind = nil;
    if (pack.alreadyInstalled) {
      kind = UiText(@"重复包，已保留原形象", @"Duplicate; existing pack kept");
    } else if ([previousIds containsObject:pack.identifier]) {
      kind = UiText(@"已更新", @"Updated");
    } else {
      [newIds addObject:pack.identifier];
      kind = UiText(@"本次新增", @"New in this import");
    }
    [lines addObject:[NSString stringWithFormat:@"%@ · %@", pack.localizedName, kind]];
  }
  self.newlyImportedIds = newIds;
  self.lastImportedIds = availableIds;
  BOOL singleEnabled = !batch && importsSucceeded && availableIds.count == 1;
  if (singleEnabled) {
    [self applyAppearanceId:availableIds.anyObject];
  } else if ([self appearancePackWithId:self.selectedAppearanceId]) {
    // Refresh an updated current pack, but never choose the last batch member.
    [self applyAppearanceId:self.selectedAppearanceId];
  }
  if (self.appearancePickerAlert) {
    self.pendingAppearanceId = self.selectedAppearanceId;
    self.appearancePickerAlert.accessoryView = [self appearanceGrid];
  }
  [application replyToOpenOrPrint:failures.count
      ? NSApplicationDelegateReplyFailure : NSApplicationDelegateReplySuccess];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = failures.count ? NSAlertStyleWarning : NSAlertStyleInformational;
  alert.messageText = singleEnabled
      ? UiText(@"导入完成，已启用此形象", @"Imported and Enabled")
      : failures.count
          ? (availableIds.count ? UiText(@"部分形象已导入", @"Some Packs Imported")
                                : UiText(@"未能导入形象", @"No Packs Imported"))
          : UiText(@"导入完成，当前形象未改变", @"Imported; Current Appearance Unchanged");
  NSString *summary = [NSString stringWithFormat:
      UiText(@"本次可用 %lu 个形象，新增 %lu 个。功德和日历不受影响。",
             @"%lu packs available from this import; %lu new. Counts and calendar are unchanged."),
      (unsigned long)availableIds.count, (unsigned long)newIds.count];
  if (!singleEnabled) summary = [summary stringByAppendingString:
      UiText(@"\n只有确认选择后才会切换形象。", @"\nYour appearance changes only after you confirm a choice.")];
  alert.informativeText = summary;
  NSMutableArray<NSString *> *details = [lines mutableCopy];
  if (failures.count) {
    [details addObject:UiText(@"未完成 / 损坏或校验失败：", @"Not completed / damaged or failed verification:")];
    [details addObjectsFromArray:failures];
    [details addObject:UiText(@"其他正常形象仍可使用；请重新选择原文件或从官网重新下载。",
                             @"Other valid packs remain usable. Select the original file or download it again.")];
  }
  if (details.count) {
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 400, 170)];
    scroll.hasVerticalScroller = YES;
    NSTextView *text = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 380, 170)];
    text.editable = NO;
    text.font = [NSFont systemFontOfSize:13];
    text.string = [details componentsJoinedByString:@"\n"];
    text.textContainer.widthTracksTextView = YES;
    text.autoresizingMask = NSViewWidthSizable;
    scroll.documentView = text;
    alert.accessoryView = scroll;
  }
  [alert addButtonWithTitle:UiText(@"完成", @"Done")];
  if (availableIds.count) [alert addButtonWithTitle:UiText(@"选择形象…", @"Choose Appearance…")];
  if ([alert runModal] == NSAlertSecondButtonReturn) [self showAppearancePicker:nil];
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  [self ensureCurrentDay];
  [self refreshOffworkAllowRollover:NO];
  [self checkPermission:nil];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
  [self.offworkTimer invalidate];
  self.offworkTimer = nil;
  [self saveState];
  [self.dayTimer invalidate];
  [self.countStatusTimer invalidate];
  [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
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
  if (gIsolatedAcceptance || [MeritPreferences() boolForKey:@"basicGuideShown"]) return;
  [self showFirstUseGuide:nil];
  [MeritPreferences() setBool:YES forKey:@"basicGuideShown"];
}

- (void)showFirstUseGuide:(id)sender {
  (void)sender;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = UiText(@"先记住三件事", @"Three Things to Get Started");
  alert.informativeText = UiText(
      @"1. 按住小伙伴拖动，放到喜欢的位置。\n"
       @"2. 右键小伙伴，可以换形象、看日历和退出。\n"
       @"3. 在其他应用中计数需要允许“输入监控”；右键打开“关于”，可查看 Mac 权限帮助。\n\n"
       @"只统计事件次数，不读取按键内容、坐标、当前应用或窗口内容；不联网，数据留在本机。",
      @"1. Drag your companion to move it.\n"
       @"2. Right-click it to change appearance, view the calendar, or quit.\n"
       @"3. Counting in other apps requires Input Monitoring permission. Open About for Mac permissions help.\n\n"
       @"Only event counts are used, never keys, coordinates, apps or window contents. No networking; data stays on this Mac.");
  [alert addButtonWithTitle:UiText(@"知道了", @"Got It")];
  [alert runModal];
}

- (BOOL)hasLiveEventTap {
  return self.eventTap && CFMachPortIsValid(self.eventTap) && CGEventTapIsEnabled(self.eventTap);
}

- (NSString *)countStatusTitle {
  if (![self hasLiveEventTap])
    return UiText(@"仅点击小伙伴计数", @"Pet-click Counting Only");
  if (self.listenerNeedsCheck)
    return UiText(@"待检查：监听与计数结果不一致", @"Check Needed: Counting Mismatch");
  if (!self.globalCountConfirmed)
    return UiText(@"待检查：监听已建立，尚未观察到计数", @"Check Pending: Listener Ready, No Count Observed");
  return UiText(@"全局监听已收到事件并计数", @"Global Events Received and Counted");
}

- (void)countPetClickIfNeeded {
  if (![self hasLiveEventTap]) [self count];
}

- (void)receiveGlobalEvent:(CGEventType)type {
  self.receivedEvents++;
  if (type == kCGEventKeyDown) self.receivedKeys++;
  else if (type == kCGEventScrollWheel) self.receivedScrolls++;
  else self.receivedClicks++;
  const NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  BOOL observing = self.selfCheckActive && now >= self.selfCheckStarts && now < self.selfCheckEnds;
  if (observing) {
    if (type == kCGEventKeyDown) self.selfCheckKeys++;
    else if (type == kCGEventScrollWheel) self.selfCheckScrolls++;
    else self.selfCheckClicks++;
    self.selfCheckLastEvent = now - self.selfCheckStarts;
  }
  const long long before = self.total;
  self.selfCheckCountingEvent = observing;
  if (type == kCGEventScrollWheel) [self countScrollGesture];
  else [self count];
  self.selfCheckCountingEvent = NO;
  if (self.total > before) self.globalCountConfirmed = YES;
}

- (void)showCountStatus:(id)sender {
  (void)sender;
  if (!self.countStatusWindow) {
    self.countStatusWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 580, 490)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.countStatusWindow.title = UiText(@"计数状态与自检", @"Counting Status & Check");
    self.countStatusWindow.releasedWhenClosed = NO;
    self.countStatusWindow.delegate = self;
    self.countStatusWindow.minSize = NSMakeSize(540, 440);
    NSView *content = self.countStatusWindow.contentView;
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(18, 62, 544, 410)];
    scroll.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    scroll.hasVerticalScroller = YES;
    self.countStatusText = [[NSTextView alloc] initWithFrame:scroll.contentView.bounds];
    self.countStatusText.editable = NO;
    self.countStatusText.font = [NSFont systemFontOfSize:14];
    self.countStatusText.textContainerInset = NSMakeSize(6, 8);
    self.countStatusText.textContainer.widthTracksTextView = YES;
    self.countStatusText.autoresizingMask = NSViewWidthSizable;
    scroll.documentView = self.countStatusText;
    [content addSubview:scroll];
    self.selfCheckButton = [NSButton buttonWithTitle:UiText(@"开始 10 秒自检", @"Start 10-second Check")
        target:self action:@selector(startSelfCheck:)];
    self.selfCheckButton.frame = NSMakeRect(18, 18, 174, 32);
    [content addSubview:self.selfCheckButton];
    NSButton *retry = [NSButton buttonWithTitle:UiText(@"检查权限 / 重试监听", @"Permissions / Retry Listener")
        target:self action:@selector(retryListener:)];
    retry.frame = NSMakeRect(202, 18, 226, 32);
    [content addSubview:retry];
    NSButton *close = [NSButton buttonWithTitle:UiText(@"关闭", @"Close")
        target:self action:@selector(closeCountStatus:)];
    close.frame = NSMakeRect(442, 18, 118, 32);
    close.autoresizingMask = NSViewMinXMargin;
    [content addSubview:close];
    [self.countStatusWindow center];
  }
  [self.countStatusWindow makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  if (!self.countStatusTimer) {
    self.countStatusTimer = [NSTimer timerWithTimeInterval:1 target:self
        selector:@selector(refreshCountStatus:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.countStatusTimer forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:self.countStatusTimer forMode:NSModalPanelRunLoopMode];
  }
  [self refreshCountStatus:nil];
}

- (void)startSelfCheck:(id)sender {
  (void)sender;
  if (self.selfCheckActive) return;
  self.selfCheckKeys = self.selfCheckClicks = self.selfCheckScrolls = 0;
  self.selfCheckExpected = self.selfCheckCounted = 0;
  self.selfCheckLastEvent = 0;
  self.selfCheckInterrupted = NO;
  self.selfCheckResult = nil;
  // Exclude the button click and allow a short switch-to-another-app interval.
  self.selfCheckStarts = NSProcessInfo.processInfo.systemUptime + 2;
  self.selfCheckEnds = self.selfCheckStarts + 10;
  self.selfCheckActive = YES;
  [self refreshCountStatus:nil];
}

- (void)retryListener:(id)sender {
  (void)sender;
  if (self.selfCheckActive) {
    self.selfCheckActive = NO;
    self.selfCheckResult = UiText(@"已停止本次自检，重试监听后可重新开始。", @"Check stopped. Start again after retrying the listener.");
  }
  [self removeEventTap];
  self.listenerNeedsCheck = NO;
  [self requestListenPermission];
  [self refreshCountStatus:nil];
}

- (void)closeCountStatus:(id)sender {
  (void)sender;
  [self.countStatusWindow close];
}

- (void)windowWillClose:(NSNotification *)notification {
  // Closing the settings window discards its controls, never commits their values.
  if (notification.object == self.offworkSettingsWindow) return;
  if (notification.object != self.countStatusWindow) return;
  [self.countStatusTimer invalidate];
  self.countStatusTimer = nil;
  if (self.selfCheckActive) {
    self.selfCheckActive = NO;
    self.selfCheckResult = UiText(@"自检已取消，未作故障判断。", @"Check cancelled; no failure inferred.");
  }
}

- (void)refreshCountStatus:(NSTimer *)timer {
  (void)timer;
  if (!self.countStatusWindow) return;
  const NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  if (self.selfCheckActive && now >= self.selfCheckEnds) {
    self.selfCheckActive = NO;
    const NSUInteger events = self.selfCheckKeys + self.selfCheckClicks + self.selfCheckScrolls;
    if (!events) {
      self.globalCountConfirmed = NO;
      self.selfCheckResult = UiText(
          @"未观察到输入，不能判断失败。若你确实在其他应用操作过，请检查权限后重试；否则可直接重新自检。",
          @"No input observed; this is not a failure verdict. If you did use another app, check permissions and retry; otherwise repeat the check.");
    } else if (self.selfCheckInterrupted) {
      self.listenerNeedsCheck = YES;
      self.selfCheckResult = UiText(@"本次监听曾中断，请重试；不把部分记录当作通过。",
                                   @"The listener was interrupted. Repeat the check; partial observations do not count as a pass.");
    } else if (self.selfCheckExpected != self.selfCheckCounted) {
      self.listenerNeedsCheck = YES;
      self.selfCheckResult = UiText(@"收到事件，但计数未完全更新。请重试监听；总数已达上限时也不会继续增加。",
                                   @"Events arrived but counts did not fully update. Retry the listener; counts also stop at the numeric limit.");
    } else if (!self.selfCheckExpected) {
      self.selfCheckResult = UiText(@"只观察到同一段连续滚动，未开始新手势；停一下再试，不判失败。",
                                   @"Only an existing scroll gesture was observed. Pause and retry; no failure inferred.");
    } else {
      self.listenerNeedsCheck = NO;
      self.selfCheckResult = UiText(
          @"本次观察到的输入已计数。未发生的输入类型未判断；请自行确认刚才已切换到其他应用。",
          @"Observed inputs were counted. Unused input types are not assessed; please confirm you switched to another app.");
    }
  }
  self.selfCheckButton.enabled = !self.selfCheckActive;
  NSString *progress = self.selfCheckResult ?: UiText(@"尚未开始自检。", @"No check started.");
  if (self.selfCheckActive) {
    progress = now < self.selfCheckStarts
        ? UiText(@"准备中：请切换到其他应用。2 秒后开始记录。", @"Get ready: switch to another app. Recording starts after 2 seconds.")
        : [NSString stringWithFormat:UiText(@"记录中，还剩 %.0f 秒。", @"Recording: %.0f seconds left."),
              ceil(MAX(0.0, self.selfCheckEnds - now))];
  }
  self.countStatusText.string = [NSString stringWithFormat:
      UiText(@"%@\n\n点击“开始”后切到其他应用，做几次按键、鼠标点击或滚动，10 秒后回来查看。程序不会读取你在哪个应用，请自行确认。\n\n%@\n\n本次收到：按键 %lu 次 / 鼠标按键 %lu 次 / 滚动事件 %lu 次\n按现有规则应增加 %lu，实际增加 %lu。连续滚动按一次手势计数。\n最后事件：开始后 %.1f 秒（无事件时为 0）。\n\n监听句柄或权限开关本身不是成功证据。输入监控未授权、授权身份变化或安全输入都可能影响监听；不绕过系统限制。\n\n自检仅在内存中保留事件次数与相对时间；不读取或保存具体键值、输入内容、坐标、应用或窗口信息。不联网。",
             @"%@\n\nStart, switch to another app and type, click or scroll. Return after 10 seconds. The app does not inspect which app you used; please confirm the switch yourself.\n\n%@\n\nReceived: %lu key events / %lu mouse clicks / %lu scroll events\nExpected count increase: %lu; actual: %lu. Continuous scrolling counts as one gesture.\nLast event: %.1f seconds after start (0 if none).\n\nA handle or permission switch alone is not proof. Missing or changed Input Monitoring permission and secure input may affect listening. No system restrictions are bypassed.\n\nOnly event counts and relative times are kept in memory, never key values, contents, coordinates, apps or windows. No networking."),
      self.countStatusTitle, progress, (unsigned long)self.selfCheckKeys,
      (unsigned long)self.selfCheckClicks, (unsigned long)self.selfCheckScrolls,
      (unsigned long)self.selfCheckExpected, (unsigned long)self.selfCheckCounted,
      self.selfCheckLastEvent];
}

- (void)requestListenPermission {
  if (gIsolatedAcceptance) return;
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
  if (gIsolatedAcceptance) return;
  BOOL allowed = CGPreflightListenEventAccess();
  // Preflight is advisory: creation/enabled state is the actual result.
  // In particular, do not tear down a working tap on a stale preflight answer.
  if (self.eventTap && !CFMachPortIsValid(self.eventTap)) [self removeEventTap];
  if (self.eventTap && !CGEventTapIsEnabled(self.eventTap)) {
    self.globalCountConfirmed = NO;
    if (self.selfCheckActive) self.selfCheckInterrupted = YES;
    CGEventTapEnable(self.eventTap, true);
  }
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
  if (gIsolatedAcceptance) return;
  if (self.eventTap) {
    return;
  }
  self.globalCountConfirmed = NO;
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
  self.globalCountConfirmed = NO;
  if (self.selfCheckActive) self.selfCheckInterrupted = YES;
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
  if (gIsolatedAcceptance) return;
  self.globalCountConfirmed = NO;
  if (self.selfCheckActive) self.selfCheckInterrupted = YES;
  if (self.eventTap && CFMachPortIsValid(self.eventTap)) {
    CGEventTapEnable(self.eventTap, true);
  }
  self.inputMonitoringAuthorized = self.eventTap && CGEventTapIsEnabled(self.eventTap);
}

- (void)count {
  [self ensureCurrentDay];
  if (self.selfCheckCountingEvent) self.selfCheckExpected++;
  if (self.total == LLONG_MAX) return;
  self.total++;
  if (self.selfCheckCountingEvent) self.selfCheckCounted++;
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
  launchAtLogin.enabled = !gIsolatedAcceptance;
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
  NSMenuItem *offwork = [[NSMenuItem alloc]
      initWithTitle:UiText(@"下班倒计时…", @"Off-work Countdown…")
             action:@selector(showOffworkSettings:) keyEquivalent:@""];
  offwork.target = self;
  offwork.state = self.offworkEnabled ? NSControlStateValueOn : NSControlStateValueOff;
  [menu addItem:offwork];
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
    NSRect frame = NSMakeRect(0, 0, 560, 516);
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
    if (gIsolatedAcceptance) self.calendarWindow.restorable = NO;
    [self.calendarWindow center];
  }
  [NSApp activateIgnoringOtherApps:YES];
  [self.calendarWindow makeKeyAndOrderFront:nil];
}

- (void)shiftCalendarMonth:(NSButton *)sender {
  [self.calendarView shiftMonth:sender.tag];
}

- (void)selectAppearance:(NSButton *)sender {
  if (sender.tag < 0 || sender.tag >= (NSInteger)self.appearanceItems.count) return;
  self.pendingAppearanceId = self.appearanceItems[(NSUInteger)sender.tag][@"id"];
  for (NSButton *button in self.appearanceButtons) {
    button.state = button.tag == sender.tag ? NSControlStateValueOn : NSControlStateValueOff;
  }
}

- (void)reloadAppearancePacks {
  NSError *error = nil;
  self.installedAppearancePacks = [NMAppearancePackStore loadInstalledPacks:&error];
  self.appearanceLoadError = error;
  if (error && self.window) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = UiText(@"本地形象加载失败", @"Unable to Load Local Packs");
    alert.informativeText = error.localizedDescription;
    [alert runModal];
  }
}

- (NMAppearancePack *)appearancePackWithId:(NSString *)identifier {
  for (NMAppearancePack *pack in self.installedAppearancePacks) {
    if ([pack.identifier isEqualToString:identifier]) return pack;
  }
  return nil;
}

- (void)applyAppearanceId:(NSString *)identifier {
  NMAppearancePack *pack = [self appearancePackWithId:identifier];
  if (pack) {
    self.view.appearancePack = pack;
    self.selectedAppearanceId = pack.identifier;
  } else {
    self.selectedScene = MeritSceneWoodfish;
    self.view.scene = self.selectedScene;
    self.view.appearancePack = nil;
    self.selectedAppearanceId = @"builtin.woodfish";
    [MeritPreferences() setInteger:self.selectedScene forKey:kSelectedScene];
  }
  [MeritPreferences() setObject:self.selectedAppearanceId forKey:kSelectedAppearance];
  [self.view setNeedsDisplay:YES];
}

- (NSView *)appearanceGrid {
  NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
  [items addObject:@{@"id": @"builtin.woodfish",
                     @"title": UiText(@"默认木鱼", @"Woodfish"),
                     @"scene": @(MeritSceneWoodfish)}];
  for (NMAppearancePack *pack in self.installedAppearancePacks) {
    [items addObject:@{@"id": pack.identifier, @"title": [pack localizedName], @"pack": pack}];
  }
  self.appearanceItems = items;
  NSInteger rows = (items.count + 1) / 2;
  CGFloat gridHeight = rows * 162 - 8;
  NSView *grid = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 324, gridHeight)];
  NSMutableArray *buttons = [NSMutableArray array];
  for (NSInteger i = 0; i < (NSInteger)items.count; ++i) {
    NSDictionary *item = items[(NSUInteger)i];
    NSImage *thumbnail = nil;
    NMAppearancePack *pack = item[@"pack"];
    if (pack) {
      thumbnail = pack.previewImage;
    } else {
      MeritView *preview = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, 120, 125)];
      preview.previewOnly = YES;
      preview.scene = (MeritScene)[item[@"scene"] integerValue];
      NSBitmapImageRep *rep = [preview bitmapImageRepForCachingDisplayInRect:preview.bounds];
      [preview cacheDisplayInRect:preview.bounds toBitmapImageRep:rep];
      thumbnail = [[NSImage alloc] initWithSize:preview.bounds.size];
      [thumbnail addRepresentation:rep];
    }
    NSInteger row = i / 2;
    NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect((i % 2) * 168,
        gridHeight - (row + 1) * 154 - row * 8, 156, 154)];
    NSMutableArray<NSString *> *badges = [NSMutableArray array];
    if ([item[@"id"] isEqualToString:self.selectedAppearanceId])
      [badges addObject:UiText(@"当前", @"Current")];
    if ([self.newlyImportedIds containsObject:item[@"id"]])
      [badges addObject:UiText(@"本次新增", @"New")];
    else if ([self.lastImportedIds containsObject:item[@"id"]])
      [badges addObject:UiText(@"本次导入", @"Imported")];
    button.title = badges.count
        ? [NSString stringWithFormat:@"%@\n%@", item[@"title"], [badges componentsJoinedByString:@" · "]]
        : item[@"title"];
    button.toolTip = button.title;
    button.accessibilityLabel = button.title;
    button.image = thumbnail;
    button.imagePosition = NSImageAbove;
    button.imageScaling = NSImageScaleProportionallyDown;
    button.bezelStyle = NSBezelStyleRegularSquare;
    [button setButtonType:NSButtonTypePushOnPushOff];
    button.tag = i;
    button.target = self;
    button.action = @selector(selectAppearance:);
    button.state = [item[@"id"] isEqualToString:self.pendingAppearanceId]
        ? NSControlStateValueOn : NSControlStateValueOff;
    [grid addSubview:button];
    [buttons addObject:button];
  }
  self.appearanceButtons = buttons;
  NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 324, MIN(478, gridHeight))];
  scroll.documentView = grid;
  scroll.hasVerticalScroller = gridHeight > NSHeight(scroll.bounds);
  scroll.drawsBackground = NO;
  for (NSButton *button in buttons) {
    NSString *identifier = items[(NSUInteger)button.tag][@"id"];
    if ([self.lastImportedIds containsObject:identifier]) {
      [grid scrollRectToVisible:button.frame];
      break;
    }
  }
  return scroll;
}

- (void)showAppearancePicker:(id)sender {
  (void)sender;
  [self reloadAppearancePacks];
  if (self.appearancePickerAlert) {
    self.pendingAppearanceId = self.selectedAppearanceId;
    self.appearancePickerAlert.accessoryView = [self appearanceGrid];
    [self.appearancePickerAlert.window makeKeyAndOrderFront:nil];
    return;
  }
  self.pendingAppearanceId = self.selectedAppearanceId;
  while (YES) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = UiText(@"更换形象", @"Change Appearance");
    alert.informativeText = UiText(@"当前 = 正在显示；本次新增 = 新加入。选择后点确认才会切换。",
                                   @"Current = displayed now; New = newly added. Confirm your selection to switch.");
    alert.accessoryView = [self appearanceGrid];
    [alert addButtonWithTitle:UiText(@"确认", @"Confirm")];
    [alert addButtonWithTitle:UiText(@"取消", @"Cancel")];
    [alert addButtonWithTitle:UiText(@"删除所选本地形象", @"Remove Selected Pack")];
    [alert addButtonWithTitle:UiText(@"去官网查看更多形象", @"See More Appearances Online")];
    self.appearancePickerAlert = alert;
    NSModalResponse response = [alert runModal];
    self.appearancePickerAlert = nil;
    if (response == NSAlertFirstButtonReturn) {
      [self applyAppearanceId:self.pendingAppearanceId];
      [self stopAnimation];
      self.strikeActive = NO;
      [self startStrikeWithDuration:0.800];
      return;
    }
    if (response == NSAlertSecondButtonReturn) return;
    if (response == NSAlertThirdButtonReturn + 1) {
      [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"https://gongde.zqscreen.cn/#characters"]];
      continue;
    }
    NMAppearancePack *pack = [self appearancePackWithId:self.pendingAppearanceId];
    if (!pack) {
      NSBeep();
      continue;
    }
    NSError *error = nil;
    if (![NMAppearancePackStore removePack:pack error:&error]) {
      NSAlert *failure = [[NSAlert alloc] init];
      failure.messageText = UiText(@"无法删除形象包", @"Unable to Remove Appearance Pack");
      failure.informativeText = error.localizedDescription ?: @"";
      [failure runModal];
      continue;
    }
    if ([self.selectedAppearanceId isEqualToString:pack.identifier]) {
      [self applyAppearanceId:@"builtin.woodfish"];
    }
    [self reloadAppearancePacks];
    self.pendingAppearanceId = self.selectedAppearanceId;
  }
}

- (void)showAbout:(id)sender {
  (void)sender;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = UiText(@"牛马电子功德", @"NiuMa Merit");
  NSString *version = NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"?";
  NSString *aboutText = [NSString stringWithFormat:UiText(
      @"版本 %@\n\n"
       @"只统计按键、鼠标按键和滚轮手势发生的次数，不读取具体内容、鼠标位置或窗口信息。\n"
       @"所有数据仅保存在本机，本软件不包含网络请求、遥测或自动更新。\n\n"
       @"在其他应用中计数，需要允许本应用使用“输入监控”。\n"
       @"Mac 权限与计数帮助\n\n"
       @"客户端源代码依 GPLv3 许可证开放。\n\n"
       @"官方网站：\n"
       @"https://gongde.zqscreen.cn/\n\n"
       @"欢迎关注开发者抖音，一起交流产品的奇思妙想\n"
       @"抖音号：1872941388",
      @"Version %@\n\n"
       @"Counts keyboard presses, mouse button presses, and scroll gestures. It does not read "
       @"specific input, mouse positions, or window information.\n"
       @"All data stays on this computer. The app contains no network requests, telemetry, or automatic updates.\n\n"
       @"Counting in other apps requires Input Monitoring permission.\n"
       @"Mac permissions and counting help\n\n"
       @"Client source code is available under GPLv3.\n\n"
       @"Official website:\n"
       @"https://gongde.zqscreen.cn/\n\n"
       @"Follow the developer on Douyin and share creative product ideas\n"
       @"Douyin ID: 1872941388"), version];
  NSString *douyinPath = [NSBundle.mainBundle pathForResource:@"developer-douyin" ofType:@"png"];
  NSImage *douyinImage = douyinPath ? [[NSImage alloc] initWithContentsOfFile:douyinPath] : nil;
  NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
  NSRect visibleFrame = screen ? screen.visibleFrame : NSMakeRect(0, 0, 800, 600);
  CGFloat scrollerWidth = [NSScroller scrollerWidthForControlSize:NSControlSizeRegular
                                                  scrollerStyle:NSScrollerStyleLegacy];
  CGFloat contentWidth = MAX(240.0, MIN(340.0, NSWidth(visibleFrame) - 64.0 - scrollerWidth));
  NSFont *bodyFont = [NSFont systemFontOfSize:NSFont.systemFontSize];
  NSMutableAttributedString *bodyText = [[NSMutableAttributedString alloc] initWithString:aboutText
      attributes:@{NSFontAttributeName: bodyFont, NSForegroundColorAttributeName: NSColor.labelColor}];
  NSRange helpRange = [aboutText rangeOfString:UiText(@"Mac 权限与计数帮助",
      @"Mac permissions and counting help")];
  if (helpRange.location != NSNotFound) {
    [bodyText addAttributes:@{
        NSLinkAttributeName: @"https://gongde.zqscreen.cn/help-macos.html",
        NSForegroundColorAttributeName: NSColor.linkColor,
        NSUnderlineStyleAttributeName: @(NSUnderlineStyleSingle)} range:helpRange];
  }
  NSRange promoRange = [aboutText rangeOfString:UiText(
      @"欢迎关注开发者抖音，一起交流产品的奇思妙想",
      @"Follow the developer on Douyin and share creative product ideas")];
  if (promoRange.location != NSNotFound) {
    NSMutableParagraphStyle *promoStyle = [[NSMutableParagraphStyle alloc] init];
    promoStyle.alignment = NSTextAlignmentCenter;
    [bodyText addAttribute:NSParagraphStyleAttributeName value:promoStyle
        range:NSMakeRange(promoRange.location, aboutText.length - promoRange.location)];
  }
  CGFloat textHeight = ceil([bodyText boundingRectWithSize:NSMakeSize(contentWidth, CGFLOAT_MAX)
      options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading].size.height) + 4.0;
  CGFloat contentHeight = textHeight + 16.0 + (douyinImage ? 276.0 : 0.0);
  NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, contentWidth, contentHeight)];
  NSTextField *body = [[NSTextField alloc] initWithFrame:
      NSMakeRect(0, contentHeight - 8.0 - textHeight, contentWidth, textHeight)];
  body.editable = NO;
  body.selectable = YES;
  body.allowsEditingTextAttributes = YES;
  body.bordered = NO;
  body.drawsBackground = NO;
  body.usesSingleLineMode = NO;
  body.cell.wraps = YES;
  body.cell.scrollable = NO;
  body.lineBreakMode = NSLineBreakByWordWrapping;
  body.attributedStringValue = bodyText;
  [content addSubview:body];
  if (douyinImage) {
    NSImageView *code = [[NSImageView alloc] initWithFrame:
        NSMakeRect((contentWidth - 240.0) / 2.0, 8, 240, 260)];
    code.image = douyinImage;
    code.imageScaling = NSImageScaleProportionallyUpOrDown;
    code.imageAlignment = NSImageAlignCenter;
    code.toolTip = UiText(@"使用抖音扫一扫，关注开发者", @"Scan with Douyin to find the developer");
    code.accessibilityLabel = UiText(@"开发者抖音码，抖音号 1872941388",
                                     @"Developer Douyin code, ID 1872941388");
    [content addSubview:code];
  }
  NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:
      NSMakeRect(0, 0, contentWidth + scrollerWidth, MIN(contentHeight, 120.0))];
  scroll.borderType = NSNoBorder;
  scroll.drawsBackground = NO;
  scroll.hasVerticalScroller = YES;
  scroll.hasHorizontalScroller = NO;
  scroll.autohidesScrollers = NO;
  scroll.scrollerStyle = NSScrollerStyleLegacy;
  scroll.documentView = content;
  scroll.accessibilityLabel = UiText(@"关于牛马电子功德", @"About NiuMa Merit");
  alert.informativeText = @"";
  alert.accessoryView = scroll;
  [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
  // Keep the native alert buttons outside the scroll area, reserving their actual layout height.
  [alert layout];
  CGFloat chromeHeight = NSHeight(alert.window.frame) - NSHeight(scroll.frame);
  CGFloat availableHeight = MAX(1.0, NSHeight(visibleFrame) - 40.0 - chromeHeight);
  [scroll setFrameSize:NSMakeSize(NSWidth(scroll.frame), MIN(contentHeight, availableHeight))];
  [alert layout];
  [content scrollPoint:NSMakePoint(0, MAX(0.0, contentHeight - scroll.contentSize.height))];
  [alert runModal];
}

@end

static CGEventRef EventTapCallback(CGEventTapProxy proxy,
                                   CGEventType type,
                                   CGEventRef event,
                                   void *context) {
  (void)proxy;
  (void)event;
  if (gIsolatedAcceptance) return event;
  MeritController *controller = (__bridge MeritController *)context;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    [controller handleEventTapDisabled];
  } else if (type == kCGEventScrollWheel || type == kCGEventKeyDown ||
             type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown ||
             type == kCGEventOtherMouseDown) {
    [controller receiveGlobalEvent:type];
  }
  return event;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (!InitializeAcceptanceContext(argc, argv)) {
      fprintf(stderr, "isolated_acceptance_configuration_invalid\n");
      return 2;
    }
    NSApplication *app = NSApplication.sharedApplication;
    MeritController *controller = [[MeritController alloc] init];
    app.delegate = controller;
    [app run];
  }
  return 0;
}
