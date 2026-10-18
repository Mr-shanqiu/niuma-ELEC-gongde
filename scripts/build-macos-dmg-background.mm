// Render the Finder installation page from native text/vector drawing at 1x/2x.
#import <AppKit/AppKit.h>
@interface InstallPage : NSView
@property(nonatomic) BOOL preview;
@property(nonatomic, strong) NSImage *icon;
@property(nonatomic, strong) NSString *sizeText;
@end
@implementation InstallPage
- (BOOL)isFlipped { return YES; }
- (void)text:(NSString *)text rect:(NSRect)rect size:(CGFloat)size weight:(NSFontWeight)weight color:(NSColor *)color {
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.alignment = NSTextAlignmentCenter;
  [text drawInRect:rect withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:size weight:weight],
    NSForegroundColorAttributeName:color, NSParagraphStyleAttributeName:paragraph}];
}
- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  [[NSColor colorWithCalibratedWhite:.965 alpha:1] setFill]; NSRectFill(self.bounds);
  NSColor *ink = [NSColor colorWithCalibratedWhite:.11 alpha:1];
  NSColor *muted = [NSColor colorWithCalibratedWhite:.43 alpha:1];
  [self text:@"双击下方图标" rect:NSMakeRect(30,29,580,38) size:28 weight:NSFontWeightSemibold color:ink];
  [self text:@"自动安装并打开" rect:NSMakeRect(30,73,580,26) size:17 weight:NSFontWeightMedium color:ink];
  [self text:@"Double-click below to install and open." rect:NSMakeRect(30,107,580,22) size:14 weight:NSFontWeightRegular color:muted];
  [NSColor.whiteColor setFill];
  [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(176,153,288,192) xRadius:22 yRadius:22] fill];
  NSBezierPath *arrow = [NSBezierPath bezierPath];
  [arrow moveToPoint:NSMakePoint(314,136)]; [arrow lineToPoint:NSMakePoint(320,141)];
  [arrow lineToPoint:NSMakePoint(326,136)]; arrow.lineWidth = 2;
  [[NSColor colorWithCalibratedRed:0 green:.44 blue:.96 alpha:1] setStroke]; [arrow stroke];
  if (self.preview) {
    [self.icon drawInRect:NSMakeRect(265,179,110,110) fromRect:NSZeroRect
      operation:NSCompositingOperationSourceOver fraction:1 respectFlipped:YES hints:@{NSImageHintInterpolation:@(NSImageInterpolationHigh)}];
    [self text:@"安装牛马电子功德" rect:NSMakeRect(222,298,196,22) size:13 weight:NSFontWeightMedium color:ink];
  }
  [self text:[NSString stringWithFormat:@"安装后约 %@ · 本地运行，无需联网", self.sizeText]
    rect:NSMakeRect(25,365,590,20) size:13 weight:NSFontWeightRegular color:muted];
  [self text:@"Runs locally · No internet required" rect:NSMakeRect(25,389,590,20)
    size:12 weight:NSFontWeightRegular color:muted];
}
@end
static NSBitmapImageRep *Render(InstallPage *view, NSInteger scale) {
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nil
    pixelsWide:640*scale pixelsHigh:420*scale bitsPerSample:8 samplesPerPixel:4
    hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  bitmap.size = NSMakeSize(640,420);
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap]; return bitmap;
}
int main(int argc, const char **argv) { @autoreleasepool {
  if (argc != 5) return 2;
  [NSApplication sharedApplication];
  InstallPage *view = [[InstallPage alloc] initWithFrame:NSMakeRect(0,0,640,420)];
  view.icon = [[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]];
  view.sizeText = [NSByteCountFormatter stringFromByteCount:atoll(argv[4]) countStyle:NSByteCountFormatterCountStyleFile];
  NSImage *background = [[NSImage alloc] initWithSize:view.bounds.size];
  [background addRepresentation:Render(view,1)]; [background addRepresentation:Render(view,2)];
  if (![[background TIFFRepresentation] writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]) return 3;
  view.preview = YES;
  if (![[Render(view,2) representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
      writeToFile:[NSString stringWithUTF8String:argv[2]] atomically:YES]) return 4;
} return 0; }
