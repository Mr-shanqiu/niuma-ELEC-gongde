// In-memory policy tests: no real SMAppService calls, launchctl, app launch,
// user defaults, login settings, or input-monitoring changes.
#define main NiuMaProductMainNotRun
#import "../src/macos/app.mm"
#undef main
#include <cstdio>

@interface NMLoginTestPreferences : NSObject <NMLoginStartupPreferences>
@property(nonatomic, strong) NSMutableDictionary *values;
@end
@implementation NMLoginTestPreferences
- (instancetype)init { if ((self = [super init])) _values = [NSMutableDictionary dictionary]; return self; }
- (id)objectForKey:(NSString *)key { return self.values[key]; }
- (BOOL)boolForKey:(NSString *)key { return [self.values[key] boolValue]; }
- (void)setBool:(BOOL)value forKey:(NSString *)key { self.values[key] = @(value); }
@end

@interface NMLoginTestService : NSObject <NMLoginStartupService>
@property(nonatomic) NMLoginStartupState state;
@property(nonatomic) NMLoginStartupState registerState;
@property(nonatomic) BOOL registerSucceeds;
@property(nonatomic) BOOL unregisterSucceeds;
@property(nonatomic) NSUInteger registrations;
@property(nonatomic) NSUInteger unregistrations;
@end
@implementation NMLoginTestService
- (instancetype)init {
  if ((self = [super init])) {
    _state = NMLoginStartupDisabled; _registerState = NMLoginStartupEnabled;
    _registerSucceeds = YES; _unregisterSucceeds = YES;
  }
  return self;
}
- (BOOL)registerAndReturnError:(NSError **)error {
  ++self.registrations; self.state = self.registerState;
  if (!self.registerSucceeds && error) *error = NMLoginStartupError(100);
  return self.registerSucceeds;
}
- (BOOL)unregisterAndReturnError:(NSError **)error {
  ++self.unregistrations;
  if (self.unregisterSucceeds) self.state = NMLoginStartupDisabled;
  else if (error) *error = NMLoginStartupError(101);
  return self.unregisterSucceeds;
}
@end

static unsigned checks = 0;
static void Require(BOOL okay, const char *name) {
  if (!okay) { fprintf(stderr, "FAILED: %s\n", name); exit(3); }
  ++checks;
}

