#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreServices/CoreServices.h>
#import <mach/mach_time.h>
#import "login_startup.h"
#include "fullscreen_detection.h"
#import "appearance_pack.mm"
#import "layer_scene.mm"
#import "thumbnail_grid.mm"
#include "../offwork_clock.h"
#include "../calendar_month_range.h"
#include "../client/core/visibility_state.h"
#include "../reminder_activity.h"
#include "../reminder_geometry.h"
#include "../reminder_policy.h"
#include "../reminder_status.h"
#include "../reminder_store.h"
#include "../reminder_catalog_store.h"
#include "../reminder_catalog_trust.h"

#include <algorithm>
#include <cmath>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_set>
#import "input_runtime.mm"
#import "ui_theme.h"
#import "installation_paths.h"

// Explicit acceptance launches never consult the user's product preferences.
// The pack root must be an empty, private directory supplied by the runner;
// invalid or incomplete isolation settings fail before NSApplication starts.
static BOOL gIsolatedAcceptance = NO;
static BOOL gAcceptancePhysicalInput = NO;
static NSArray<NSString *> *gAcceptancePackPaths;
static BOOL gReminderPreviewAcceptance = NO;
static NSString *gAcceptanceRootPath;
static int gSingleInstanceLockFd = -1;

static std::uint64_t ReminderContinuousTimeMs(void) {
  static const mach_timebase_info_data_t timebase = [] {
    mach_timebase_info_data_t value{};
    mach_timebase_info(&value);
    return value;
  }();
  if (timebase.denom == 0) return 0;
  const long double nanoseconds = static_cast<long double>(mach_continuous_time()) *
      timebase.numer / timebase.denom;
  return static_cast<std::uint64_t>(nanoseconds / 1'000'000.0L);
}

static BOOL AcquireSingleInstanceLock(void) {
  NSString *bundleIdentifier = NSBundle.mainBundle.bundleIdentifier;
  if (bundleIdentifier.length > 0 && !gIsolatedAcceptance) {
    for (NSRunningApplication *application in
         [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleIdentifier]) {
      if (application.processIdentifier != getpid()) return NO;
    }
  }

  char path[PATH_MAX];
  const char *privateRoot=getenv("NIUMA_ACCEPTANCE_ROOT");
  const int length=gIsolatedAcceptance
      ? snprintf(path,sizeof(path),"%s/instance.lock",privateRoot)
      : snprintf(path,sizeof(path),"/tmp/niuma-merit-client-%u.lock",(unsigned)geteuid());
  if (length <= 0 || (size_t)length >= sizeof(path)) return NO;

  const int fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return NO;
  struct stat attributes;
  if (fstat(fd, &attributes) != 0 || !S_ISREG(attributes.st_mode) ||
      attributes.st_uid != geteuid() || attributes.st_nlink != 1 ||
      (attributes.st_mode & 0777) != 0600 || flock(fd, LOCK_EX | LOCK_NB) != 0) {
    close(fd);
    return NO;
  }
  gSingleInstanceLockFd = fd;
  return YES;
}

@protocol NMMeritPreferences <NMLoginStartupPreferences>
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
  BOOL reminderPreview = NO;
  BOOL physicalInput=NO;
  NSMutableArray<NSString *> *packs=[NSMutableArray array];
  for (int index = 1; index < argc; ++index) {
    if (strcmp(argv[index], "--isolated-acceptance") == 0) requested = YES;
    if (strcmp(argv[index], "--reminder-ui-preview") == 0) reminderPreview = YES;
    if (strcmp(argv[index], "--physical-input-acceptance") == 0) physicalInput=YES;
    if (strcmp(argv[index], "--acceptance-pack") == 0) {
      if(index+1>=argc) return NO;
      NSString *path=[NSString stringWithUTF8String:argv[++index]];
      if(!path.isAbsolutePath || ![path.pathExtension.lowercaseString isEqual:@"nmgpack"]) return NO;
      [packs addObject:path];
    }
  }
  const char *rootValue = getenv("NIUMA_ACCEPTANCE_ROOT");
  if (!requested && !rootValue && !reminderPreview && !physicalInput && !packs.count) return YES;
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
  gAcceptancePhysicalInput=physicalInput;gAcceptancePackPaths=[packs copy];
  gReminderPreviewAcceptance = reminderPreview;
  gAcceptanceRootPath = [root copy];
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
static constexpr CGFloat kCalendarLeft = 24.0;
static constexpr CGFloat kCalendarTop = 218.0;
static constexpr CGFloat kCalendarCellWidth = 96.0;
static constexpr CGFloat kCalendarCellHeight = 64.0;
static constexpr CGFloat kArtworkTop = 170.0;
static constexpr CGFloat kFeedbackY = 174.0;
static constexpr CGFloat kCounterY = 210.0;
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

static NMUiAlert *NMPermissionIntroAlert(NSString *applicationName) {
  NMUiAlert *alert = [[NMUiAlert alloc] init];
  alert.messageText = UiText(@"还差一步：开启输入监控", @"One more step: allow Input Monitoring");
  alert.informativeText = [NSString stringWithFormat:UiText(
      @"1. 点击下方按钮，打开系统的“输入监控”设置。\n\n2. 为“%@”打开开关。列表中没有时，点“＋”，从“应用程序”中选择它。\n\n3. 按系统提示退出，再重新打开牛马。\n\n只统计操作次数，不读取输入内容。",
      @"1. Click below to open Input Monitoring in System Settings.\n\n2. Enable “%@”. If it is missing, click + and select it in Applications.\n\n3. Quit when macOS asks, then reopen NiuMa.\n\nOnly operation counts are used; typed content is never read."), applicationName];
  [alert addButtonWithTitle:UiText(@"去开启输入监控", @"Open Input Monitoring")];
  [alert addButtonWithTitle:UiText(@"稍后", @"Later")];
  return alert;
}

static NSString *OffworkDurationText(long long seconds) {
  return [NSString stringWithUTF8String:niuma::OffworkDuration(seconds).c_str()];
}

// Persisted record keys and the calendar grid share the local Gregorian date
// axis, regardless of the user's preferred display calendar.
static NSCalendar *RecordCalendar() {
  NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  calendar.timeZone = NSTimeZone.localTimeZone;
  return calendar;
}

static NSString *DateKeyForDate(NSDate *date) {
  static NSDateFormatter *formatter;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
    formatter.calendar = RecordCalendar();
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
@property(nonatomic, strong) NMLayerScene *renderer;
@property(nonatomic, copy) NSString *renderedIdentity;
@property(nonatomic) NSInteger renderedScene;
@property(nonatomic) BOOL presentationPending;
@property(nonatomic) NSTimeInterval pendingAnimationDuration;
@property(nonatomic) CFTimeInterval pendingAnimationStart;
- (void)requestAnimation:(NSTimeInterval)duration atTime:(CFTimeInterval)start;
- (void)syncPresentation;
- (NSArray<NSDictionary *> *)sceneDescriptors;
- (NSDictionary<NSString *, NSImage *> *)sceneImages;
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
  niuma::client::core::VisibilityState _visibility;
  NMSynchronizedActivity _reminderActivity;
  niuma::reminder::WallClockGuard _reminderClockGuard;
  bool _reminderStorageFault;
  std::unique_ptr<niuma::reminder::ReminderStore> _reminderStore;
  std::unique_ptr<niuma::reminder::CatalogUpdateStore> _catalogStore;
  std::shared_ptr<niuma::reminder::ValidatedCatalog> _reminderCatalog;
  bool _reminderCatalogCommitUncertain;
}
@property(nonatomic) BOOL readyForOpenedFiles;
@property(nonatomic, strong) NSMutableArray<NSString *> *pendingOpenFiles;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSStatusItem *visibilityStatusItem;
@property(nonatomic) BOOL appearanceHidden;
@property(nonatomic) BOOL displaySuspended;
@property(nonatomic) BOOL screenLocked;
@property(nonatomic) BOOL systemSleeping;
@property(nonatomic, strong) MeritView *view;
@property(nonatomic, strong) NSTimer *animationTimer;
@property(nonatomic, strong) NSTimer *permissionPollTimer;
@property(nonatomic, strong) NSTimer *saveTimer;
@property(nonatomic, strong) NSTimer *dayTimer;
@property(nonatomic, strong) NSTimer *reminderTimer;
@property(nonatomic, strong) NSPanel *reminderPanel;
@property(nonatomic, strong) NSTimer *reminderDismissTimer;
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
@property(nonatomic, strong) NMEventTapThread *inputThread;
@property(nonatomic, strong) NMInputMailbox *inputMailbox;
@property(nonatomic, strong) dispatch_source_t inputNotification;
- (void)prepareInputDelivery;
- (void)captureInputType:(CGEventType)type;
- (void)drainInput;

@property(nonatomic) CFRunLoopSourceRef eventSource;
@property(nonatomic) BOOL eventTapOperationInProgress;
@property(nonatomic) BOOL eventTapRecoveryStopped;
@property(nonatomic) BOOL eventTapDisabledPending;
@property(nonatomic) BOOL eventTapStopping;
@property(nonatomic) NSUInteger eventTapRecoveryAttempts;
@property(nonatomic) NSTimeInterval eventTapNextAttempt;
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
@property(nonatomic) BOOL resourceLoadBusy;
@property(nonatomic) NSUInteger resourceGeneration;
@property(nonatomic, strong) NMAppearancePack *pendingScenePack;
@property(nonatomic, weak) NMThumbnailGrid *thumbnailGrid;
@property(nonatomic, strong) dispatch_source_t memoryPressure;
- (void)discardRebuildableResources;
- (void)pumpSceneLoad;

@property(nonatomic, strong) NMLoginStartupCoordinator *loginStartup;
@property(nonatomic, strong) NSError *loginStartupError;
- (BOOL)hasLiveEventTap;
- (NSString *)countStatusTitle;
- (void)receiveGlobalEvent:(CGEventType)type;
- (void)receiveReminderKeyUp;
- (void)reminderWillPause:(NSNotification *)notification;
- (void)reminderDidResume:(NSNotification *)notification;
- (void)reminderObservationInterrupted:(NSNotification *)notification;
- (void)evaluateReminderActivity:(NSTimer *)timer;
- (void)presentReminderForTrigger:(niuma::reminder::ActivitySampler::Trigger)trigger;
- (void)positionReminderPanel:(NSPanel *)panel;
- (void)reminderScreensDidChange:(NSNotification *)notification;
- (void)dismissReminder:(id)sender;
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
- (NSMenu *)contextMenu;
- (void)refreshAppearanceVisibility:(id)sender;
- (void)applyAppearanceVisibility;
- (void)toggleAppearanceVisibility:(id)sender;
- (void)toggleAutoHideFullscreen:(id)sender;
- (void)showStatusMenu:(id)sender;

