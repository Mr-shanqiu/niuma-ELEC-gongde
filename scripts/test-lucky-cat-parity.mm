#import <Cocoa/Cocoa.h>
#import "../src/macos/appearance_pack.mm"
#include <cstdio>
#include <cstdlib>

static void Require(BOOL ok, NSString *message) {
  if (!ok) { fprintf(stderr, "FAIL %s\n", message.UTF8String); exit(1); }
}

static NSBitmapImageRep *Render(NMAppearancePack *pack, CGFloat phase, BOOL native) {
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL pixelsWide:240 pixelsHigh:250
      bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
      colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:960 bitsPerPixel:32];
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  NSGraphicsContext.currentContext.imageInterpolation = NSImageInterpolationHigh;
  [NSColor.clearColor setFill];
  NSRectFillUsingOperation(NSMakeRect(0, 0, 240, 250), NSCompositingOperationCopy);
  [[NSBezierPath bezierPathWithRect:NSMakeRect(0, 0, 240, 170)] addClip];
  if (!native) {
    [pack drawAtPhase:phase];
  } else {
    // Frozen oracle: the accepted native macOS cat in app.mm, not the new pack.
    double t = phase < .42 ? phase / .42 : (phase - .42) / .58;
    double amount = t * t * (3 - 2 * t);
    if (phase >= .42) amount = 1 - amount;
    [pack.images[@"body.png"] drawInRect:NSMakeRect(5, -35, 230, 230)
        fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1
        respectFlipped:YES hints:nil];
    double ax = 30 + 230 * 362.0 / 600.0;
    double ay = -35 + 230 * (600.0 - 488.0) / 600.0;
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform translateXBy:ax yBy:ay];
    [transform scaleXBy:1 yBy:1 - .20 * amount];
    [transform translateXBy:-ax yBy:-ay];
    [transform concat];
    [pack.images[@"paw.png"] drawInRect:NSMakeRect(30, -35, 230, 230)
        fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1
        respectFlipped:YES hints:nil];
  }
  [NSGraphicsContext restoreGraphicsState];
  return bitmap;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    Require(argc == 3, @"usage: test pack-archive isolated-output-directory");
    NSString *output = @(argv[2]);
    NSString *installed = [output stringByAppendingPathComponent:@"installed"];
    setenv("NIUMA_PACK_ROOT", installed.UTF8String, 1);
    [[NSFileManager defaultManager] createDirectoryAtPath:output
        withIntermediateDirectories:YES attributes:nil error:nil];
    NSError *error = nil;
    NSURL *archive = [NSURL fileURLWithPath:@(argv[1])];
    NMAppearancePack *pack = [NMAppearancePackStore installArchiveAtURL:archive error:&error];
    Require(pack != nil, error.localizedDescription ?: @"install failed");
    Require([pack.identifier isEqualToString:@"official.lucky-cat"], @"wrong identity");
    Require([NMAppearancePackStore installArchiveAtURL:archive error:&error] != nil,
        error.localizedDescription ?: @"repeat import failed");
    Require([NMAppearancePackStore loadInstalledPacks:&error].count == 1, @"duplicate import");
    for (NSNumber *number in @[@0, @0.15, @0.42, @0.7, @1]) {
      NSBitmapImageRep *actual = Render(pack, number.doubleValue, NO);
      NSBitmapImageRep *expected = Render(pack, number.doubleValue, YES);
      NSUInteger differences = 0;
      for (NSUInteger i = 0; i < 960 * 250; ++i)
        if (actual.bitmapData[i] != expected.bitmapData[i]) ++differences;
      printf("phase=%.2f differing_bytes=%lu\n", number.doubleValue, (unsigned long)differences);
      NSString *name = [NSString stringWithFormat:@"cat-%.2f.png", number.doubleValue];
      [[actual representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
          writeToFile:[output stringByAppendingPathComponent:name] atomically:YES];
      Require(differences == 0, @"native and imported cat differ");
      for (NSUInteger y = 0; y < 80; ++y)
        for (NSUInteger x = 0; x < 240; ++x)
          Require(actual.bitmapData[y * 960 + x * 4 + 3] == 0, @"counter region overwritten");
    }
    puts("PASS schema3 install/reimport/five-phase pixel parity/artwork clipping");
  }
}
