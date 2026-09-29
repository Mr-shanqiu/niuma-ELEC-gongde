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
    Require(argc == 3, @"usage: test-batch archive pack-root");
    setenv("NIUMA_PACK_ROOT", argv[2], 1);
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *root = [NSString stringWithUTF8String:argv[2]];
    [fm removeItemAtPath:root error:nil];
    NSURL *batch = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    NSError *error = nil;
    NSArray<NMAppearancePack *> *first =
        [NMAppearancePackStore installBatchArchiveAtURL:batch error:&error];
    Require(first != nil && first.count == 2,
            error.localizedDescription ?: @"two-pack batch import failed");
    Require([NMAppearancePackStore loadInstalledPacks:&error].count == 2,
            error.localizedDescription ?: @"batch did not install both packs");
    NSArray<NMAppearancePack *> *again =
        [NMAppearancePackStore installBatchArchiveAtURL:batch error:&error];
    Require(again != nil && again.count == 2 &&
            [NMAppearancePackStore loadInstalledPacks:nil].count == 2,
            error.localizedDescription ?: @"reimport duplicated packs");
    NSString *invalidPath = [root stringByAppendingString:@"-invalid.nmgpacks"];
    [@"not a zip archive" writeToFile:invalidPath atomically:YES
                            encoding:NSUTF8StringEncoding error:nil];
    Require([NMAppearancePackStore installBatchArchiveAtURL:
                 [NSURL fileURLWithPath:invalidPath] error:nil] == nil,
            @"invalid batch was accepted");
    [fm removeItemAtPath:invalidPath error:nil];
    [fm removeItemAtPath:root error:nil];
    puts("PASS macOS two-pack batch import, reimport and invalid-archive rejection");
  }
  return 0;
}
