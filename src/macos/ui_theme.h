#pragma once

static NSColor *NMUiCanvas(void) { return [NSColor colorWithCalibratedWhite:.965 alpha:1]; }
static NSColor *NMUiInk(void) { return [NSColor colorWithCalibratedRed:.11 green:.11 blue:.13 alpha:1]; }
static NSColor *NMUiMuted(void) { return [NSColor colorWithCalibratedRed:.43 green:.43 blue:.47 alpha:1]; }
static NSColor *NMUiBlue(void) { return [NSColor colorWithCalibratedRed:0 green:.44 blue:.96 alpha:1]; }
static NSColor *NMUiMeritGold(void) { return [NSColor colorWithCalibratedRed:.78 green:.39 blue:.12 alpha:1]; }

@interface NMUiCardButton : NSButton
@property(nonatomic) BOOL cardHovered;
@end
@implementation NMUiCardButton
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  for (NSTrackingArea *area in self.trackingAreas) [self removeTrackingArea:area];
  [self addTrackingArea:[[NSTrackingArea alloc] initWithRect:self.bounds
      options:NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
      owner:self userInfo:nil]];
}
- (void)mouseEntered:(NSEvent *)event { (void)event; self.cardHovered = YES; self.needsDisplay = YES; }
- (void)mouseExited:(NSEvent *)event { (void)event; self.cardHovered = NO; self.needsDisplay = YES; }
- (void)setState:(NSControlStateValue)value { [super setState:value]; self.needsDisplay = YES; }
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  const BOOL selected = self.state == NSControlStateValueOn;
  NSBezierPath *card = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 2, 2)
      xRadius:14 yRadius:14];
  [(selected ? [NSColor colorWithCalibratedRed:.91 green:.95 blue:1 alpha:1] :
      (self.cardHovered ? [NSColor colorWithCalibratedWhite:.97 alpha:1] : NSColor.whiteColor)) setFill];
  [card fill];
  [(selected ? NMUiBlue() : [NSColor colorWithCalibratedWhite:.88 alpha:1]) setStroke];
  card.lineWidth = selected ? 2 : 1; [card stroke];
  NSRect area = NSMakeRect(16, 42, NSWidth(self.bounds) - 32, NSHeight(self.bounds) - 58);
  NSImage *image = self.image;
  if (image && image.size.width > 0 && image.size.height > 0) {
    CGFloat scale = MIN(NSWidth(area) / image.size.width, NSHeight(area) / image.size.height);
    NSSize size = NSMakeSize(image.size.width * scale, image.size.height * scale);
    [image drawInRect:NSMakeRect(NSMidX(area) - size.width / 2, NSMidY(area) - size.height / 2,
        size.width, size.height) fromRect:NSZeroRect operation:NSCompositingOperationSourceOver
        fraction:1 respectFlipped:YES hints:@{NSImageHintInterpolation: @(NSImageInterpolationHigh)}];
  }
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.alignment = NSTextAlignmentCenter; paragraph.lineBreakMode = NSLineBreakByWordWrapping;
  [self.title drawInRect:NSMakeRect(8, 7, NSWidth(self.bounds) - 16, 34) withAttributes:@{
      NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightMedium],
      NSForegroundColorAttributeName:NMUiInk(), NSParagraphStyleAttributeName:paragraph}];
  if (self.window.firstResponder == self) {
    [NMUiBlue() setStroke]; NSBezierPath *focus = [NSBezierPath bezierPathWithRoundedRect:
        NSInsetRect(self.bounds, 5, 5) xRadius:11 yRadius:11]; focus.lineWidth = 2; [focus stroke];
  }
}
@end

static void NMUiView(NSView *view) {
  if ([view isKindOfClass:NSScrollView.class]) {
    NSScrollView *scroll = (NSScrollView *)view;
    scroll.drawsBackground = NO; scroll.scrollerStyle = NSScrollerStyleOverlay;
  }
  if ([view isKindOfClass:NSButton.class] && ![view isKindOfClass:NMUiCardButton.class]) {
    NSButton *button = (NSButton *)view;
    button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    if (![button isKindOfClass:NSPopUpButton.class] && button.bezelStyle != NSBezelStyleCircular)
      button.bezelStyle = NSBezelStyleRounded;
    if (@available(macOS 10.14, *)) button.contentTintColor = NMUiInk();
    if ([button.keyEquivalent isEqualToString:@"\r"]) {
      if (@available(macOS 10.14, *)) button.contentTintColor = NMUiBlue();
    }
  }
  for (NSView *child in view.subviews) NMUiView(child);
}
static void NMUiWindow(NSWindow *window) {
  window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  window.backgroundColor = NMUiCanvas(); window.titlebarAppearsTransparent = YES;
  window.hasShadow = YES; NMUiView(window.contentView);
}

@interface NMUiAlert : NSAlert
@end
@implementation NMUiAlert
- (NSModalResponse)runModal { [self layout]; NMUiWindow(self.window); return [super runModal]; }
@end

@interface NMUiCenteredAccessoryAlert : NMUiAlert
@end
@implementation NMUiCenteredAccessoryAlert
- (void)layout {
  [super layout];
  NSView *view = self.accessoryView;
  NSView *content = self.window.contentView;
  // NSAlert wraps accessories in a container beside its icon column.
  // Center that container, so the native wrapper does not retain a left bias.
  while (view.superview && view.superview != content) view = view.superview;
  if (view.superview == content) {
    NSRect frame = view.frame;
    frame.origin.x = (NSWidth(content.bounds) - NSWidth(frame)) / 2.0;
    view.frame = frame;
  }
}
@end

@interface NMUiBubbleView : NSView
@property(nonatomic) NSPoint companionPoint;
@end
@implementation NMUiBubbleView
- (BOOL)isOpaque { return NO; }
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  NSRect body = NSInsetRect(self.bounds, 6, 6);
  NSBezierPath *shape = [NSBezierPath bezierPathWithRoundedRect:body xRadius:18 yRadius:18];
  NSPoint target = self.companionPoint;
  NSBezierPath *tail = [NSBezierPath bezierPath];
  if (target.y < NSMinY(self.bounds) || target.y > NSMaxY(self.bounds)) {
    CGFloat x = MAX(NSMinX(body) + 24, MIN(NSMaxX(body) - 24, target.x));
    CGFloat y = target.y < 0 ? NSMinY(body) : NSMaxY(body);
    [tail moveToPoint:NSMakePoint(x - 7, y)]; [tail lineToPoint:NSMakePoint(x + 7, y)];
    [tail lineToPoint:NSMakePoint(x + 3, target.y < 0 ? 0 : NSHeight(self.bounds))];
  } else {
    CGFloat y = MAX(NSMinY(body) + 24, MIN(NSMaxY(body) - 24, target.y));
    CGFloat x = target.x < 0 ? NSMinX(body) : NSMaxX(body);
    [tail moveToPoint:NSMakePoint(x, y - 7)]; [tail lineToPoint:NSMakePoint(x, y + 7)];
    [tail lineToPoint:NSMakePoint(target.x < 0 ? 0 : NSWidth(self.bounds), y - 3)];
  }
  [tail closePath]; [NSColor.whiteColor setFill]; [shape fill]; [tail fill];
}
@end
