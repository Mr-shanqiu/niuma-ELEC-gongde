// Only visible cards retain thumbnails. One serial worker validates and prepares
// small images; scrolling cancels queued work and invalidates obsolete results.
@interface NMThumbnailGrid : NSView
@property(nonatomic, copy) NSArray<NSDictionary *> *items;
@property(nonatomic, copy) NSArray<NSButton *> *buttons;
@property(nonatomic, strong) NSOperationQueue *worker;
@property(nonatomic, strong) NSMutableDictionary<NSString *,NSImage *> *cache;
@property(nonatomic, strong) NSMutableArray<NSString *> *order;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger cachedBytes;
- (void)refreshThumbnails:(NSNotification *)notification;
- (void)discardCache;
@end
@implementation NMThumbnailGrid
- (instancetype)initWithFrame:(NSRect)frame {
  if ((self=[super initWithFrame:frame])) {
    self.worker=[NSOperationQueue new]; self.worker.maxConcurrentOperationCount=1;
    self.worker.qualityOfService=NSQualityOfServiceUtility;
    self.cache=[NSMutableDictionary dictionary]; self.order=[NSMutableArray array];
  } return self;
}
- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [NSNotificationCenter.defaultCenter removeObserver:self];
  NSClipView *clip=self.enclosingScrollView.contentView;
  clip.postsBoundsChangedNotifications=YES;
  if (clip) [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(refreshThumbnails:)
      name:NSViewBoundsDidChangeNotification object:clip];
  [self refreshThumbnails:nil];
}
- (void)refreshThumbnails:(NSNotification *)notification {
  (void)notification;
  NSUInteger generation=++self.generation; [self.worker cancelAllOperations];
  NSRect visible=self.visibleRect;
  for (NSUInteger i=0;i<self.buttons.count;i++) {
    NSButton *button=self.buttons[i]; NSDictionary *item=self.items[i];
    if (!self.window || !NSIntersectsRect(visible,button.frame)) { button.image=nil; continue; }
    NMAppearancePack *metadata=item[@"pack"];
    if (!metadata) { button.image=item[@"thumbnail"]; continue; }
    NSString *key=[NSString stringWithFormat:@"%@:%@",metadata.identifier,metadata.contentFingerprint];
    NSImage *cached=self.cache[key];
    if (cached) {
      button.image=cached; [self.order removeObject:key]; [self.order addObject:key]; continue;
    }
    button.image=nil;
    __weak NMThumbnailGrid *weakSelf=self;
    [self.worker addOperationWithBlock:^{ @autoreleasepool {
      NSError *error=nil;
      NSImage *image=[NMAppearancePackStore thumbnailForPack:metadata pixels:256 error:&error];
      dispatch_async(dispatch_get_main_queue(), ^{
        NMThumbnailGrid *grid=weakSelf;
        if (!grid || generation!=grid.generation || !grid.window || !image) return;
        CGImageRef pixels=[image CGImageForProposedRect:NULL context:nil hints:nil];
        NSUInteger cost=CGImageGetBytesPerRow(pixels)*CGImageGetHeight(pixels);
        const NSUInteger limit=12*256*256*4;
        if (cost>limit) return;
        while (grid.order.count && (grid.order.count>=12 || grid.cachedBytes+cost>limit)) {
          NSString *old=grid.order.firstObject; NSImage *oldImage=grid.cache[old];
          CGImageRef oldPixels=[oldImage CGImageForProposedRect:NULL context:nil hints:nil];
          grid.cachedBytes-=CGImageGetBytesPerRow(oldPixels)*CGImageGetHeight(oldPixels);
          [grid.cache removeObjectForKey:old]; [grid.order removeObjectAtIndex:0];
        }
        grid.cache[key]=image; [grid.order addObject:key]; grid.cachedBytes+=cost;
        if (NSIntersectsRect(grid.visibleRect,button.frame)) button.image=image;
      });
    }}];
  }
}
- (void)discardCache {
  ++self.generation;[self.worker cancelAllOperations];
  for(NSButton *button in self.buttons) button.image=nil;
  [self.cache removeAllObjects];[self.order removeAllObjects];self.cachedBytes=0;
}
- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self]; [self.worker cancelAllOperations];
}
@end
