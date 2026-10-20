#pragma once
#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <signal.h>
#include <unistd.h>

static NSString *const kLaunchAtLoginConfigured = @"launchAtLoginConfigured";
static NSString *const kLaunchAtLoginEnabled = @"launchAtLoginEnabled";
static NSString *const kLaunchAtLoginServiceManaged = @"launchAtLogin.serviceManaged.v1";
static NSString *const kLaunchAgentLabel = @"cn.niuma.merit.autostart";

typedef NS_ENUM(NSInteger, NMLoginStartupState) {
  NMLoginStartupDisabled,
  NMLoginStartupEnabled,
  NMLoginStartupRequiresApproval,
  NMLoginStartupUnavailable
};

@protocol NMLoginStartupPreferences <NSObject>
- (id)objectForKey:(NSString *)key;
- (BOOL)boolForKey:(NSString *)key;
- (void)setBool:(BOOL)value forKey:(NSString *)key;
@end

// The coordinator is exercised with an in-memory backend. Tests never register
// the real application or change the user's login items or preference domain.
@protocol NMLoginStartupService <NSObject>
- (NMLoginStartupState)state;
- (BOOL)registerAndReturnError:(NSError **)error;
- (BOOL)unregisterAndReturnError:(NSError **)error;
@end

API_AVAILABLE(macos(13.0))
@interface NMMainAppLoginService : NSObject <NMLoginStartupService>
@end

@implementation NMMainAppLoginService
- (NMLoginStartupState)state {
  switch (SMAppService.mainAppService.status) {
    case SMAppServiceStatusNotRegistered: return NMLoginStartupDisabled;
    case SMAppServiceStatusEnabled: return NMLoginStartupEnabled;
    case SMAppServiceStatusRequiresApproval: return NMLoginStartupRequiresApproval;
    case SMAppServiceStatusNotFound: return NMLoginStartupUnavailable;
  }
  return NMLoginStartupUnavailable;
}
- (BOOL)registerAndReturnError:(NSError **)error {
  return [SMAppService.mainAppService registerAndReturnError:error];
}
- (BOOL)unregisterAndReturnError:(NSError **)error {
  return [SMAppService.mainAppService unregisterAndReturnError:error];
}
@end

static NSError *NMLoginStartupError(NSInteger code) {
  return [NSError errorWithDomain:@"cn.niuma.merit.login-startup" code:code userInfo:nil];
}

typedef BOOL (^NMRetireLegacyLoginItem)(NSError **error);

@interface NMLoginStartupCoordinator : NSObject
@property(nonatomic, strong) id<NMLoginStartupService> service;
@property(nonatomic, strong) id<NMLoginStartupPreferences> preferences;
@property(nonatomic, copy) NMRetireLegacyLoginItem retireLegacy;
- (BOOL)setEnabled:(BOOL)enabled error:(NSError **)error;
- (BOOL)configureRespectingLegacyDenial:(BOOL)legacyDenied error:(NSError **)error;
@end