- (void)startStrikeWithDuration:(NSTimeInterval)duration;
- (void)animate:(NSTimer *)timer;
- (void)showPermissionIntroIfNeeded;
- (void)requestListenPermission;
- (void)installEventTap;
- (void)createEventTapOnce;
- (void)removeEventTap;
- (void)handleEventTapDisabled:(CGEventType)type;
- (void)showAbout:(id)sender;
- (void)showAppearancePicker:(id)sender;
- (BOOL)importOfficialMessagesAtPath:(NSString *)filename;
- (void)showMeritCalendar:(id)sender;
- (void)shiftCalendarMonth:(NSButton *)sender;
- (void)ensureCurrentDay;
- (void)checkPermission:(NSTimer *)timer;
- (void)stopPermissionPoll;
- (void)configureLaunchAtLogin;
- (NMLoginStartupState)loginStartupState;
- (void)showLoginStartupApproval;
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
@synthesize appearancePack=_appearancePack;
- (void)setAppearancePack:(NMAppearancePack *)pack {
  if(_appearancePack==pack) return;
  _appearancePack=pack;self.renderedIdentity=nil;
  // Even a switch while hidden releases the old scene's retained CGImages.
  [self.renderer installLayers:@[] images:@{}];
}

- (instancetype)initWithFrame:(NSRect)frameRect {
  self = [super initWithFrame:frameRect];
  if (self) {
    self.wantsLayer = YES;
    self.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
    self.renderer = [[NMLayerScene alloc] initWithRoot:self.layer];
    self.renderedScene = -1;
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
  NSColor *glow = [NSColor colorWithCalibratedWhite:0 alpha:.8];
  NSMutableParagraphStyle *center = [[NSMutableParagraphStyle alloc] init];
  center.alignment = NSTextAlignmentCenter;
  NSShadow *shadow = [[NSShadow alloc] init];
  shadow.shadowColor = glow;
  shadow.shadowOffset = NSMakeSize(0, -1);
  shadow.shadowBlurRadius = 2;
  NSDictionary *attributes = @{
    NSFontAttributeName: font,
    NSForegroundColorAttributeName: color,
    NSParagraphStyleAttributeName: center,
    NSStrokeColorAttributeName: [NSColor colorWithCalibratedWhite:0 alpha:.7],
    NSStrokeWidthAttributeName: @(-2.5),
    NSShadowAttributeName: shadow
  };
  [text drawInRect:rect withAttributes:attributes];
}

- (void)setNeedsDisplay:(BOOL)flag {
  if (!flag || self.presentationPending) return;
  self.presentationPending=YES;
  __weak MeritView *weakSelf=self;
  dispatch_async(dispatch_get_main_queue(), ^{ MeritView *view=weakSelf; view.presentationPending=NO; [view syncPresentation]; });
}
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self syncPresentation]; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self syncPresentation]; }
- (NSDictionary<NSString *,NSImage *> *)sceneImages {
  if (self.appearancePack) return self.appearancePack.images;
  if (self.scene==MeritSceneLuckyCat) return @{@"base":self.luckyCatBaseImage,@"actor":self.luckyCatActorImage};
  if (self.scene==MeritSceneSeaLionBellyPat) return @{@"base":self.seaLionBodyImage,@"actor":self.seaLionFlipperImage};
  if (self.scene==MeritSceneHamsterWheel) return @{@"base":self.hamsterBaseImage ?: [NSImage new],@"actor":self.hamsterActorImage ?: [NSImage new]};
  NSImage *shadow=[[NSImage alloc] initWithSize:NSMakeSize(160,16)];
  [shadow lockFocus]; [[NSColor colorWithWhite:0 alpha:.25] setFill];
  [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(0,0,160,16)] fill]; [shadow unlockFocus];
  return @{@"woodfish":self.woodfishImage ?: [NSImage new],@"mallet":self.malletImage ?: [NSImage new],@"shadow":shadow};
}
- (NSArray<NSDictionary *> *)sceneDescriptors {
  if (self.appearancePack) return self.appearancePack.layers;
  NSDictionary *(^frame)(double,double,double,double,double)=^(double t,double x,double y,double r,double scale) {
    return @{@"t":@(t),@"x":@(x),@"y":@(y),@"rotation":@(r),@"scale":@(scale),@"scale_y":@1,@"alpha":@1};
  };
  NSDictionary *(^layer)(NSString *,NSArray *,NSArray *,NSArray *)=^(NSString *name,NSArray *rect,NSArray *anchor,NSArray *frames) {
    return @{@"image":name,@"frame":rect,@"anchor":anchor,@"keyframes":frames,@"interpolation":@"smoothstep"};
  };
  NSArray *still=@[frame(0,0,0,0,1)];
  if (self.scene==MeritSceneLuckyCat) {
    NSMutableDictionary *peak=[frame(.42,0,0,0,1) mutableCopy]; peak[@"scale_y"]=@.8;
    return @[layer(@"base",@[@5,@-35,@230,@230],@[@0,@0],still),
      layer(@"actor",@[@30,@-35,@230,@230],@[@(362.0/600),@(112.0/600)],
            @[frame(0,0,0,0,1),peak,frame(1,0,0,0,1)])];
  }
  if (self.scene==MeritSceneSeaLionBellyPat) return @[layer(@"base",@[@34,@0,@172,@168],@[@0,@0],still),
    layer(@"actor",@[@152,@44,@51,@66],@[@.15,@.9],@[frame(0,0,0,0,1),frame(.42,-3,-2,-48,1),frame(1,0,0,0,1)])];
  if (self.scene==MeritSceneHamsterWheel) {
    NSMutableDictionary *peak=[frame(.42,0,0,-2,1.012) mutableCopy]; peak[@"scale_y"]=@(.975/1.012);
    return @[layer(@"base",@[@35,@0,@170,@170],@[@0,@0],still),
      layer(@"actor",@[@41,@15,@154,@154],@[@(88.0/154),@(41.0/154)],@[frame(0,0,0,0,1),peak,frame(1,0,0,0,1)])];
  }
  // The two mallet slices preserve the undistorted head and extended shaft.
  double sw=MAX(145,self.malletImage.size.width);
  NSMutableDictionary *shaft=[layer(@"mallet",@[@(120+.88*(417-260-120)),@(.88*(180-26)),@(.88*266),@(.88*54)],
      @[@(260.0/266),@(26.0/54)],@[frame(0,0,0,3,1),frame(.42,0,0,5.2,1),frame(1,0,0,3,1)]) mutableCopy];
  // Both slices rotate around the same off-screen pivot, expressed in each slice's coordinates.
  shaft[@"anchor"]=@[@(260.0/266),@(26.0/54)];
  shaft[@"contentsRect"]=@[@(108/sw),@0,@((sw-108)/sw),@1];
  NSMutableDictionary *head=[layer(@"mallet",@[@(120+.88*(417-309-120)),@(.88*(180-27)),@(.88*60),@(.88*54)],
      @[@(309.0/60),@.5],@[frame(0,0,0,3,1),frame(.42,0,0,5.2,1),frame(1,0,0,3,1)]) mutableCopy];
  head[@"contentsRect"]=@[@0,@0,@(145/sw),@1];
  return @[layer(@"shadow",@[@(120+.88*(40-120)),@(.88*3),@(.88*160),@(.88*16)],@[@0,@0],still),
    layer(@"woodfish",@[@(120+.88*(26-120)),@0,@(.88*214),@(.88*129)],@[@0,@0],still),shaft,head];
}
- (void)requestAnimation:(NSTimeInterval)duration atTime:(CFTimeInterval)start {
  self.pendingAnimationDuration=duration;self.pendingAnimationStart=start;[self setNeedsDisplay:YES];
}
- (void)syncPresentation {
  if (!self.renderer || (!self.previewOnly && self.controller.appearanceHidden)) return;
  [CATransaction begin];[CATransaction setDisableActions:YES];
  NSString *identity=self.appearancePack ? [NSString stringWithFormat:@"%@:%@",self.appearancePack.identifier,self.appearancePack.contentFingerprint]
                                       : [NSString stringWithFormat:@"builtin:%ld",(long)self.scene];
  if (![self.renderedIdentity isEqual:identity]) {
    [self.renderer installLayers:[self sceneDescriptors] images:[self sceneImages]];
    self.renderedIdentity=identity; self.renderedScene=self.scene;
  }
  CGFloat offset=(!self.previewOnly && self.controller.offworkEnabled) ? kOffworkRegionHeight : 0;
  [self.renderer layoutWithScale:kUiScale backing:self.window.backingScaleFactor ?: 2 offset:offset preview:self.previewOnly];
  [self.renderer setCounter:[NSString stringWithFormat:@"%lld",self.controller.todayTotal]
                      label:self.controller.offworkDisplayLabel duration:self.controller.offworkDisplayDuration];
  if(self.pendingAnimationDuration>0) {
    if(CACurrentMediaTime()-self.pendingAnimationStart<self.pendingAnimationDuration)
      [self.renderer play:self.pendingAnimationDuration atTime:self.pendingAnimationStart];
    self.pendingAnimationDuration=0;
  }
  [CATransaction commit];
}

#if defined(NIUMA_MAC_REFERENCE_RENDERER)
- (void)drawReferenceRect:(NSRect)dirtyRect {
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
  NSTimeInterval now = CACurrentMediaTime();
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
                   color:NMUiMeritGold()];
  }

  [ctx restoreGraphicsState];
  if (!self.previewOnly && controller.offworkEnabled) {
    NSColor *color = NMUiMeritGold();
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

#endif

@end

@interface MeritCalendarView : NSView {
  niuma::CalendarMonthRange _monthRange;
}
@property(nonatomic, strong) NSButton *previousButton;
@property(nonatomic, strong) NSButton *nextButton;
@property(nonatomic, weak) MeritController *controller;
@property(nonatomic) NSInteger year;
@property(nonatomic) NSInteger month;
@property(nonatomic) NSInteger selectedDay;
@property(nonatomic, copy) NSArray<NSButton *> *dayButtons;
- (NSString *)selectedKey;
- (void)goToday:(id)sender;
- (void)showCurrentMonth;
- (void)shiftMonth:(NSInteger)delta;
- (void)reloadMonthRange;
- (void)refreshNavigation;
@end

#import "calendar_view.mm"

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
  if (!self.appearanceHidden) [self.view setNeedsDisplay:YES];
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
  _reminderActivity.BeginSuspend(ReminderContinuousTimeMs());
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
  self.offworkSuspended = YES;
  self.systemSleeping=YES; self.displaySuspended=YES; [self applyAppearanceVisibility];
}

- (void)offworkClockChanged:(NSNotification *)notification {
  (void)notification;
  [NSTimeZone resetSystemTimeZone];
  tzset();
  [self.inputMailbox invalidateDate];
  self.offworkSuspended = NO;
  if([notification.name isEqual:NSWorkspaceDidWakeNotification]) self.systemSleeping=NO;
  if([notification.name isEqual:@"com.apple.screenIsUnlocked"] || [notification.name isEqual:NSWorkspaceSessionDidBecomeActiveNotification]) self.screenLocked=NO;
  self.displaySuspended=self.screenLocked || self.systemSleeping; [self refreshAppearanceVisibility:nil];
  [self ensureCurrentDay];
  [self refreshOffworkAllowRollover:NO];
  [self flushOffwork:YES];
}

- (void)reminderWillPause:(NSNotification *)notification {
  (void)notification;
  self.screenLocked=YES; self.displaySuspended=YES; [self applyAppearanceVisibility];
  _reminderActivity.BeginSuspend(ReminderContinuousTimeMs());
}

