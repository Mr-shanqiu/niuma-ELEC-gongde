#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <CoreServices/CoreServices.h>
#include <unistd.h>

static BOOL Chinese(void) {
  NSString *language = NSLocale.preferredLanguages.firstObject ?: @"en";
  return [language hasPrefix:@"zh"];
}
static NSString *Text(NSString *zh, NSString *en) { return Chinese() ? zh : en; }
static NSColor *Ink(void) { return [NSColor colorWithCalibratedWhite:.11 alpha:1]; }

@interface Installer : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSButton *installButton;
@property(nonatomic, strong) NSTextField *status;
@property(nonatomic, strong) NSProgressIndicator *progress;
@property(nonatomic, strong) NSURL *target;
@property(nonatomic, strong) NSURL *payload;
@property(nonatomic) BOOL installed;
@property(nonatomic) BOOL busy;
@end

@implementation Installer
- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size weight:(NSFontWeight)weight {
  NSTextField *label = [NSTextField wrappingLabelWithString:text];
  label.frame = frame; label.font = [NSFont systemFontOfSize:size weight:weight];
  label.textColor = Ink(); label.alignment = NSTextAlignmentCenter;
  [self.window.contentView addSubview:label]; return label;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSFileManager *files = NSFileManager.defaultManager;
  NSURL *applications = [NSURL fileURLWithPath:@"/Applications" isDirectory:YES];
  if (![files isWritableFileAtPath:applications.path])
    applications = [NSURL fileURLWithPath:[NSHomeDirectory() stringByAppendingPathComponent:@"Applications"] isDirectory:YES];
  self.payload = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"Payload/牛马电子功德.app" isDirectory:YES];
  NSString *name = [NSBundle bundleWithURL:self.payload].infoDictionary[@"NiuMaInstallName"];
  // Only a simple .app filename from the signed payload may override the target.
  if (![name isKindOfClass:NSString.class] || ![name.pathExtension isEqualToString:@"app"] ||
      ![name.lastPathComponent isEqualToString:name] || [name hasPrefix:@"."])
    name = @"牛马电子功德.app";
  self.target = [applications URLByAppendingPathComponent:name isDirectory:YES];
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 560, 390)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.title = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: Text(@"安装牛马电子功德", @"Install NiuMa Merit");
  self.window.delegate = self; self.window.releasedWhenClosed = NO;
  self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  self.window.titlebarAppearsTransparent = YES;
  self.window.backgroundColor = [NSColor colorWithCalibratedWhite:.965 alpha:1];
  NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(236, 265, 88, 88)];
  icon.image = [[NSImage alloc] initWithContentsOfURL:[NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"appicon.icns"]];
  icon.imageScaling = NSImageScaleProportionallyUpOrDown;
  [self.window.contentView addSubview:icon];
  [self label:Text(@"安装牛马电子功德", @"Install NiuMa Merit") frame:NSMakeRect(28, 222, 504, 34)
      size:25 weight:NSFontWeightSemibold];
  [self label:Text(@"装好后自动打开，再按提示开启输入监控。", @"Opens after installation, then guides you through Input Monitoring.")
      frame:NSMakeRect(38, 174, 484, 40) size:14 weight:NSFontWeightRegular];
  self.status = [self label:[NSString stringWithFormat:Text(@"安装位置：%@", @"Install location: %@"),
      [self.target.path stringByAbbreviatingWithTildeInPath]] frame:NSMakeRect(30, 116, 500, 48)
      size:12 weight:NSFontWeightRegular];
  self.status.textColor = [NSColor colorWithCalibratedWhite:.43 alpha:1];
  self.progress = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(180, 99, 200, 5)];
  self.progress.style = NSProgressIndicatorStyleBar; self.progress.indeterminate = YES;
  self.progress.hidden = YES; [self.window.contentView addSubview:self.progress];
  self.installButton = [NSButton buttonWithTitle:Text(@"安装并打开", @"Install and Open")
      target:self action:@selector(install:)];
  self.installButton.frame = NSMakeRect(182, 51, 196, 36); self.installButton.keyEquivalent = @"\r";
  self.installButton.bezelStyle = NSBezelStyleRounded;
  self.installButton.font = [NSFont systemFontOfSize:15 weight:NSFontWeightMedium];
  [self.window.contentView addSubview:self.installButton];
  const unsigned long long size = [NSBundle.mainBundle.infoDictionary[@"NiuMaInstalledBytes"] unsignedLongLongValue];
  NSString *sizeText = [NSByteCountFormatter stringFromByteCount:size countStyle:NSByteCountFormatterCountStyleFile];
  [self label:[NSString stringWithFormat:Text(@"安装后约 %@ · 本地运行，无需联网", @"About %@ installed · Local operation, no internet required"), sizeText]
      frame:NSMakeRect(28, 15, 504, 22) size:12 weight:NSFontWeightRegular];
  [self.window center]; [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
  (void)sender; if (self.busy) return NO; [NSApp terminate:nil]; return YES;
}
- (void)showError:(NSString *)message {
  self.busy = NO; self.progress.hidden = YES; [self.progress stopAnimation:nil];
  self.installButton.enabled = YES;
  self.installButton.title = self.installed ? Text(@"打开应用", @"Open App") : Text(@"重新安装", @"Try Again");
  self.status.stringValue = message;
  NSAlert *alert = [[NSAlert alloc] init]; alert.alertStyle = NSAlertStyleWarning;
  alert.messageText = self.installed ? Text(@"已安装，暂未能打开", @"Installed, but could not open") : Text(@"暂未完成安装", @"Installation not completed");
  alert.informativeText = message; [alert addButtonWithTitle:Text(@"知道了", @"OK")];
  [alert runModal];
}
- (BOOL)verifyPayload:(NSError **)error {
  SecStaticCodeRef code = nullptr;
  OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)self.payload, kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, nullptr);
  if (code) CFRelease(code);
  if (status != errSecSuccess) {
    if (error) *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:@{
        NSLocalizedDescriptionKey:Text(@"安装文件校验失败，请重新下载官方安装包。", @"The app bundle failed integrity verification. Download the official installer again.")}];
    return NO;
  }
  return YES;
}
- (void)install:(id)sender {
  (void)sender; if (self.busy) return;
  if (self.installed) { [self openInstalled]; return; }
  NSArray<NSRunningApplication *> *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"cn.niuma.merit"];
  if (running.count) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = Text(@"先退出正在运行的牛马", @"Quit the running companion first");
    alert.informativeText = Text(@"退出后继续安装，你的功德、形象和设置都会保留。", @"Installation will continue after it quits. Your merit, appearances and settings are preserved.");
    [alert addButtonWithTitle:Text(@"退出并安装", @"Quit and Install")];
    [alert addButtonWithTitle:Text(@"取消", @"Cancel")];
    if ([alert runModal] != NSAlertFirstButtonReturn) return;
    for (NSRunningApplication *app in running) [app terminate];
  }
  self.busy = YES; self.installButton.enabled = NO; self.progress.hidden = NO;
  [self.progress startAnimation:nil]; self.status.stringValue = Text(@"正在安装，请稍候…", @"Installing…");
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @autoreleasepool {
      for (int retry = 0; retry < 30 && [NSRunningApplication runningApplicationsWithBundleIdentifier:@"cn.niuma.merit"].count; ++retry)
        [NSThread sleepForTimeInterval:.1];
      if ([NSRunningApplication runningApplicationsWithBundleIdentifier:@"cn.niuma.merit"].count) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self showError:Text(@"应用尚未退出，请从右键菜单退出后重试。", @"The app is still running. Quit it from its menu, then try again.")]; }); return;
      }
      NSError *error = nil;
      NSFileManager *files = NSFileManager.defaultManager;
      if (![self verifyPayload:&error]) {
        NSString *message = error.localizedDescription;
        dispatch_async(dispatch_get_main_queue(), ^{ [self showError:message]; }); return;
      }
      NSURL *parent = self.target.URLByDeletingLastPathComponent;
      NSString *unique = NSUUID.UUID.UUIDString;
      NSURL *stage = [parent URLByAppendingPathComponent:[NSString stringWithFormat:@".niuma-install-%@.app", unique]];
      NSURL *backup = [parent URLByAppendingPathComponent:[NSString stringWithFormat:@".niuma-previous-%@.app", unique]];
      BOOL movedPrevious = NO, complete = NO;
      if ([files createDirectoryAtURL:parent withIntermediateDirectories:YES attributes:nil error:&error] &&
          [files copyItemAtURL:self.payload toURL:stage error:&error]) {
        if ([files fileExistsAtPath:self.target.path])
          movedPrevious = [files moveItemAtURL:self.target toURL:backup error:&error];
        if ((!error || movedPrevious) && [files moveItemAtURL:stage toURL:self.target error:&error]) complete = YES;
        if (!complete && movedPrevious) {
          NSError *restoreError = nil;
          if (![files moveItemAtURL:backup toURL:self.target error:&restoreError]) {
            error = [NSError errorWithDomain:@"NiuMaInstaller" code:2 userInfo:@{NSLocalizedDescriptionKey:
                [NSString stringWithFormat:Text(@"安装未完成，原应用保留在 %@。%@", @"Installation did not complete. The previous app is preserved at %@. %@"), backup.path, restoreError.localizedDescription]}];
          }
        }
      }
      if ([files fileExistsAtPath:stage.path]) [files removeItemAtURL:stage error:nil];
      if (complete && movedPrevious) [files removeItemAtURL:backup error:nil];
      NSString *message = error.localizedDescription ?: Text(@"请确认应用程序文件夹可以写入，再重试。", @"Check that the Applications folder is writable, then try again.");
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!complete) { [self showError:message]; return; }
        self.installed = YES; self.status.stringValue = Text(@"安装完成，正在打开…", @"Installed. Opening…");
        [self openInstalled];
      });
    }
  });
}
- (void)openInstalled {
  self.busy = YES; self.installButton.enabled = NO;
  // Register the final installed URL before the client requests system permission.
  // Launch by this exact URL even when older same-ID copies are still present.
  if (LSRegisterURL((__bridge CFURLRef)self.target, true) != noErr) {
    [self showError:Text(@"应用已安装，但系统登记未完成。请点击“打开应用”重试。", @"The app is installed, but macOS registration did not finish. Click Open App to retry.")];
    return;
  }
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.activates = YES;
  [NSWorkspace.sharedWorkspace openApplicationAtURL:self.target configuration:configuration
      completionHandler:^(NSRunningApplication *app, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!app || error) { [self showError:error.localizedDescription ?: Text(@"请到“应用程序”中打开牛马，并按系统提示确认。", @"Open NiuMa Merit from Applications and follow any macOS prompt.")]; return; }
      [self.window orderOut:nil]; [self ejectOwnDiskAfterExit]; [NSApp terminate:nil];
    });
  }];
}
- (void)ejectOwnDiskAfterExit {
  // Only detach the disk image hosting this installer; never eject physical disks.
  NSURL *volume = nil; [NSBundle.mainBundle.bundleURL getResourceValue:&volume forKey:NSURLVolumeURLKey error:nil];
  if (![volume.path hasPrefix:@"/Volumes/"]) return;
  NSTask *info = [[NSTask alloc] init]; info.executableURL = [NSURL fileURLWithPath:@"/usr/bin/hdiutil"];
  info.arguments = @[@"info", @"-plist"]; NSPipe *pipe = NSPipe.pipe; info.standardOutput = pipe;
  info.standardError = NSFileHandle.fileHandleWithNullDevice;
  if (![info launchAndReturnError:nil]) return;
  NSData *data = [pipe.fileHandleForReading readDataToEndOfFile]; [info waitUntilExit];
  NSDictionary *root = [NSPropertyListSerialization propertyListWithData:data options:0 format:nil error:nil];
  BOOL ownedImage = NO;
  for (NSDictionary *image in root[@"images"]) {
    if (![[image[@"image-path"] lowercaseString] hasSuffix:@".dmg"]) continue;
    for (NSDictionary *entity in image[@"system-entities"])
      if ([entity[@"mount-point"] isEqualToString:volume.path]) ownedImage = YES;
  }
  if (!ownedImage) return;
  NSTask *helper = [[NSTask alloc] init]; helper.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
  helper.arguments = @[@"-c", @"sleep 2; /usr/bin/hdiutil detach \"$1\" >/dev/null 2>&1", @"niuma-installer-eject", volume.path];
  helper.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  helper.standardError = NSFileHandle.fileHandleWithNullDevice;
  [helper launchAndReturnError:nil];
}
@end

int main(int argc, const char *argv[]) {
  (void)argc; (void)argv;
  @autoreleasepool {
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    Installer *installer = [[Installer alloc] init]; application.delegate = installer;
    [application run];
  }
  return 0;
}