@implementation NMLoginStartupCoordinator
- (BOOL)setEnabled:(BOOL)enabled error:(NSError **)error {
  NMLoginStartupState before = self.service.state;
  BOOL registeredNow = NO;
  NSError *failure = nil;
  if (enabled && before != NMLoginStartupEnabled && before != NMLoginStartupRequiresApproval) {
    BOOL accepted = [self.service registerAndReturnError:&failure];
    NMLoginStartupState after = self.service.state;
    // A denied registration may still have registered an item pending approval.
    // Preserve that state without treating it as permission to launch.
    if (after != NMLoginStartupEnabled && after != NMLoginStartupRequiresApproval) {
      if (error) *error = failure ?: NMLoginStartupError(1);
      return NO;
    }
    registeredNow = accepted || after != before;
  } else if (!enabled && (before == NMLoginStartupEnabled || before == NMLoginStartupRequiresApproval)) {
    BOOL removed = [self.service unregisterAndReturnError:&failure];
    NMLoginStartupState after = self.service.state;
    if (!removed && after != NMLoginStartupDisabled) {
      if (error) *error = failure ?: NMLoginStartupError(2);
      return NO;
    }
    if (after == NMLoginStartupEnabled || after == NMLoginStartupRequiresApproval) {
      if (error) *error = NMLoginStartupError(2);
      return NO;
    }
  }
  if (!enabled) {
    // Keep an explicit opt-out even if removing the legacy item needs a retry.
    [self.preferences setBool:YES forKey:kLaunchAtLoginConfigured];
    [self.preferences setBool:NO forKey:kLaunchAtLoginEnabled];
  }
  if (!self.retireLegacy(&failure)) {
    // Registration failure never removes the old item. If cleanup fails after
    // a new registration, undo that new registration so the old item can stay.
    if (registeredNow) {
      NSError *rollbackError = nil;
      if (![self.service unregisterAndReturnError:&rollbackError])
        failure = NMLoginStartupError(4);
    }
    if (error) *error = failure ?: NMLoginStartupError(3);
    return NO;
  }
  [self.preferences setBool:YES forKey:kLaunchAtLoginConfigured];
  [self.preferences setBool:enabled forKey:kLaunchAtLoginEnabled];
  [self.preferences setBool:YES forKey:kLaunchAtLoginServiceManaged];
  return YES;
}
- (BOOL)configureRespectingLegacyDenial:(BOOL)legacyDenied error:(NSError **)error {
  if ([self.preferences boolForKey:kLaunchAtLoginServiceManaged]) {
    // Once migrated, the system is authoritative. Do not re-register on every
    // launch: that would undo a user's change in System Settings.
    if (!self.retireLegacy(error)) return NO;
    NMLoginStartupState state = self.service.state;
    if (state != NMLoginStartupUnavailable) {
      [self.preferences setBool:state != NMLoginStartupDisabled forKey:kLaunchAtLoginEnabled];
    }
    return YES;
  }
  BOOL configured = [self.preferences objectForKey:kLaunchAtLoginConfigured] != nil;
  BOOL desired = !configured || [self.preferences boolForKey:kLaunchAtLoginEnabled];
  // A system-disabled legacy job must not be silently re-enabled by migration.
  if (legacyDenied && self.service.state != NMLoginStartupEnabled &&
      self.service.state != NMLoginStartupRequiresApproval) desired = NO;
  return [self setEnabled:desired error:error];
}
@end

// launchctl is used only to retire this app's old, fixed-label user job. Discard
// its output rather than waiting on a pipe, and bound both execution and cleanup.
static int NMRunLegacyLaunchctl(NSArray<NSString *> *arguments, NSError **error) {
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
  task.arguments = arguments;
  task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  task.standardError = NSFileHandle.fileHandleWithNullDevice;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  task.terminationHandler = ^(NSTask *finished) { (void)finished; dispatch_semaphore_signal(done); };
  if (![task launchAndReturnError:error]) return -1;
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) {
    [task terminate];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) {
      if (task.running) kill(task.processIdentifier, SIGKILL);
      dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
    }
    if (error) *error = NMLoginStartupError(5);
    return -1;
  }
  return task.terminationStatus;
}

static BOOL NMRetireLegacyStartup(NSURL *plistURL, NSError **error) {
  NSString *target = [NSString stringWithFormat:@"gui/%u/%@", (unsigned)getuid(), kLaunchAgentLabel];
  int loaded = NMRunLegacyLaunchctl(@[@"print", target], error);
  // launchctl print returns 113 when this exact job does not exist.
  if (loaded != 0 && loaded != 113) {
    if (error && !*error) *error = NMLoginStartupError(3);
    return NO;
  }
  if (loaded == 0 && NMRunLegacyLaunchctl(@[@"bootout", target], error) != 0) {
    if (error && !*error) *error = NMLoginStartupError(3);
    return NO;
  }
  if (![NSFileManager.defaultManager fileExistsAtPath:plistURL.path]) return YES;
  return [NSFileManager.defaultManager removeItemAtURL:plistURL error:error];
}