- (void)reminderDidResume:(NSNotification *)notification {
  (void)notification;
  self.displaySuspended=self.screenLocked || self.systemSleeping; [self refreshAppearanceVisibility:nil];
  const std::uint64_t nowMs = ReminderContinuousTimeMs();
  const bool paired = _reminderActivity.suspended();
  const std::uint64_t startMs = _reminderActivity.suspend_started_ms();
  const bool trusted = paired && nowMs >= startMs;
  const std::uint64_t duration = trusted ? nowMs - startMs : 0;
  const bool wasConsumed = _reminderActivity.segment_consumed();
  _reminderActivity.ResumeFromSuspend(nowMs, paired, trusted, duration);
  if (wasConsumed && !_reminderActivity.segment_consumed()) {
    const auto result = _reminderStore
        ? _reminderStore->SetSegmentConsumed(false,
            static_cast<std::int64_t>(NSDate.date.timeIntervalSince1970))
        : niuma::reminder::StoreResult::IoError;
    if (result != niuma::reminder::StoreResult::Success) {
      _reminderStorageFault = true;
      _reminderActivity.RestoreSegmentConsumed(true);
    } else {
      _reminderStorageFault = false;
    }
  }
}

- (void)reminderObservationInterrupted:(NSNotification *)notification {
  if ([notification.name isEqualToString:NSSystemClockDidChangeNotification]) {
    const auto nowUtc = static_cast<std::int64_t>(NSDate.date.timeIntervalSince1970);
    const auto nowMs = ReminderContinuousTimeMs();
    const auto transition = _reminderClockGuard.NotifyClockChange(nowUtc, nowMs);
    if (transition == niuma::reminder::WallClockGuard::Transition::Guarded && _reminderStore) {
      NSString *dateText = DateKeyForDate(NSDate.date);
      if (_reminderStore->SetClockGuard(true, nowUtc, dateText.UTF8String) !=
          niuma::reminder::StoreResult::Success) _reminderStorageFault = true;
    }
  }
  if (_reminderActivity.suspended()) return;
  const bool wasConsumed = _reminderActivity.segment_consumed();
  _reminderActivity.ResumeFromSuspend(ReminderContinuousTimeMs(), false, false, 0);
  if (wasConsumed) _reminderActivity.RestoreSegmentConsumed(true);
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
    NMUiWindow(self.offworkSettingsWindow);
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
  if (self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
  [self.offworkSettingsWindow close];
}

- (void)showCalendarDay:(NSString *)key {
  [self refreshOffworkAllowRollover:YES];
  NSAlert *alert = [[NMUiAlert alloc] init];
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
  [self drainInput];
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
  if (!self.appearanceHidden) [self.view setNeedsDisplay:YES];
  if (self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
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
  if (@available(macOS 13.0, *)) {
    return [self loginStartupState] == NMLoginStartupEnabled;
  }
  id<NMMeritPreferences> defaults = MeritPreferences();
  if (![defaults boolForKey:kLaunchAtLoginEnabled]) return NO;
  return [NSFileManager.defaultManager fileExistsAtPath:self.launchAgentURL.path];
}

- (NMLoginStartupCoordinator *)modernLoginStartup {
  if (@available(macOS 13.0, *)) {
    if (!self.loginStartup) {
      self.loginStartup = [[NMLoginStartupCoordinator alloc] init];
      self.loginStartup.service = [[NMMainAppLoginService alloc] init];
      self.loginStartup.preferences = MeritPreferences();
      NSURL *legacyURL = self.launchAgentURL;
      self.loginStartup.retireLegacy = ^BOOL(NSError **error) {
        return NMRetireLegacyStartup(legacyURL, error);
      };
    }
    return self.loginStartup;
  }
  return nil;
}

- (NMLoginStartupState)loginStartupState {
  if (gIsolatedAcceptance) return NMLoginStartupDisabled;
  if (@available(macOS 13.0, *)) return self.modernLoginStartup.service.state;
  return self.isLaunchAtLoginEnabled ? NMLoginStartupEnabled : NMLoginStartupDisabled;
}

- (BOOL)canConfigureModernLoginStartup:(BOOL)showError {
  NSURL *running = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath.URLByStandardizingPath;
  NSURL *persistent = NMPersistentApplicationURL(NSBundle.mainBundle,
      NSProcessInfo.processInfo.arguments);
  NSString *parent = running.path.stringByDeletingLastPathComponent;
  BOOL installed = [parent isEqualToString:@"/Applications"] ||
      [parent isEqualToString:[NSHomeDirectory() stringByAppendingPathComponent:@"Applications"]];
  if (installed && [running.path isEqualToString:persistent.path] &&
      !NMIsTemporaryApplicationURL(running)) return YES;
  if (showError) {
    NSAlert *alert = [[NMUiAlert alloc] init];
    alert.messageText = UiText(@"请从应用程序中打开", @"Open the Installed App");
    alert.informativeText = UiText(@"请完成安装，再从“应用程序”打开牛马后设置登录启动。",
        @"Finish installation, then open NiuMa Merit from Applications to configure login startup.");
    [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
    [alert runModal];
  }
  return NO;
}

- (void)showLoginStartupApproval {
  if (@available(macOS 13.0, *)) {
    NSAlert *alert = [[NMUiAlert alloc] init];
    alert.messageText = UiText(@"登录启动尚未获允许", @"Login Startup Needs Approval");
    alert.informativeText = UiText(@"请在系统设置的“登录项”中允许牛马。也可以在这里关闭登录启动。",
        @"Allow NiuMa Merit in System Settings > Login Items. You can also turn login startup off here.");
    [alert addButtonWithTitle:UiText(@"打开系统设置", @"Open System Settings")];
    [alert addButtonWithTitle:UiText(@"关闭自启动", @"Turn Off Login Startup")];
    [alert addButtonWithTitle:UiText(@"取消", @"Cancel")];
    NSModalResponse response = [alert runModal];
    if (response == NSAlertFirstButtonReturn) [SMAppService openSystemSettingsLoginItems];
    else if (response == NSAlertSecondButtonReturn)
      [self setLaunchAtLoginEnabled:NO showError:YES];
  }
}

- (BOOL)setLaunchAtLoginEnabled:(BOOL)enabled showError:(BOOL)showError {
  if (gIsolatedAcceptance) return NO;
  if (@available(macOS 13.0, *)) {
    if (![self canConfigureModernLoginStartup:showError]) return NO;
    NSError *failure = nil;
    BOOL succeeded = [self.modernLoginStartup setEnabled:enabled error:&failure];
    self.loginStartupError = failure;
    if (!succeeded && showError) {
      NSAlert *alert = [[NMUiAlert alloc] init];
      alert.messageText = UiText(@"无法修改登录启动项", @"Unable to Change Login Startup");
      alert.informativeText = UiText(
          @"系统未能完成登录启动设置或旧启动项迁移，请稍后重试。原有功德、形象和日历不受影响。",
          @"The system could not finish configuring login startup or migrating the old item. Try again later. Your merit, appearances and calendar are unchanged.");
      [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
      [alert runModal];
    } else if (succeeded && enabled && showError &&
        [self loginStartupState] == NMLoginStartupRequiresApproval) {
      [self showLoginStartupApproval];
    }
    return succeeded;
  }
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
      NSURL *persistent = NMPersistentApplicationURL(NSBundle.mainBundle,
          NSProcessInfo.processInfo.arguments);
      if (!persistent) {
        if (showError) {
          NSAlert *alert = [[NMUiAlert alloc] init];
          alert.messageText = UiText(@"请先完成安装", @"Complete installation first");
          alert.informativeText = UiText(@"请将牛马安装到“应用程序”后再开启登录启动。",
              @"Install NiuMa Merit in Applications before enabling login startup.");
          [alert addButtonWithTitle:UiText(@"知道了", @"OK")];
          [alert runModal];
        }
        return NO;
      }
      NSString *bundlePath = persistent.path;
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
    NSAlert *alert = [[NMUiAlert alloc] init];
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
  // A diagnostic candidate must not rewrite the installed login item's path.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"--listener-acceptance"]) return;
  if (@available(macOS 13.0, *)) {
    if (![self canConfigureModernLoginStartup:NO]) return;
    BOOL legacyDenied = [NSFileManager.defaultManager fileExistsAtPath:self.launchAgentURL.path] &&
        [SMAppService statusForLegacyURL:self.launchAgentURL] == SMAppServiceStatusRequiresApproval;
    NSError *failure = nil;
    [self.modernLoginStartup configureRespectingLegacyDenial:legacyDenied error:&failure];
    self.loginStartupError = failure;
    return;
  }
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
  // SMAppService launches the main app without the legacy --autostart argument.
  NSAppleEventDescriptor *launchEvent = NSAppleEventManager.sharedAppleEventManager.currentAppleEvent;
  if (launchEvent.eventClass == kCoreEventClass && launchEvent.eventID == kAEOpenApplication &&
      [launchEvent paramDescriptorForKeyword:keyAEPropData].enumCodeValue == keyAELaunchedAsLogInItem)
    self.launchedAutomatically = YES;
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
  if (!gIsolatedAcceptance || gAcceptanceRootPath.length) {
    NSString *support = gIsolatedAcceptance ? gAcceptanceRootPath :
        NSSearchPathForDirectoriesInDomains(
            NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    if (support.length > 0) {
      NSString *reminderPath = [[support stringByAppendingPathComponent:@"NiuMaMerit"]
          stringByAppendingPathComponent:@"Reminders"];
      _reminderStore = std::make_unique<niuma::reminder::ReminderStore>(
          std::filesystem::path(reminderPath.fileSystemRepresentation));
      _catalogStore = std::make_unique<niuma::reminder::CatalogUpdateStore>(
          std::filesystem::path(reminderPath.fileSystemRepresentation) / "Catalog");
      _reminderCatalog = _catalogStore->Load(
          niuma::reminder::OfficialCatalogSignatureVerifier(), nullptr,
          &_reminderCatalogCommitUncertain);
      _reminderActivity.RestoreSegmentConsumed(_reminderStore->SegmentConsumed());
    }
  }
  const std::int64_t reminderStartupUtc =
      static_cast<std::int64_t>(NSDate.date.timeIntervalSince1970);
  const std::uint64_t reminderStartupMonotonic = ReminderContinuousTimeMs();
  const char *reminderStartupDate = DateKeyForDate(NSDate.date).UTF8String;
  _reminderClockGuard.Start(reminderStartupUtc, reminderStartupMonotonic,
      _reminderStore && _reminderStore->ClockGuard(reminderStartupUtc,
          reminderStartupDate ? reminderStartupDate : ""));
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
  self.window.releasedWhenClosed = NO;
  self.window.contentView = self.view;
  self.window.backgroundColor = NSColor.clearColor;
  self.window.opaque = NO;
  self.window.hasShadow = NO;
  self.window.level = NSFloatingWindowLevel;
  // Preserve Space behavior; the display policy can hide without stopping input.
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
  id<NMMeritPreferences> visibilityDefaults = MeritPreferences();
  _visibility.autoHideFullscreen = [visibilityDefaults objectForKey:@"AutoHideFullscreen"] == nil ||
      [visibilityDefaults boolForKey:@"AutoHideFullscreen"];
  self.visibilityStatusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
  if (self.visibilityStatusItem.button) {
    self.visibilityStatusItem.button.title = gIsolatedAcceptance ? @"测" : @"功";
    self.visibilityStatusItem.button.toolTip = UiText(@"牛马电子功德 · 显示或隐藏形象", @"NiuMa Merit · Show or hide appearance");
    self.visibilityStatusItem.button.target = self;
    self.visibilityStatusItem.button.action = @selector(showStatusMenu:);
    [self.visibilityStatusItem.button sendActionOn:NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp];
    _visibility.recoveryAvailable = true;
  }
  NSNotificationCenter *workspaceCenter = NSWorkspace.sharedWorkspace.notificationCenter;
  [workspaceCenter addObserver:self selector:@selector(refreshAppearanceVisibility:)
      name:NSWorkspaceActiveSpaceDidChangeNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(refreshAppearanceVisibility:)
      name:NSWorkspaceDidActivateApplicationNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkWillSleep:) name:NSWorkspaceWillSleepNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkClockChanged:) name:NSWorkspaceDidWakeNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(reminderDidResume:) name:NSWorkspaceDidWakeNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkClockChanged:) name:NSWorkspaceSessionDidBecomeActiveNotification object:nil];
  [workspaceCenter addObserver:self selector:@selector(offworkWillPowerOff:) name:NSWorkspaceWillPowerOffNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self
      selector:@selector(reminderScreensDidChange:)
      name:NSApplicationDidChangeScreenParametersNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self
      selector:@selector(reminderScreensDidChange:)
      name:NSWindowDidMoveNotification object:self.window];
  [NSNotificationCenter.defaultCenter addObserver:self
      selector:@selector(reminderScreensDidChange:)
      name:NSWindowDidResizeNotification object:self.window];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:NSSystemClockDidChangeNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(reminderObservationInterrupted:)
      name:NSSystemClockDidChangeNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:NSSystemTimeZoneDidChangeNotification object:nil];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(reminderObservationInterrupted:)
      name:NSSystemTimeZoneDidChangeNotification object:nil];
  [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(reminderWillPause:)
      name:@"com.apple.screenIsLocked" object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(offworkClockChanged:)
      name:@"com.apple.screenIsUnlocked" object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(reminderDidResume:)
      name:@"com.apple.screenIsUnlocked" object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
  [self startOffworkTimer];
  [self.window orderFrontRegardless];
  [self refreshAppearanceVisibility:nil];
  if (previousAppearanceMissing || self.appearanceLoadError) {
    NSAlert *notice = [[NMUiAlert alloc] init];
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
  self.reminderTimer = [NSTimer scheduledTimerWithTimeInterval:1
      target:self selector:@selector(evaluateReminderActivity:) userInfo:nil repeats:YES];
  [NSRunLoop.mainRunLoop addTimer:self.reminderTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.reminderTimer forMode:NSModalPanelRunLoopMode];
  if (!gIsolatedAcceptance || gAcceptancePhysicalInput) {
    // Monitor tap health even on a silent autostart or after a failed installation.
    self.permissionPollTimer = [NSTimer timerWithTimeInterval:kPermissionPollInterval * 2
        target:self selector:@selector(checkPermission:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSRunLoopCommonModes];
    [NSRunLoop.mainRunLoop addTimer:self.permissionPollTimer forMode:NSModalPanelRunLoopMode];
    [self installEventTap];
    [self performSelector:@selector(showPermissionIntroIfNeeded) withObject:nil afterDelay:.7];
  }
  if (gReminderPreviewAcceptance) {
    [self presentReminderForTrigger:niuma::reminder::ActivitySampler::Trigger::HighIntensity];
    // Keep the preview process bounded on CI; this path is available only when
    // the explicit isolated-acceptance flags and an empty private temp root pass.
    [NSApp performSelector:@selector(terminate:) withObject:nil
        afterDelay:niuma::reminder::kReminderDisplayMilliseconds / 1000.0 + 4.0];
  }
  self.memoryPressure=dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE,0,
      DISPATCH_MEMORYPRESSURE_WARN|DISPATCH_MEMORYPRESSURE_CRITICAL,dispatch_get_main_queue());
  __weak MeritController *memoryOwner=self;
  dispatch_source_set_event_handler(self.memoryPressure,^{ [memoryOwner discardRebuildableResources]; });
  dispatch_resume(self.memoryPressure);
  self.readyForOpenedFiles = YES;
  if(gIsolatedAcceptance && gAcceptancePackPaths.count) {
    __weak MeritController *acceptanceOwner=self;
    dispatch_async(dispatch_get_main_queue(),^{
      [acceptanceOwner application:NSApp openFiles:gAcceptancePackPaths];
    });
  }
  NSArray<NSString *> *pending = [self.pendingOpenFiles copy];
  self.pendingOpenFiles = nil;
  if (pending.count) [self application:NSApp openFiles:pending];
}

- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)filenames {
  // Finder can deliver a document before launch has initialized the stores.
  if (!self.readyForOpenedFiles) {
    if (!self.pendingOpenFiles) self.pendingOpenFiles = [NSMutableArray array];
    [self.pendingOpenFiles addObjectsFromArray:filenames];
    return;
  }
  BOOL handledCatalog = NO, catalogsSucceeded = YES;
  NSMutableArray<NSString *> *archives = [NSMutableArray array];
  for (NSString *filename in filenames) {
    NSString *extension = filename.pathExtension.lowercaseString;
    if ([extension isEqualToString:@"nmgtext"]) {
      handledCatalog = YES;
      if (![self importOfficialMessagesAtPath:filename]) catalogsSucceeded = NO;
      continue;
    }
    if ([extension isEqualToString:@"nmgpack"] ||
        [extension isEqualToString:@"nmgpacks"]) [archives addObject:filename];
  }
  if (archives.count == 0) {
    [application replyToOpenOrPrint:handledCatalog && catalogsSucceeded
        ? NSApplicationDelegateReplySuccess : NSApplicationDelegateReplyFailure];
    return;
  }
  filenames = archives;
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
  self.installedAppearancePacks = [NMAppearancePackStore loadInstalledMetadata:&loadError];
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
  [application replyToOpenOrPrint:failures.count || !catalogsSucceeded
      ? NSApplicationDelegateReplyFailure : NSApplicationDelegateReplySuccess];
  NSAlert *alert = [[NMUiAlert alloc] init];
  alert.alertStyle = failures.count ? NSAlertStyleWarning : NSAlertStyleInformational;
  alert.messageText = singleEnabled
      ? UiText(@"导入完成，正在准备形象", @"Imported; Preparing Appearance")
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
  else summary=[summary stringByAppendingString:UiText(@"\n准备完成后会显示新形象；准备失败会保留原形象并提示。",@"\nThe new appearance will show when ready. If preparation fails, the previous one is kept and an error is shown.")];
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

- (void)discardRebuildableResources { [self.thumbnailGrid discardCache]; }

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  self.eventTapStopping = YES;
  ++self.resourceGeneration; self.pendingScenePack=nil;
  if(self.memoryPressure) dispatch_source_cancel(self.memoryPressure);self.memoryPressure=nil;
  [self stopAnimation];
  if (self.visibilityStatusItem) [NSStatusBar.systemStatusBar removeStatusItem:self.visibilityStatusItem];
  self.visibilityStatusItem = nil;
  [self stopPermissionPoll];
  [self removeEventTap];
  [self refreshOffworkAllowRollover:YES];
  [self flushOffwork:YES];
  [self.offworkTimer invalidate];
  self.offworkTimer = nil;
  [self saveState];
  [self.saveTimer invalidate]; self.saveTimer=nil;
  [self.dayTimer invalidate];
  [self.reminderTimer invalidate];
  self.reminderTimer = nil;
  [self.countStatusTimer invalidate];
  [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
}

- (void)startStrikeWithDuration:(NSTimeInterval)duration {
  if (self.eventTapStopping || _visibility.hidden() || self.displaySuspended || self.strikeActive) return;
  self.strikeActive = YES;
  self.strikeStartTime = CACurrentMediaTime();
  self.activeStrikeDuration = duration;
  [self.view requestAnimation:duration atTime:self.strikeStartTime];
  self.animationTimer = [NSTimer timerWithTimeInterval:duration target:self
      selector:@selector(animate:) userInfo:nil repeats:NO];
  [NSRunLoop.mainRunLoop addTimer:self.animationTimer forMode:NSRunLoopCommonModes];
  [NSRunLoop.mainRunLoop addTimer:self.animationTimer forMode:NSModalPanelRunLoopMode];
}

- (void)showPermissionIntroIfNeeded {
  if (gIsolatedAcceptance || [self hasLiveEventTap]) return;
  NMUiAlert *alert = NMPermissionIntroAlert(
      NSBundle.mainBundle.bundleURL.lastPathComponent.stringByDeletingPathExtension);
  const NSModalResponse response = [alert runModal];
  if (response == NSAlertFirstButtonReturn) [self requestListenPermission];
}

- (void)showFirstUseGuide:(id)sender {
  (void)sender;
  NSAlert *alert = [[NMUiAlert alloc] init];
  alert.messageText = UiText(@"先记住三件事", @"Three Things to Get Started");
  alert.informativeText = UiText(
      @"1. 按住小伙伴拖动，放到喜欢的位置。\n"
       @"2. 右键小伙伴，可以换形象、看日历和退出。\n"
       @"3. 在其他应用中计数需要允许“输入监控”；右键打开“关于”，可查看 Mac 权限帮助。\n\n"
       @"只记录操作次数，不读取输入内容。全屏隐身仅判断窗口是否覆盖屏幕，不保存应用或窗口信息；数据留在本机。",
      @"1. Drag your companion to move it.\n"
       @"2. Right-click it to change appearance, view the calendar, or quit.\n"
       @"3. Counting in other apps requires Input Monitoring permission. Open About for Mac permissions help.\n\n"
       @"Only operation counts are recorded; typed content is never read. Fullscreen hiding checks window coverage without saving app or window information. Data stays on this Mac.");
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
  [self drainInput];
  if (![self hasLiveEventTap]) [self count];
}

- (void)prepareInputDelivery {
    self.inputMailbox=[[NMInputMailbox alloc] initWithTotal:self.total];
    self.inputNotification=dispatch_source_create(DISPATCH_SOURCE_TYPE_DATA_ADD,0,0,dispatch_get_main_queue());
    __weak MeritController *weakSelf=self;
    dispatch_source_set_event_handler(self.inputNotification, ^{ [weakSelf drainInput]; });
    dispatch_resume(self.inputNotification);
}
- (void)captureInputType:(CGEventType)type {
  NMInputMailbox *mailbox=self.inputMailbox;
  if (!mailbox) return;
  if (type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput) {
    [mailbox disabled:type];
  } else if (type==kCGEventKeyUp) {
    _reminderActivity.Observe(niuma::reminder::ActivitySampler::Event::KeyUp,ReminderContinuousTimeMs());
    return;
  } else {
    auto event=type==kCGEventKeyDown ? niuma::reminder::ActivitySampler::Event::KeyDown :
      type==kCGEventScrollWheel ? niuma::reminder::ActivitySampler::Event::ScrollPulse : niuma::reminder::ActivitySampler::Event::Click;
    _reminderActivity.Observe(event,ReminderContinuousTimeMs());
    [mailbox record:type wall:std::time(nullptr) uptime:NSProcessInfo.processInfo.systemUptime];
  }
  dispatch_source_t notification=self.inputNotification;
  if(notification) dispatch_source_merge_data(notification,1);
}
- (void)drainInput {
  if(!self.inputMailbox) return;
  NSDictionary *snapshot=[self.inputMailbox take];
  NSDictionary *days=snapshot[@"days"]; long long added=0;
  for(NSString *key in days) {
    long long count=[days[key] longLongValue]; added+=count;
    long long old=[self.dailyTotals[key] longLongValue];
    self.dailyTotals[key]=@(count>LLONG_MAX-old ? LLONG_MAX : old+count);
  }
  self.receivedEvents+=[snapshot[@"events"] unsignedIntegerValue];
  self.receivedKeys+=[snapshot[@"keys"] unsignedIntegerValue];
  self.receivedClicks+=[snapshot[@"clicks"] unsignedIntegerValue];
  self.receivedScrolls+=[snapshot[@"scrolls"] unsignedIntegerValue];
  self.selfCheckKeys+=[snapshot[@"checkKeys"] unsignedIntegerValue];
  self.selfCheckClicks+=[snapshot[@"checkClicks"] unsignedIntegerValue];
  self.selfCheckScrolls+=[snapshot[@"checkScrolls"] unsignedIntegerValue];
  NSUInteger checked=[snapshot[@"checkCounted"] unsignedIntegerValue];
  self.selfCheckExpected+=[snapshot[@"checkExpected"] unsignedIntegerValue];self.selfCheckCounted+=checked;
  if([snapshot[@"checkKeys"] unsignedIntegerValue]+[snapshot[@"checkClicks"] unsignedIntegerValue]+[snapshot[@"checkScrolls"] unsignedIntegerValue]) self.selfCheckLastEvent=[snapshot[@"checkLast"] doubleValue];
  if(added) {
    self.total=added>LLONG_MAX-self.total ? LLONG_MAX : self.total+added;
    self.currentDayKey=DateKeyForDate(NSDate.date);self.todayTotal=[self.dailyTotals[self.currentDayKey] longLongValue];
    self.dirty=YES;self.globalCountConfirmed=YES;
    self.smoothedInputInterval=[snapshot[@"interval"] doubleValue];self.lastInputTime=[snapshot[@"lastCount"] doubleValue];
    [self startStrikeWithDuration:std::clamp(self.smoothedInputInterval*1.05,kMinStrikeDuration,kMaxStrikeDuration)];
    if(!self.appearanceHidden) [self.view setNeedsDisplay:YES];
    if(self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
  }
  CGEventType disabled=(CGEventType)[snapshot[@"disabled"] unsignedIntValue];
  if(disabled) [self handleEventTapDisabled:disabled];
}

- (void)receiveGlobalEvent:(CGEventType)type {
  const std::uint64_t reminderNowMs = ReminderContinuousTimeMs();
  if (type == kCGEventKeyDown)
    _reminderActivity.Observe(niuma::reminder::ActivitySampler::Event::KeyDown, reminderNowMs);
  else if (type == kCGEventScrollWheel)
    _reminderActivity.Observe(niuma::reminder::ActivitySampler::Event::ScrollPulse, reminderNowMs);
  else
    _reminderActivity.Observe(niuma::reminder::ActivitySampler::Event::Click, reminderNowMs);
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

- (void)receiveReminderKeyUp {
  const std::uint64_t nowMs = ReminderContinuousTimeMs();
  _reminderActivity.Observe(niuma::reminder::ActivitySampler::Event::KeyUp, nowMs);
}

- (void)evaluateReminderActivity:(NSTimer *)timer {
  (void)timer;
  [self refreshAppearanceVisibility:nil];
  const std::uint64_t nowMs = ReminderContinuousTimeMs();
  const std::int64_t nowUtc = static_cast<std::int64_t>(NSDate.date.timeIntervalSince1970);
  const auto clockTransition = _reminderClockGuard.Observe(nowUtc, nowMs);
  if (clockTransition == niuma::reminder::WallClockGuard::Transition::Guarded) {
    if (_reminderStore) {
      NSString *dateText = DateKeyForDate(NSDate.date);
      if (_reminderStore->SetClockGuard(true, nowUtc, dateText.UTF8String) !=
          niuma::reminder::StoreResult::Success) _reminderStorageFault = true;
    }
    _reminderActivity.ResetForListenerRestart();
  } else if (clockTransition == niuma::reminder::WallClockGuard::Transition::Recovered) {
    const auto result = _reminderStore
        ? _reminderStore->SetClockGuard(false, nowUtc,
            DateKeyForDate(NSDate.date).UTF8String)
        : niuma::reminder::StoreResult::Success;
    if (result != niuma::reminder::StoreResult::Success) {
      _reminderStorageFault = true;
      _reminderClockGuard.RestoreGuard();
    } else {
      _reminderStorageFault = false;
    }
  }
  const BOOL listenerHealthy = [self hasLiveEventTap] && !_reminderClockGuard.guarded();
  const bool wasConsumed = _reminderActivity.segment_consumed();
  const auto trigger = _reminderActivity.Evaluate(nowMs, listenerHealthy);
  const bool isConsumed = _reminderActivity.segment_consumed();
  if (wasConsumed && !isConsumed) {
    const auto result = _reminderStore
        ? _reminderStore->SetSegmentConsumed(false, nowUtc)
        : niuma::reminder::StoreResult::IoError;
    if (result != niuma::reminder::StoreResult::Success) {
      _reminderStorageFault = true;
      _reminderActivity.RestoreSegmentConsumed(true);
    } else {
      _reminderStorageFault = false;
    }
  }
  if (trigger != niuma::reminder::ActivitySampler::Trigger::None)
    [self presentReminderForTrigger:trigger];
}

- (void)presentReminderForTrigger:(niuma::reminder::ActivitySampler::Trigger)trigger {
  if (_visibility.hidden() || !_reminderStore || self.reminderPanel ||
      (gIsolatedAcceptance && !gReminderPreviewAcceptance)) return;
  const std::int64_t nowUtc = static_cast<std::int64_t>(NSDate.date.timeIntervalSince1970);
  if (_reminderStore->SetSegmentConsumed(true, nowUtc) !=
      niuma::reminder::StoreResult::Success) {
    _reminderStorageFault = true;
    return;
  }

  NSDate *now = NSDate.date;
  NSCalendar *calendar = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  calendar.timeZone = NSTimeZone.localTimeZone;
  NSDateComponents *components = [calendar components:(NSCalendarUnitYear | NSCalendarUnitMonth |
      NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute) fromDate:now];
  niuma::reminder::SelectionContext context;
  context.locale = IsChineseUI() ? niuma::reminder::Locale::Chinese : niuma::reminder::Locale::English;
  NSString *country = NSLocale.currentLocale.countryCode.uppercaseString ?: @"";
  static NSSet<NSString *> *supportedRegions;
  static dispatch_once_t regionOnce;
  dispatch_once(&regionOnce, ^{ supportedRegions = [NSSet setWithArray:@[@"US", @"GB", @"CA", @"AU", @"NZ", @"IE"]]; });
  context.region = [supportedRegions containsObject:country] ? country.UTF8String : "*";
  context.trigger = trigger == niuma::reminder::ActivitySampler::Trigger::HighIntensity ? 2U : 1U;
  context.overtime = self.offworkEnabled && !self.offworkSuspended && self.offworkHasSnapshot
      ? (self.offworkIsOvertime ? niuma::reminder::Overtime::Yes : niuma::reminder::Overtime::No)
      : niuma::reminder::Overtime::Unknown;
  context.year = static_cast<int>(components.year);
  context.month = static_cast<int>(components.month);
  context.day = static_cast<int>(components.day);
  context.minute_of_day = static_cast<int>(components.hour * 60 + components.minute);
  NSString *dateText = DateKeyForDate(now);
  const char *dateUtf8 = dateText.UTF8String;
  const std::string localDate = dateUtf8 ? dateUtf8 : "";
  std::unordered_set<std::string> recentIds;
  bool warmUsedToday = false;
  if (!_reminderStore->ReadSelectionHistory(localDate.c_str(), nowUtc, &recentIds, &warmUsedToday)) {
    if (!_reminderClockGuard.guarded() &&
        !_reminderStore->ClockGuard(nowUtc, localDate.c_str()))
      _reminderStorageFault = true;
    return;
  }
  const niuma::reminder::CatalogView catalogView = _reminderCatalog
      ? _reminderCatalog->view() : niuma::reminder::kBuiltinCatalogView;
  const auto candidates = niuma::reminder::EligibleItems(context,
      [&recentIds](const char *id) { return recentIds.find(id) != recentIds.end(); },
      catalogView);
  const niuma::reminder::CatalogItem *item = niuma::reminder::SelectItem(candidates,
      warmUsedToday, [](std::size_t upper) {
        return static_cast<std::size_t>(arc4random_uniform(static_cast<uint32_t>(upper)));
      });
  if (item == nullptr) return;

  NSString *message = [NSString stringWithUTF8String:item->text];
  if (message.length == 0) return;
  NSScreen *screen = self.window.screen ?: NSScreen.mainScreen;
  if (!screen) return;
  const CGFloat width = 260;
  NSFont *font = [NSFont systemFontOfSize:15 weight:NSFontWeightMedium];
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.minimumLineHeight = 22; paragraph.maximumLineHeight = 22;
  NSDictionary *attributes = @{NSFontAttributeName: font,
      NSForegroundColorAttributeName:NMUiInk(), NSParagraphStyleAttributeName:paragraph};
  NSRect textBounds = [message boundingRectWithSize:NSMakeSize(width - 60, CGFLOAT_MAX)
      options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
      attributes:attributes];
  const CGFloat height = std::max(64.0, std::ceil(NSHeight(textBounds)) + 40.0);
  NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
      styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
      backing:NSBackingStoreBuffered defer:NO];
  if (!panel) return;
  panel.releasedWhenClosed = NO;
  panel.level = NSFloatingWindowLevel;
  panel.hidesOnDeactivate = NO;
  panel.becomesKeyOnlyIfNeeded = YES;
  panel.hasShadow = YES;
  panel.backgroundColor = NSColor.clearColor;
  panel.opaque = NO;
  panel.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorTransient;
  NMUiBubbleView *content = [[NMUiBubbleView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  panel.contentView = content;
  NSTextField *label = [NSTextField wrappingLabelWithString:message];
  label.attributedStringValue = [[NSAttributedString alloc] initWithString:message attributes:attributes];
  label.frame = NSMakeRect(20, 20, width - 60, height - 40);
  label.font = font;
  label.maximumNumberOfLines = 0;
  label.lineBreakMode = NSLineBreakByWordWrapping;
  [content addSubview:label];
  NSButton *close = [NSButton buttonWithTitle:@"×" target:self action:@selector(dismissReminder:)];
  close.frame = NSMakeRect(width - 36, height - 36, 24, 24);
  close.bordered = NO;
  close.font = [NSFont systemFontOfSize:16 weight:NSFontWeightRegular];
  if (@available(macOS 10.14, *)) close.contentTintColor = NMUiMuted();
  close.accessibilityLabel = UiText(@"关闭提醒", @"Close reminder");
  [content addSubview:close];
  self.reminderPanel = panel;
  [self positionReminderPanel:panel];
  self.reminderDismissTimer = [NSTimer scheduledTimerWithTimeInterval:
      niuma::reminder::kReminderDisplayMilliseconds / 1000.0
      target:self selector:@selector(dismissReminder:) userInfo:nil repeats:NO];
  if (!self.reminderDismissTimer) {
    [panel orderOut:nil];
    self.reminderPanel = nil;
    return;
  }
  [NSRunLoop.mainRunLoop addTimer:self.reminderDismissTimer forMode:NSRunLoopCommonModes];
  const auto reserved = _reminderStore->TryReserve(item->id, localDate.c_str(),
      std::strcmp(item->tone, "warm") == 0, nowUtc);
  if (reserved != niuma::reminder::StoreResult::Success) {
    if (reserved == niuma::reminder::StoreResult::IoError ||
        reserved == niuma::reminder::StoreResult::InvalidState)
      _reminderStorageFault = true;
    [self.reminderDismissTimer invalidate];
    self.reminderDismissTimer = nil;
    [panel orderOut:nil];
    self.reminderPanel = nil;
    return;
  }
  _reminderStorageFault = false;
  self.reminderDismissTimer.fireDate = [NSDate dateWithTimeIntervalSinceNow:
      niuma::reminder::kReminderDisplayMilliseconds / 1000.0];
  [panel orderFrontRegardless];
}

- (void)positionReminderPanel:(NSPanel *)panel {
  if (!panel || !self.window) return;
  NSScreen *screen = self.window.screen ?: NSScreen.mainScreen;
  if (!screen) return;
  const CGFloat width = NSWidth(panel.frame);
  const CGFloat height = NSHeight(panel.frame);
  NSRect visible = screen.visibleFrame;
  NSRect mainFrame = self.window.frame;
  const auto placement = niuma::reminder::PlaceBubble(
      {NSMinX(mainFrame), NSMinY(mainFrame), NSWidth(mainFrame), NSHeight(mainFrame)},
      {NSMinX(visible), NSMinY(visible), NSWidth(visible), NSHeight(visible)},
      width, height, 10, niuma::reminder::VerticalAxis::Up);
  [panel setFrameOrigin:NSMakePoint(placement.x, placement.y)];
  if ([panel.contentView isKindOfClass:NMUiBubbleView.class]) {
    NMUiBubbleView *bubble = (NMUiBubbleView *)panel.contentView;
    bubble.companionPoint = NSMakePoint(NSMidX(mainFrame) - placement.x, NSMidY(mainFrame) - placement.y);
    bubble.needsDisplay = YES;
  }
}

- (void)reminderScreensDidChange:(NSNotification *)notification {
  (void)notification;
  [self positionReminderPanel:self.reminderPanel];
}

- (void)dismissReminder:(id)sender {
  (void)sender;
  [self.reminderDismissTimer invalidate];
  self.reminderDismissTimer = nil;
  [self.reminderPanel orderOut:nil];
  self.reminderPanel = nil;
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
    NMUiWindow(self.countStatusWindow);
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
  [self.inputMailbox configureCheckFrom:self.selfCheckStarts until:self.selfCheckEnds enabled:self.selfCheckActive];
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
      UiText(@"%@\n\n点击“开始”后切到其他应用，做几次按键、鼠标点击或滚动，10 秒后回来查看。计数自检不按应用区分，请自行确认已切换。\n\n%@\n\n本次收到：按键 %lu 次 / 鼠标按键 %lu 次 / 滚动事件 %lu 次\n按现有规则应增加 %lu，实际增加 %lu。连续滚动按一次手势计数。\n最后事件：开始后 %.1f 秒（无事件时为 0）。\n\n监听句柄或权限开关本身不是成功证据。输入监控未授权、授权身份变化或安全输入都可能影响监听；不绕过系统限制。\n\n自检仅在内存中保留事件次数与相对时间；不记录具体键值、输入内容、坐标、应用或窗口信息。不联网。",
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
    [self installEventTap];
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
  if ((gIsolatedAcceptance && !gAcceptancePhysicalInput) || self.eventTapStopping || self.eventTapOperationInProgress) return;
  self.eventTapOperationInProgress = YES;
  @try {
    if (self.eventTapRecoveryStopped) {
      [self removeEventTap];
      return;
    }
    if (self.eventTap && !self.eventTapDisabledPending &&
        CFMachPortIsValid(self.eventTap) && CGEventTapIsEnabled(self.eventTap)) {
      self.inputMonitoringAuthorized = YES;
      return;
    }
    // A disabled or invalid tap is retired, never synchronously re-armed.
    [self removeEventTap];
    if (self.eventTapRecoveryAttempts >= 3) {
      self.eventTapRecoveryStopped = YES;
      self.listenerNeedsCheck = YES;
      return;
    }
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (now < self.eventTapNextAttempt) return;
    if (!CGPreflightListenEventAccess()) {
      if (self.diagnostics && self.eventTapNextAttempt == 0) {
        fprintf(stderr, "tap_permission_preflight=denied tap_create_skipped=1\n");
      }
      // Waiting for permission does not create taps or consume a recovery attempt.
      self.eventTapNextAttempt = now + 2.0;
      return;
    }
    ++self.eventTapRecoveryAttempts;
    self.eventTapNextAttempt = now + (2.0 * (1U << (self.eventTapRecoveryAttempts - 1)));
    [self createEventTapOnce];
    if (!self.inputMonitoringAuthorized && self.eventTapRecoveryAttempts >= 3) {
      self.eventTapRecoveryStopped = YES;
      self.listenerNeedsCheck = YES;
    }
  } @finally {
    self.eventTapOperationInProgress = NO;
  }
}

- (void)stopPermissionPoll {
  if (!self.permissionPollTimer) return;
  [self.permissionPollTimer invalidate];
  self.permissionPollTimer = nil;
}

- (void)installEventTap {
  if ((gIsolatedAcceptance && !gAcceptancePhysicalInput) || self.eventTapStopping ||
      self.eventTapOperationInProgress || self.eventTap) return;
  // Only startup or an explicit retry resets this per-session recovery budget.
  self.eventTapRecoveryAttempts = 0;
  self.eventTapNextAttempt = 0;
  self.eventTapRecoveryStopped = NO;
  self.eventTapDisabledPending = NO;
  self.listenerNeedsCheck = NO;
  _reminderActivity.ResetForListenerRestart();
  [self checkPermission:nil];
}

- (void)createEventTapOnce {
  if ((gIsolatedAcceptance && !gAcceptancePhysicalInput) || self.eventTapStopping ||
      self.eventTapRecoveryStopped || !self.eventTapOperationInProgress || self.eventTap) return;
  self.globalCountConfirmed = NO;
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                     CGEventMaskBit(kCGEventLeftMouseDown) |
                     CGEventMaskBit(kCGEventRightMouseDown) |
                     CGEventMaskBit(kCGEventOtherMouseDown) |
                     CGEventMaskBit(kCGEventScrollWheel);
  const CGEventTapLocation locations[] = {kCGHIDEventTap, kCGSessionEventTap};
  for (CGEventTapLocation location : locations) {
    if (self.eventTapStopping || self.eventTapRecoveryStopped) break;
    self.eventTap = CGEventTapCreate(location, kCGHeadInsertEventTap,
        kCGEventTapOptionListenOnly, mask, EventTapCallback, (__bridge void *)self);
    if (!self.eventTap) continue;
    self.eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, self.eventTap, 0);
    if (!self.eventSource) {
      [self removeEventTap];
      continue;
    }
    [self prepareInputDelivery];
    self.inputThread=[[NMEventTapThread alloc] initWithSource:self.eventSource];
    // New taps are normally enabled. Do not fight a disabled result from the OS.
    if (self.eventTapStopping || self.eventTapRecoveryStopped || self.eventTapDisabledPending ||
        !CFMachPortIsValid(self.eventTap) || !CGEventTapIsEnabled(self.eventTap)) {
      [self removeEventTap];
      continue;
    }
    self.inputMonitoringAuthorized = YES;
    break;
  }
  if (self.diagnostics) {
    fprintf(stderr, "tap_attempt=%lu tap_attached=%d recovery_stopped=%d\n",
        (unsigned long)self.eventTapRecoveryAttempts, self.inputMonitoringAuthorized,
        self.eventTapRecoveryStopped);
    fflush(stderr);
  }
  [self.view setNeedsDisplay:YES];
}

- (void)removeEventTap {
  self.globalCountConfirmed = NO;
  if (self.selfCheckActive) self.selfCheckInterrupted = YES;
  // Clear ownership before invalidation, which may run invalidation callbacks.
  CFMachPortRef tap = self.eventTap;
  CFRunLoopSourceRef source = self.eventSource;
  self.eventTap = nullptr;
  self.eventSource = nullptr;
  self.inputMonitoringAuthorized = NO;
  self.eventTapDisabledPending = NO;
  // CFRelease alone does not tear down the WindowServer registration.
  if (tap) CFMachPortInvalidate(tap);
  [self.inputThread stop]; self.inputThread=nil;
  [self drainInput];
  if (self.inputNotification) dispatch_source_cancel(self.inputNotification);
  self.inputNotification=nil; self.inputMailbox=nil;
  if(source) CFRelease(source);
  if (tap) CFRelease(tap);
}

- (void)handleEventTapDisabled:(CGEventType)type {
  if ((gIsolatedAcceptance && !gAcceptancePhysicalInput) || self.eventTapStopping || !self.eventTap) return;
  self.globalCountConfirmed = NO;
  self.inputMonitoringAuthorized = NO;
  if (self.selfCheckActive) self.selfCheckInterrupted = YES;
  self.eventTapDisabledPending = YES;
  self.eventTapNextAttempt = MAX(self.eventTapNextAttempt,
      NSProcessInfo.processInfo.systemUptime + 2.0);
  if (type == kCGEventTapDisabledByUserInput) {
    self.eventTapRecoveryStopped = YES;
    self.listenerNeedsCheck = YES;
  }
  // No synchronous WindowServer calls or resource destruction inside the callback.
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
  NSTimeInterval now = CACurrentMediaTime();
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
  if (!_visibility.hidden()) [self.view setNeedsDisplay:YES];
  if (self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
}

- (void)countScrollGesture {
  NSTimeInterval now = CACurrentMediaTime();
  BOOL beginsNewGesture = self.lastScrollEventTime <= 0 ||
                          now - self.lastScrollEventTime > kScrollGestureIdleGap;
  self.lastScrollEventTime = now;
  if (beginsNewGesture) [self count];
}

- (void)animate:(NSTimer *)timer {
  (void)timer; self.strikeActive=NO;self.view.pendingAnimationDuration=0;
  [self.animationTimer invalidate]; self.animationTimer=nil;
  [self.view.renderer stop];
}
- (void)stopAnimation {
  [self.animationTimer invalidate]; self.animationTimer=nil;
  self.strikeActive=NO;self.view.pendingAnimationDuration=0; [self.view.renderer stop];
}

- (void)refreshAppearanceVisibility:(id)sender {
  (void)sender;
  BOOL fullscreen=NO;
  if(_visibility.autoHideFullscreen) {
    NSScreen *screen=self.window.screen ?: NSScreen.mainScreen;
    CGDirectDisplayID display=[screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    CGRect target=CGDisplayBounds(display);
    CFArrayRef windowInfo=CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID);
    std::vector<niuma::macos::FullscreenRect> visible;
    for(NSDictionary *info in (__bridge NSArray *)windowInfo) {
      if([info[(__bridge NSString *)kCGWindowLayer] intValue]!=0) continue;
      CGRect bounds{};if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds],&bounds)) continue;
      visible.push_back({bounds.origin.x,bounds.origin.y,bounds.size.width,bounds.size.height,
                         [info[(__bridge NSString *)kCGWindowOwnerPID] intValue]});
    }
    if(windowInfo) CFRelease(windowInfo);
    // NSScreen uses bottom-left coordinates; window-server bounds use top-left.
    // Convert usable-frame margins into the display's coordinate space.
    NSRect frame=screen.frame, usable=screen.visibleFrame;
    const double sx=frame.size.width>0 ? target.size.width/frame.size.width : 1;
    const double sy=frame.size.height>0 ? target.size.height/frame.size.height : 1;
    const double left=(NSMinX(usable)-NSMinX(frame))*sx;
    const double top=(NSMaxY(frame)-NSMaxY(usable))*sy;
    const double right=(NSMaxX(frame)-NSMaxX(usable))*sx;
    const double bottom=(NSMinY(usable)-NSMinY(frame))*sy;
    fullscreen=niuma::macos::FullscreenOnDisplay(
        {target.origin.x,target.origin.y,target.size.width,target.size.height,0},
        {target.origin.x+left,target.origin.y+top,target.size.width-left-right,target.size.height-top-bottom,0},
        visible,getpid());
  }
  if(!gIsolatedAcceptance || gAcceptancePhysicalInput) _visibility.fullscreen=fullscreen;
  if (!_visibility.fullscreen) _visibility.showDuringFullscreen = false;
  [self applyAppearanceVisibility];
}

- (void)applyAppearanceVisibility {
  BOOL hidden = _visibility.hidden() || self.displaySuspended;
  if (!self.window || hidden == self.appearanceHidden) return;
  self.appearanceHidden = hidden;
  [self stopAnimation]; self.strikeActive = NO;
  if (hidden) {
    [self.reminderDismissTimer invalidate]; self.reminderDismissTimer = nil;
    [self.reminderPanel orderOut:nil]; self.reminderPanel = nil;
    [self.window orderOut:nil];
  } else {
    [self refreshOffworkAllowRollover:YES];
    [self.view setNeedsDisplay:YES];
    [self.window orderFront:nil];  // Never take the typing focus.
  }
}

- (void)toggleAppearanceVisibility:(id)sender {
  (void)sender;
  if (!_visibility.recoveryAvailable) return;  // Keep a recovery path before hiding.
  BOOL hidden = !_visibility.hidden();
  _visibility.manualHidden = hidden;
  _visibility.showDuringFullscreen = !hidden && _visibility.fullscreen;
  [self refreshAppearanceVisibility:nil];
}

- (void)toggleAutoHideFullscreen:(id)sender {
  (void)sender;
  _visibility.autoHideFullscreen = !_visibility.autoHideFullscreen;
  _visibility.showDuringFullscreen = false;
  [MeritPreferences() setBool:_visibility.autoHideFullscreen forKey:@"AutoHideFullscreen"];
  [self refreshAppearanceVisibility:nil];
}

- (void)showStatusMenu:(id)sender {
  (void)sender;
  // A fresh menu always reflects manual, automatic and counting state.
  NSMenu *menu = [self contextMenu];
  [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, 0)
      inView:self.visibilityStatusItem.button];
}

- (NSMenu *)contextMenu {
  NSMenu *menu = [[NSMenu alloc] init];
  NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:UiText(@"关于牛马电子功德", @"About NiuMa Merit")
                                                action:@selector(showAbout:)
                                         keyEquivalent:@""];
  about.target = self;
  NSMenuItem *launchAtLogin = [[NSMenuItem alloc]
      initWithTitle:UiText(@"登录后自动启动", @"Start at Login")
             action:@selector(toggleLaunchAtLogin:)
      keyEquivalent:@""];
  launchAtLogin.target = self;
  launchAtLogin.enabled = !gIsolatedAcceptance;
  if ([self loginStartupState] == NMLoginStartupRequiresApproval) {
    launchAtLogin.title = UiText(@"登录后自动启动（待允许）…", @"Start at Login (Needs Approval)…");
  }
  if (self.loginStartupError) launchAtLogin.toolTip = UiText(
      @"上次设置未能完成，点击可重试。", @"The last change did not complete. Click to try again.");
  launchAtLogin.state = self.isLaunchAtLoginEnabled
      ? NSControlStateValueOn
      : NSControlStateValueOff;
  NSMenuItem *appearance = [[NSMenuItem alloc] initWithTitle:UiText(@"更换形象", @"Change Appearance")
                                                     action:@selector(showAppearancePicker:)
                                              keyEquivalent:@""];
  appearance.target = self;
  NSMenuItem *calendar = [[NSMenuItem alloc]
      initWithTitle:UiText(@"功德日历…", @"Merit Calendar…")
             action:@selector(showMeritCalendar:)
      keyEquivalent:@""];
  calendar.target = self;
  NSMenuItem *offwork = [[NSMenuItem alloc]
      initWithTitle:UiText(@"下班倒计时…", @"Off-work Countdown…")
             action:@selector(showOffworkSettings:) keyEquivalent:@""];
  offwork.target = self;
  offwork.state = self.offworkEnabled ? NSControlStateValueOn : NSControlStateValueOff;
  NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:UiText(@"退出", @"Quit")
                                                action:@selector(terminate:)
                                         keyEquivalent:@""];
  quit.target = NSApp;

  // The compact pet window is only 120 points wide. Keep the native menu
  // independent from that canvas size and leave room for checkmarks/padding.
  // Every command is a normal native row; separator rows would add uneven gaps.
  NSMenuItem *visibility = [[NSMenuItem alloc] initWithTitle:_visibility.hidden() ?
      UiText(@"显示形象（继续计数）", @"Show Appearance (Counting Continues)") :
      UiText(@"隐藏形象（继续计数）", @"Hide Appearance (Counting Continues)")
      action:@selector(toggleAppearanceVisibility:) keyEquivalent:@""];
  visibility.target = self;
  visibility.enabled = _visibility.recoveryAvailable;
  NSMenuItem *autoHide = [[NSMenuItem alloc] initWithTitle:UiText(@"全屏或最大化时自动隐身", @"Auto-hide when Fullscreen or Maximized")
      action:@selector(toggleAutoHideFullscreen:) keyEquivalent:@""];
  autoHide.target = self;
  autoHide.state = _visibility.autoHideFullscreen ? NSControlStateValueOn : NSControlStateValueOff;
  NSArray<NSMenuItem *> *entries = @[visibility, autoHide, appearance, calendar, offwork, launchAtLogin, about, quit];
  for (NSMenuItem *item in entries) [menu addItem:item];
  NSFont *menuFont = [NSFont systemFontOfSize:14];
  menu.font = menuFont;
  if (@available(macOS 11.0, *)) {
    NSArray *symbols = @[@"eye.slash", @"arrow.up.left.and.arrow.down.right", @"person.crop.square", @"calendar", @"clock", @"power", @"info.circle", @"rectangle.portrait.and.arrow.right"];
    for (NSUInteger index = 0; index < entries.count; ++index) {
      NSImage *image = [NSImage imageWithSystemSymbolName:symbols[index] accessibilityDescription:nil];
      image.size = NSMakeSize(16, 16); ((NSMenuItem *)entries[index]).image = image;
    }
  }
  CGFloat widestTitle = 0;
  for (NSMenuItem *item in menu.itemArray) {
    if (item.isSeparatorItem) continue;
    widestTitle = MAX(widestTitle, [item.title sizeWithAttributes:@{
      NSFontAttributeName: menuFont
    }].width);
  }
  menu.minimumWidth = MAX(240.0, widestTitle + 64.0);
  return menu;
}

