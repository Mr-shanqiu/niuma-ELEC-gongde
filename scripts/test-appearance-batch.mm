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
    if (argc == 4 && strcmp(argv[1], "--protocol") == 0) {
      NSString *root = [NSString stringWithUTF8String:argv[3]];
      setenv("NIUMA_PACK_ROOT", argv[3], 1);
      NSArray *cases = [NSJSONSerialization JSONObjectWithData:
          [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]]
          options:0 error:nil];
      Require([cases isKindOfClass:NSArray.class] && cases.count > 0, @"missing batch protocol cases");
      for (NSDictionary *entry in cases) {
        [NSFileManager.defaultManager removeItemAtPath:root error:nil];
        NSURL *archive = [NSURL fileURLWithPath:entry[@"archive"]];
        NSError *error = nil;
        NSArray<NMAppearancePack *> *packs =
            [NMAppearancePackStore installBatchArchiveAtURL:archive error:&error];
        NSString *label = entry[@"name"];
        if ([entry[@"accept"] boolValue]) {
          NSUInteger count = [entry[@"count"] unsignedIntegerValue];
          Require(packs.count == count, [NSString stringWithFormat:@"%@: %@", label, error.localizedDescription]);
          Require([NMAppearancePackStore loadInstalledPacks:&error].count == count, label);
          for (NMAppearancePack *pack in packs) {
            NSImage *snapshot = [[NSImage alloc] initWithSize:NSMakeSize(240, 250)];
            [snapshot lockFocus];
            [pack drawAtPhase:0.5];
            [snapshot unlockFocus];
            Require(snapshot.TIFFRepresentation.length > 100, label);
          }
          Require([NMAppearancePackStore installBatchArchiveAtURL:archive error:&error].count == count, label);
          Require([NMAppearancePackStore loadInstalledPacks:&error].count == count, label);
          [NSFileManager.defaultManager removeItemAtPath:root error:nil];
          Require([NMAppearancePackStore installBatchArchiveAtURL:archive error:&error].count == count, label);
        } else Require(packs == nil && error != nil, [label stringByAppendingString:@" was accepted"]);
        printf("PASS macOS batch %s\n", label.UTF8String);
      }
      [NSFileManager.defaultManager removeItemAtPath:root error:nil];
      return 0;
    }
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
