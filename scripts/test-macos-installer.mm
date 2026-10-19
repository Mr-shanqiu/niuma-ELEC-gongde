// Cloud-only harness. The install target is temporary, and OS launch/eject are
// overridden so this cannot be mistaken for a Gatekeeper or device test.
#define main NiuMaInstallerEntry
#import "../installer/macos/install.mm"
#undef main

@interface TestInstaller : Installer
@property(nonatomic, strong) NSString *root;
@property(nonatomic, strong) NSString *output;
@property(nonatomic) BOOL invalidPayload;
@property(nonatomic) BOOL beganAutomatically;
@end
@implementation TestInstaller
- (void)finishTest:(BOOL)passed reason:(NSString *)reason {
  NSString *dataPath = [self.root stringByAppendingPathComponent:@"UserData/merit.dat"];
  passed = passed && self.beganAutomatically && [[NSString stringWithContentsOfFile:dataPath encoding:NSUTF8StringEncoding error:nil] isEqualToString:@"keep-user-data"];
  NSDictionary *receipt = @{@"status":passed ? @"passed" : @"failed", @"reason":reason,
      @"case":self.invalidPayload ? @"invalid-payload-keeps-existing-app" : @"install-replaces-app-keeps-user-data",
      @"realApplicationsFolderUsed":@NO, @"osLaunchAndEjectExecuted":@NO,
      @"gatekeeperVerified":@NO, @"beganAutomatically":@(self.beganAutomatically)};
  NSData *data = [NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil];
  NSString *name = self.invalidPayload ? @"installer-invalid.json" : @"installer-valid.json";
  [data writeToFile:[self.output stringByAppendingPathComponent:name] atomically:YES];
  exit(passed ? 0 : 4);
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  [super applicationDidFinishLaunching:notification];
  self.target = [NSURL fileURLWithPath:[self.root stringByAppendingPathComponent:@"Applications/牛马电子功德.app"]];
  NSFileManager *files = NSFileManager.defaultManager;
  [files createDirectoryAtURL:self.target withIntermediateDirectories:YES attributes:nil error:nil];
  [@"previous-version" writeToURL:[self.target URLByAppendingPathComponent:@"previous.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  [files createDirectoryAtPath:[self.root stringByAppendingPathComponent:@"UserData"] withIntermediateDirectories:YES attributes:nil error:nil];
  [@"keep-user-data" writeToFile:[self.root stringByAppendingPathComponent:@"UserData/merit.dat"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  if (self.invalidPayload) {
    self.payload = [NSURL fileURLWithPath:[self.root stringByAppendingPathComponent:@"invalid.app"]];
    [files createDirectoryAtURL:self.payload withIntermediateDirectories:YES attributes:nil error:nil];
  }

}
- (NSArray<NSRunningApplication *> *)runningCompanions { return @[]; }
- (void)beginAutomaticInstallation {
  self.beganAutomatically = YES;
  [self runTest];
}
- (void)runTest {
  if (!self.installButton.hidden) [self finishTest:NO reason:@"Fresh installation must not need another Install button."];
  if (!self.invalidPayload) {
    NSView *view = self.window.contentView;
    NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
        writeToFile:[self.output stringByAppendingPathComponent:@"installer.png"] atomically:YES];
  }
  [self install:nil];
}
- (void)openInstalled {
  NSData *expected = [NSData dataWithContentsOfURL:[self.payload URLByAppendingPathComponent:@"Contents/MacOS/niuma-merit"]];
  NSData *actual = [NSData dataWithContentsOfURL:[self.target URLByAppendingPathComponent:@"Contents/MacOS/niuma-merit"]];
  const BOOL matched = expected.length > 0 && [expected isEqualToData:actual];
  [self finishTest:matched reason:@"Installed executable matches the signed payload; application launch is intentionally substituted."];
}
- (void)showError:(NSString *)message {
  NSString *previous = [NSString stringWithContentsOfURL:[self.target URLByAppendingPathComponent:@"previous.txt"] encoding:NSUTF8StringEncoding error:nil];
  [self finishTest:self.invalidPayload && [previous isEqualToString:@"previous-version"] reason:message];
}
- (void)ejectOwnDiskAfterExit { [self finishTest:NO reason:@"Unexpected OS eject attempt in isolated harness"]; }
@end

int main(void) {
  @autoreleasepool {
    NSString *root = [NSString stringWithUTF8String:getenv("NIUMA_INSTALLER_TEST_ROOT") ?: ""];
    NSString *output = [NSString stringWithUTF8String:getenv("NIUMA_UI_GALLERY_OUTPUT") ?: ""];
    if (![root hasPrefix:@"/private/tmp/niuma-merit-installer-test-"] || !output.isAbsolutePath) return 2;
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
    TestInstaller *installer = [[TestInstaller alloc] init]; installer.root = root; installer.output = output;
    installer.invalidPayload = getenv("NIUMA_INSTALLER_INVALID_TEST") != nullptr;
    application.delegate = installer; [application run];
  }
  return 0;
}