- (void)showContextMenu:(NSEvent *)event {
  [NSMenu popUpContextMenu:[self contextMenu] withEvent:event forView:self.view];
}

- (BOOL)importOfficialMessagesAtPath:(NSString *)filename {
  if (!_catalogStore) {
    NSAlert *alert = [[NMUiAlert alloc] init];
    alert.messageText = UiText(@"无法导入文案包", @"Could Not Import Messages");
    alert.informativeText = UiText(@"本地文案库暂不可用，请退出应用后重试。",
        @"The local message catalog is unavailable. Quit the app and try again.");
    [alert addButtonWithTitle:UiText(@"好", @"OK")];
    [alert runModal];
    return NO;
  }
  auto result = _catalogStore->InstallFile(
      std::filesystem::path(filename.fileSystemRepresentation),
      niuma::reminder::OfficialCatalogSignatureVerifier());
  if (result.status == niuma::reminder::CatalogInstallStatus::Installed ||
      result.status == niuma::reminder::CatalogInstallStatus::AlreadyInstalled) {
    _reminderCatalog = result.catalog;
    std::size_t chinese = 0, english = 0;
    for (const auto& item : _reminderCatalog->items) {
      if (std::strcmp(item.language, "zh-CN") == 0) ++chinese;
      else if (std::strcmp(item.language, "en") == 0) ++english;
    }
    NSString *message = [NSString stringWithFormat:
        UiText(@"文案库版本 %u 已就绪（中文 %lu 条，英文 %lu 条）。提醒历史保持不变。",
               @"Message catalog version %u is ready (%lu Chinese, %lu English). Reminder history is unchanged."),
        _reminderCatalog->content_version, static_cast<unsigned long>(chinese),
        static_cast<unsigned long>(english)];
    NSAlert *alert = [[NMUiAlert alloc] init];
    alert.messageText = UiText(@"文案包已导入", @"Messages Imported");
    alert.informativeText = message;
    [alert addButtonWithTitle:UiText(@"好", @"OK")];
    [alert runModal];
    return YES;
  }
  NSString *message = UiText(@"文件未安装，当前文案库和提醒历史保持不变。请确认文件来自官方并且版本较新。",
                             @"The file was not installed. Your current catalog and reminder history are unchanged. Check that it is an official, newer catalog.");
  if (result.status == niuma::reminder::CatalogInstallStatus::CommitUncertain)
    message = UiText(@"文案库文件已完成本地替换，但系统未确认目录写入已持久保存。当前进程仍使用原文案库；重启后会按本地签名验证结果加载。请勿把本次提示视为已完成导入。提醒历史保持不变。",
                     @"The catalog files were replaced locally, but the system could not confirm durable directory storage. This process keeps using the previous catalog; after restart, the app will load whichever local catalog passes signature verification. Treat the import as unconfirmed. Reminder history is unchanged.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::UntrustedSignature)
    message = UiText(@"签名无效或发布密钥不受信任，当前文案库保持不变。",
                     @"The signature is invalid or its publisher key is not trusted. Your current catalog is unchanged.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::Downgrade)
    message = UiText(@"此文案库版本较旧，不能覆盖已安装的新版本。",
                     @"This catalog is older than the highest installed version and cannot replace it.");
  else if (result.status == niuma::reminder::CatalogInstallStatus::SameVersionDifferentContent)
    message = UiText(@"相同版本号对应了不同内容，文件未安装。",
                     @"This version number is already associated with different content. The file was not installed.");
  NSAlert *alert = [[NMUiAlert alloc] init];
  alert.messageText = UiText(@"无法导入文案包", @"Could Not Import Messages");
  alert.informativeText = message;
  [alert addButtonWithTitle:UiText(@"好", @"OK")];
  [alert runModal];
  return NO;
}

- (void)toggleLaunchAtLogin:(id)sender {
  (void)sender;
  if ([self loginStartupState] == NMLoginStartupRequiresApproval) {
    [self showLoginStartupApproval];
    return;
  }
  [self setLaunchAtLoginEnabled:!self.isLaunchAtLoginEnabled showError:YES];
}

- (void)showMeritCalendar:(id)sender {
  (void)sender;
  [self ensureCurrentDay];
  if (!self.calendarWindow) {
    NSRect frame = NSMakeRect(0, 0, 720, 724);
    self.calendarView = [[MeritCalendarView alloc] initWithFrame:frame];
    self.calendarView.controller = self;
    [self.calendarView showCurrentMonth];
    NSButton *previous = [[NSButton alloc] initWithFrame:NSMakeRect(24, 20, 30, 28)];
    previous.title = @"<"; previous.tag = -1; previous.target = self;
    previous.action = @selector(shiftCalendarMonth:);
    NSButton *next = [[NSButton alloc] initWithFrame:NSMakeRect(275, 20, 30, 28)];
    next.title = @">"; next.tag = 1; next.target = self;
    next.action = @selector(shiftCalendarMonth:);
    previous.accessibilityLabel = UiText(@"上个月", @"Previous month");
    next.accessibilityLabel = UiText(@"下个月", @"Next month");
    self.calendarView.previousButton = previous;
    self.calendarView.nextButton = next;
    NSButton *today=[NSButton buttonWithTitle:UiText(@"回到今天",@"Today") target:self.calendarView action:@selector(goToday:)];
    today.frame=NSMakeRect(325,20,100,28); [self.calendarView addSubview:today];
    [self.calendarView addSubview:previous];
    [self.calendarView addSubview:next];
    self.calendarWindow = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
          backing:NSBackingStoreBuffered defer:NO];
    self.calendarWindow.title = UiText(@"功德日历", @"Merit Calendar");
    self.calendarWindow.contentView = self.calendarView;
    self.calendarWindow.releasedWhenClosed = NO;
    if (gIsolatedAcceptance) self.calendarWindow.restorable = NO;
    NMUiWindow(self.calendarWindow);
    self.calendarWindow.backgroundColor=NSColor.whiteColor;
    [self.calendarWindow center];
  }
  [self.calendarView reloadMonthRange];
  [self.calendarView refreshNavigation];
  if (self.calendarWindow.isVisible) [self.calendarView setNeedsDisplay:YES];
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
  ++self.resourceGeneration; self.pendingScenePack=nil;
  NSError *error = nil;
  self.installedAppearancePacks = [NMAppearancePackStore loadInstalledMetadata:&error];
  self.appearanceLoadError = error;
  if (error && self.window) {
    NSAlert *alert = [[NMUiAlert alloc] init];
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
  ++self.resourceGeneration;
  self.pendingScenePack=[self appearancePackWithId:identifier];
  if (self.pendingScenePack) { [self pumpSceneLoad]; return; }
  [self stopAnimation];
  self.selectedScene=MeritSceneWoodfish; self.view.scene=self.selectedScene;
  self.view.appearancePack=nil; self.selectedAppearanceId=@"builtin.woodfish";
  [MeritPreferences() setInteger:self.selectedScene forKey:kSelectedScene];
  [MeritPreferences() setObject:self.selectedAppearanceId forKey:kSelectedAppearance];
  [self.view syncPresentation];
}
- (void)pumpSceneLoad {
  if (self.resourceLoadBusy || !self.pendingScenePack || self.eventTapStopping) return;
  NMAppearancePack *metadata=self.pendingScenePack; self.pendingScenePack=nil;
  NSUInteger generation=self.resourceGeneration; self.resourceLoadBusy=YES;
  __weak MeritController *weakSelf=self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{ @autoreleasepool {
    NSError *failure=nil;
    NMAppearancePack *resources=[NMAppearancePackStore loadResourcesForPack:metadata error:&failure];
    dispatch_async(dispatch_get_main_queue(), ^{
      MeritController *controller=weakSelf; if (!controller) return;
      controller.resourceLoadBusy=NO;
      if (generation==controller.resourceGeneration && !controller.eventTapStopping) {
        if (resources) {
          [controller stopAnimation]; controller.view.appearancePack=resources;
          controller.selectedAppearanceId=resources.identifier; controller.appearanceLoadError=nil;
          [MeritPreferences() setObject:resources.identifier forKey:kSelectedAppearance];
          [controller.view syncPresentation];
          [controller startStrikeWithDuration:.8];
        } else {
          controller.appearanceLoadError=failure;
          if (!gIsolatedAcceptance) {
            NSAlert *alert=[NMUiAlert new]; alert.messageText=UiText(@"形象未能切换",@"Appearance Not Changed");
            alert.informativeText=failure.localizedDescription ?: UiText(@"原形象与数据已保留。",@"The previous appearance and data were kept.");
            [alert runModal];
          }
        }
      }
      [controller pumpSceneLoad];
    });
  }});
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
  NMThumbnailGrid *grid = [[NMThumbnailGrid alloc] initWithFrame:NSMakeRect(0, 0, 324, gridHeight)];
  NSMutableArray *buttons = [NSMutableArray array];
  for (NSInteger i = 0; i < (NSInteger)items.count; ++i) {
    NSDictionary *item = items[(NSUInteger)i];
    NSImage *thumbnail = nil;
    NMAppearancePack *pack = item[@"pack"];
    if (pack) {
      thumbnail = nil; // Prepared on demand by the visible-card worker.
    } else {
      MeritView *preview = [[MeritView alloc] initWithFrame:NSMakeRect(0, 0, 120, 125)];
      preview.previewOnly = YES;
      preview.scene = (MeritScene)[item[@"scene"] integerValue];
      [preview syncPresentation];
      NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:240 pixelsHigh:250
          bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
          bitmapFormat:0 bytesPerRow:960 bitsPerPixel:32];
      NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
      [NSGraphicsContext saveGraphicsState]; NSGraphicsContext.currentContext=context;
      CGContextScaleCTM(context.CGContext,2,2); [preview.layer renderInContext:context.CGContext];
      [NSGraphicsContext restoreGraphicsState];
      thumbnail = [[NSImage alloc] initWithSize:preview.bounds.size];
      [thumbnail addRepresentation:rep];
    }
    NSInteger row = i / 2;
    NSButton *button = [[NMUiCardButton alloc] initWithFrame:NSMakeRect((i % 2) * 168,
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
    if (!pack && thumbnail) { NSMutableDictionary *withThumbnail=[item mutableCopy]; withThumbnail[@"thumbnail"]=thumbnail; items[(NSUInteger)i]=withThumbnail; }
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
  grid.items=items; grid.buttons=buttons; self.thumbnailGrid=grid;
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
    [self.appearancePickerAlert layout];
    [self.appearancePickerAlert.window makeKeyAndOrderFront:nil];
    return;
  }
  self.pendingAppearanceId = self.selectedAppearanceId;
  while (YES) {
    NSAlert *alert = [[NMUiCenteredAccessoryAlert alloc] init];
    alert.messageText = UiText(@"更换形象", @"Change Appearance");
    alert.informativeText = @"";
    alert.accessoryView = [self appearanceGrid];
    [alert addButtonWithTitle:UiText(@"确认", @"Confirm")];
    [alert addButtonWithTitle:UiText(@"取消", @"Cancel")];
    [alert addButtonWithTitle:UiText(@"删除所选本地形象", @"Remove Selected Pack")];
    [alert addButtonWithTitle:UiText(@"去官网查看更多形象", @"See More Appearances Online")];
    self.appearancePickerAlert = alert;
    NSModalResponse response = [alert runModal];
    self.appearancePickerAlert = nil;
    self.appearanceButtons=nil; self.appearanceItems=nil;
    if (response == NSAlertFirstButtonReturn) {
      [self applyAppearanceId:self.pendingAppearanceId];
      if([self.pendingAppearanceId isEqual:@"builtin.woodfish"]) [self startStrikeWithDuration:.8];
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
      NSAlert *failure = [[NMUiAlert alloc] init];
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
  NSAlert *alert = [[NMUiAlert alloc] init];
  alert.messageText = UiText(@"牛马电子功德", @"NiuMa Merit");
  NSString *version = NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"?";
  NSString *aboutText = [NSString stringWithFormat:UiText(
      @"版本 %@\n\n"
       @"只统计按键、鼠标按键和滚轮手势发生的次数，不读取输入内容或鼠标位置。全屏隐身仅判断窗口是否覆盖屏幕，不保存应用或窗口信息。\n"
       @"本软件不包含网络请求、遥测或自动更新。\n\n"
       @"在其他应用中计数，需要允许本应用使用“输入监控”。\n"
       @"如仍未正常计数，可联系开发者或扫码进粉丝群寻求帮助。\n"
       @"Mac 权限与计数帮助\n\n"
       @"官方网站：\n"
       @"https://gongde.zqscreen.cn/\n\n"
       @"扫码进粉丝群，免费领取权益包。\n"
       @"和我一起学习 AI，创建并上架你的专属形象包。\n"
       @"抖音号：1872941388",
      @"Version %@\n\n"
       @"Counts keyboard presses, mouse button presses, and scroll gestures. It does not read "
       @"typed content or mouse positions. Fullscreen hiding checks window coverage without saving app or window information.\n"
       @"The app contains no network requests, telemetry, or automatic updates.\n\n"
       @"Counting in other apps requires Input Monitoring permission.\n"
       @"If input is still not being counted, contact the developer or scan the Douyin code to join the fan group for help.\n"
       @"Mac permissions and counting help\n\n"
       @"Official website:\n"
       @"https://gongde.zqscreen.cn/\n\n"
       @"Scan with Douyin to join the fan group and claim free benefit packs.\n"
       @"Learn AI with me, and create and publish your own appearance packs.\n"
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
      @"扫码进粉丝群，免费领取权益包。",
      @"Scan with Douyin to join the fan group and claim free benefit packs.")];
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
    code.toolTip = UiText(@"使用抖音扫一扫，进粉丝群领取权益包或寻求帮助",
                         @"Scan with Douyin to join the fan group for benefit packs or help");
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
  if (gIsolatedAcceptance && !gAcceptancePhysicalInput) return event;
  MeritController *controller = (__bridge MeritController *)context;
  @autoreleasepool { [controller captureInputType:type]; }
  return event;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (!InitializeAcceptanceContext(argc, argv)) {
      fprintf(stderr, "isolated_acceptance_configuration_invalid\n");
      return 2;
    }
    if (!AcquireSingleInstanceLock()) {
      fprintf(stderr, "niuma_merit_already_running_or_lock_unavailable\n");
      return 0;
    }
    NSApplication *app = NSApplication.sharedApplication;
    MeritController *controller = [[MeritController alloc] init];
    app.delegate = controller;
    [app run];
  }
  return 0;
}
