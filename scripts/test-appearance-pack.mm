#import <Cocoa/Cocoa.h>
#import "../src/macos/appearance_pack.h"

static void Require(BOOL condition, NSString *message) {
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", message.UTF8String);
    exit(1);
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    Require(argc == 4, @"usage: test archive unsafe-archive pack-root");
    setenv("NIUMA_PACK_ROOT", argv[3], 1);
    NSFileManager *fm = NSFileManager.defaultManager;
    [fm removeItemAtPath:[NSString stringWithUTF8String:argv[3]] error:nil];
    NSError *error = nil;
    NMAppearancePack *pack = [NMAppearancePackStore installArchiveAtURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]] error:&error];
    Require(pack != nil, error.localizedDescription ?: @"valid pack installation failed");
    Require([pack.identifier isEqualToString:@"official.woodfish-sample"], @"pack id mismatch");
    Require(pack.layers.count == 2, @"layer count mismatch");
    Require([NMAppearancePackStore loadInstalledPacks:&error].count == 1, @"installed pack scan failed");
    NSImage *snapshot = [[NSImage alloc] initWithSize:NSMakeSize(240, 250)];
    [snapshot lockFocus];
    [pack drawAtPhase:0.5];
    [snapshot unlockFocus];
    Require(snapshot.TIFFRepresentation.length > 100, @"rendered snapshot is empty");
    NMAppearancePack *updated = [NMAppearancePackStore installArchiveAtURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]] error:&error];
    Require(updated != nil && [NMAppearancePackStore loadInstalledPacks:nil].count == 1, @"same-id update failed");
    NMAppearancePack *unsafe = [NMAppearancePackStore installArchiveAtURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]] error:nil];
    Require(unsafe == nil, @"unsafe archive was accepted");
    Require([NMAppearancePackStore removePack:updated error:&error], error.localizedDescription ?: @"remove failed");
    Require([NMAppearancePackStore loadInstalledPacks:nil].count == 0, @"removed pack remains installed");
    puts("PASS appearance-pack install/update/render/reject/remove");
  }
  return 0;
}
