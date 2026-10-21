// Isolated path/signature and mounted-DMG checks. Never runs a client, writes
// user preferences, grants permissions, or modifies the real Applications folder.
#import "../src/macos/installation_paths.h"
#include <unistd.h>

static void Require(BOOL condition, NSString *name) {
  if (!condition) { fprintf(stderr, "FAILED: %s\n", name.UTF8String); exit(3); }
}
static NSURL *CopyApp(NSURL *source, NSString *destination) {
  NSURL *url = [NSURL fileURLWithPath:destination isDirectory:YES];
  NSError *error = nil;
  [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent
      withIntermediateDirectories:YES attributes:nil error:&error];
  Require(!error && [NSFileManager.defaultManager copyItemAtURL:source toURL:url error:&error],
      @"create isolated app fixture");
  return url;
}
static NSDictionary *Image(NSString *path, NSString *mount) {
  return @{@"image-path": path, @"system-entities": @[@{@"mount-point":mount}]};
}
int main(int argc, const char *argv[]) { @autoreleasepool {
  if (argc != 6) return 2;
  NSURL *client = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
  NSURL *installer = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
  NSString *root = [NSString stringWithUTF8String:argv[3]];
  NSString *mount = [NSString stringWithUTF8String:argv[4]];
  NSString *otherMount = [NSString stringWithUTF8String:argv[5]];
  Require(root.isAbsolutePath && ![NSFileManager.defaultManager fileExistsAtPath:root],
      @"new private fixture directory");
  NSURL *running = CopyApp(client, [root stringByAppendingPathComponent:@"AppTranslocation/UUID/d/牛马电子功德.app"]);
  NSURL *installed = CopyApp(client, [root stringByAppendingPathComponent:@"Applications/牛马电子功德.app"]);
  Require(NMApplicationBundlesMatch(installed, running), @"valid ad-hoc bundle matches");
  Require([NMResolvePersistentApplicationURL(running,@[installed]).path isEqualToString:installed.path],
      @"translocated process resolves installed URL");
  Require(NMResolvePersistentApplicationURL(running,@[]) == nil,
      @"missing installed copy never saves temporary URL");
  Require([NMResolvePersistentApplicationURL(installed,@[]).path isEqualToString:installed.path],
      @"ordinary installed process retains its own path");
  NSBundle *bundle = [NSBundle bundleWithURL:running];
  Require([NMPersistentApplicationURL(bundle,@[@"client",@"--installed-app-path",installed.path]).path
      isEqualToString:installed.path], @"installer target argument validated");
  NSURL *second = CopyApp(client, [root stringByAppendingPathComponent:@"SecondApplications/牛马电子功德.app"]);
  Require(NMResolvePersistentApplicationURL(running,@[installed,second]) == nil,
      @"ambiguous app copies rejected");
  NSURL *changed = CopyApp(client, [root stringByAppendingPathComponent:@"Changed/牛马电子功德.app"]);
  NSString *infoPath = [changed.path stringByAppendingPathComponent:@"Contents/Info.plist"];
  NSMutableDictionary *info = [NSMutableDictionary dictionaryWithContentsOfFile:infoPath];
  info[@"CFBundleVersion"] = @"different-build"; [info writeToFile:infoPath atomically:YES];
  Require(!NMApplicationBundlesMatch(changed,running), @"different build rejected");
  NSURL *tampered = CopyApp(client, [root stringByAppendingPathComponent:@"Tampered/牛马电子功德.app"]);
  NSURL *art = [tampered URLByAppendingPathComponent:@"Contents/Resources/woodfish.png"];
  [@"tampered" writeToURL:art atomically:YES encoding:NSUTF8StringEncoding error:nil];
  Require(!NMApplicationBundlesMatch(tampered,running), @"matching binary with invalid resource seal rejected");
  NSString *link = [root stringByAppendingPathComponent:@"linked.app"];
  Require([NSFileManager.defaultManager createSymbolicLinkAtPath:link withDestinationPath:installed.path error:nil],
      @"create link fixture");
  Require(!NMApplicationBundlesMatch([NSURL fileURLWithPath:link],running), @"symlink candidate rejected");
  NSDictionary *one = @{@"images":@[Image(@"/test/owned.dmg",mount)]};
  Require([NMInstallerDiskImageVolume(installer,one).path isEqualToString:mount],
      @"original mounted DMG found using actual bundle seal");
  NSDictionary *physical = @{@"images":@[Image(@"/dev/disk99",mount)]};
  Require(NMInstallerDiskImageVolume(installer,physical) == nil, @"physical disk never selected");
  NSDictionary *duplicate = @{@"images":@[Image(@"/test/owned.dmg",mount),Image(@"/test/copy.dmg",otherMount)]};
  Require(NMInstallerDiskImageVolume(installer,duplicate) == nil, @"identical mounted copies are ambiguous");
  NSDictionary *unrelated = @{@"images":@[Image(@"/test/other.dmg",@"/Volumes/NiuMa-094-R2"),Image(@"/test/owned.dmg",mount)]};
  Require([NMInstallerDiskImageVolume(installer,unrelated).path isEqualToString:mount],
      @"old mounted version is not selected");
  Require(NMEjectDiskImageAfterExit([NSURL fileURLWithPath:otherMount],getpid()),
      @"production delayed eject helper started");
  NSDictionary *receipt = @{@"status":@"passed",@"pathAndSealedResourceCases":@9,
      @"mountedImageSelectionCases":@4,@"ejectAfterThisProcessExits":otherMount,
      @"productStarted":@NO,@"userPreferencesChanged":@NO};
  NSData *json = [NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil];
  [json writeToFile:[root stringByAppendingPathComponent:@"RESULT.json"] atomically:YES];
  puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  return 0;
} }