int main(void) { @autoreleasepool {
  // Each scenario gets independent preferences, backend and legacy state.
  for (unsigned scenario = 0; scenario < 14; ++scenario) {
    NMLoginTestPreferences *prefs = [[NMLoginTestPreferences alloc] init];
    NMLoginTestService *service = [[NMLoginTestService alloc] init];
    NMLoginStartupCoordinator *coordinator = [[NMLoginStartupCoordinator alloc] init];
    coordinator.preferences = prefs; coordinator.service = service;
    __block NSUInteger cleanups = 0;
    __block BOOL cleanupSucceeds = YES;
    coordinator.retireLegacy = ^BOOL(NSError **error) {
      ++cleanups;
      if (!cleanupSucceeds && error) *error = NMLoginStartupError(102);
      return cleanupSucceeds;
    };
    NSError *error = nil;
    if (scenario == 0) {
      Require([coordinator configureRespectingLegacyDenial:NO error:&error], "first launch");
      Require(service.registrations == 1 && service.state == NMLoginStartupEnabled && cleanups == 1,
          "first launch registers once then retires old item");
      Require([prefs boolForKey:kLaunchAtLoginServiceManaged], "migration recorded");
    } else if (scenario == 1 || scenario == 2) {
      [prefs setBool:YES forKey:kLaunchAtLoginConfigured];
      [prefs setBool:scenario == 2 forKey:kLaunchAtLoginEnabled];
      Require([coordinator configureRespectingLegacyDenial:NO error:&error], "legacy preference migrated");
      Require(service.registrations == (scenario == 2 ? 1u : 0u) && cleanups == 1,
          "legacy opt-in and opt-out preserved");
    } else if (scenario == 3) {
      Require([coordinator configureRespectingLegacyDenial:YES error:&error], "system-disabled old item migrated");
      Require(service.registrations == 0 && ![prefs boolForKey:kLaunchAtLoginEnabled],
          "migration cannot override system-disabled old item");
    } else if (scenario == 4 || scenario == 5) {
      service.state = scenario == 4 ? NMLoginStartupEnabled : NMLoginStartupRequiresApproval;
      Require([coordinator configureRespectingLegacyDenial:NO error:&error], "existing modern state migrated");
      Require(service.registrations == 0 && cleanups == 1, "already registered item not registered again");
      Require(service.state == (scenario == 4 ? NMLoginStartupEnabled : NMLoginStartupRequiresApproval),
          "pending approval is never treated as enabled");
    } else if (scenario == 6) {
      service.registerSucceeds = NO; service.registerState = NMLoginStartupDisabled;
      Require(![coordinator configureRespectingLegacyDenial:NO error:&error], "failed registration reported");
      Require(error != nil && cleanups == 0 && ![prefs boolForKey:kLaunchAtLoginServiceManaged],
          "failed registration leaves legacy item and migration flags untouched");
    } else if (scenario == 7) {
      cleanupSucceeds = NO;
      Require(![coordinator configureRespectingLegacyDenial:NO error:&error], "failed cleanup reported");
      Require(service.unregistrations == 1 && service.state == NMLoginStartupDisabled &&
          ![prefs boolForKey:kLaunchAtLoginServiceManaged], "new registration rolled back after cleanup failure");
    } else if (scenario == 8 || scenario == 9) {
      [prefs setBool:YES forKey:kLaunchAtLoginConfigured];
      [prefs setBool:YES forKey:kLaunchAtLoginEnabled];
      [prefs setBool:YES forKey:kLaunchAtLoginServiceManaged];
      service.state = scenario == 8 ? NMLoginStartupDisabled : NMLoginStartupRequiresApproval;
      Require([coordinator configureRespectingLegacyDenial:NO error:&error], "migrated state reconciled");
      Require(service.registrations == 0 && service.unregistrations == 0,
          "system changes never cause automatic re-registration");
    } else if (scenario == 10) {
      service.state = NMLoginStartupRequiresApproval;
      Require([coordinator setEnabled:NO error:&error], "pending item can be disabled");
      Require(service.unregistrations == 1 && ![prefs boolForKey:kLaunchAtLoginEnabled], "disable pending state");
    } else if (scenario == 11) {
      service.state = NMLoginStartupEnabled; service.unregisterSucceeds = NO;
      Require(![coordinator setEnabled:NO error:&error], "unregister failure reported");
      Require(error != nil && cleanups == 0 && service.state == NMLoginStartupEnabled,
          "unregister failure is not shown as disabled");
    } else if (scenario == 12) {
      service.registerSucceeds = NO; service.registerState = NMLoginStartupRequiresApproval;
      Require([coordinator setEnabled:YES error:&error], "system denial with pending registration retained");
      Require(service.state == NMLoginStartupRequiresApproval && service.registrations == 1 && cleanups == 1,
          "pending registration is preserved for system approval");
    } else {
      service.state = NMLoginStartupEnabled; cleanupSucceeds = NO;
      Require(![coordinator setEnabled:NO error:&error], "disable with cleanup failure reported");
      Require(![prefs boolForKey:kLaunchAtLoginEnabled], "explicit opt-out retained across cleanup failure");
      cleanupSucceeds = YES;
      Require([coordinator configureRespectingLegacyDenial:NO error:&error] && service.registrations == 0,
          "cleanup retry never re-enables explicit opt-out");
    }
  }
  [NSApplication sharedApplication];
  NMLoginTestPreferences *prefs = [[NMLoginTestPreferences alloc] init];
  NMLoginTestService *service = [[NMLoginTestService alloc] init];
  NMLoginStartupCoordinator *coordinator = [[NMLoginStartupCoordinator alloc] init];
  coordinator.preferences = prefs; coordinator.service = service;
  coordinator.retireLegacy = ^BOOL(NSError **error) { (void)error; return YES; };
  MeritController *controller = [[MeritController alloc] init];
  controller.loginStartup = coordinator;
  for (NSNumber *value in @[@(NMLoginStartupEnabled), @(NMLoginStartupDisabled),
                            @(NMLoginStartupRequiresApproval), @(NMLoginStartupUnavailable)]) {
    service.state = (NMLoginStartupState)value.integerValue;
    NSMenu *menu = controller.contextMenu;
    NSInteger index = [menu indexOfItemWithTarget:controller andAction:@selector(toggleLaunchAtLogin:)];
    Require(index >= 0, "product menu contains login startup item");
    NSMenuItem *item = [menu itemAtIndex:index];
    Require(item.state == (service.state == NMLoginStartupEnabled ? NSControlStateValueOn : NSControlStateValueOff),
        "product menu reflects actual backend state, never stored preference");
    if (service.state == NMLoginStartupRequiresApproval)
      Require([item.title containsString:UiText(@"待允许", @"Needs Approval")], "product menu explains pending approval");
  }
  gIsolatedAcceptance = YES;
  NSMenu *isolatedMenu = controller.contextMenu;
  NSInteger index = [isolatedMenu indexOfItemWithTarget:controller andAction:@selector(toggleLaunchAtLogin:)];
  Require(![isolatedMenu itemAtIndex:index].enabled, "isolated candidate cannot change login items");
  Require(service.registrations == 0 && service.unregistrations == 0, "menu never changes system registration");
  printf("login_startup_policy_passed: 14 scenarios, %u checks; no system changes\n", checks);
  return 0;
} }
