#import <QuartzCore/QuartzCore.h>

// Reuse a small glyph atlas like a clock: changing a number replaces only
// affected digit contents. No typesetting or bitmap drawing on each keypress.
@interface NMNumberLayer : CALayer
@property(nonatomic, copy) NSString *text;
@property(nonatomic, strong) NSMutableDictionary<NSString *,id> *glyphs;
@property(nonatomic, strong) NSMutableDictionary<NSString *,NSNumber *> *advances;
@property(nonatomic, strong) NSMutableArray<CALayer *> *digits;
@property(nonatomic) CGSize layoutSize;
@property(nonatomic) CGFloat textWidth;
@property(nonatomic) CGFloat atlasSize;
@property(nonatomic) CGFloat atlasScale;
@property(nonatomic, strong) NSColor *atlasColor;
- (BOOL)updateText:(NSString *)text size:(CGFloat)size color:(NSColor *)color;
@end
@implementation NMNumberLayer
- (BOOL)updateText:(NSString *)text size:(CGFloat)size color:(NSColor *)color {
  text=text ?: @"";
  CGFloat scale=MAX(1,self.contentsScale);
  BOOL rebuild=!self.glyphs || self.atlasSize!=size || self.atlasScale!=scale || ![self.atlasColor isEqual:color];
  if(!rebuild && [self.text isEqual:text]) return NO;
  if(rebuild) {
    self.glyphs=[NSMutableDictionary dictionary];self.advances=[NSMutableDictionary dictionary];
    self.atlasSize=size;self.atlasScale=scale;self.atlasColor=color;
    NSFont *font=[NSFont monospacedDigitSystemFontOfSize:size weight:NSFontWeightRegular];
    NSShadow *shadow=[NSShadow new];shadow.shadowColor=[NSColor colorWithWhite:0 alpha:.8];
    shadow.shadowOffset=NSMakeSize(0,-1);shadow.shadowBlurRadius=2;
    NSDictionary *attributes=@{NSFontAttributeName:font,NSForegroundColorAttributeName:color,
      NSStrokeColorAttributeName:[NSColor colorWithWhite:0 alpha:.7],NSStrokeWidthAttributeName:@(-2.5),NSShadowAttributeName:shadow};
    for(NSUInteger i=0;i<12;i++) {
      NSString *glyph=[@"0123456789:-" substringWithRange:NSMakeRange(i,1)];
      CGFloat advance=[glyph sizeWithAttributes:@{NSFontAttributeName:font}].width;
      NSInteger width=(NSInteger)ceil((advance+8)*scale),height=(NSInteger)ceil(40*scale);
      NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:height
        bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bitmapFormat:0 bytesPerRow:width*4 bitsPerPixel:32];
      NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
      [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=context;
      CGContextScaleCTM(context.CGContext,scale,scale);
      [glyph drawAtPoint:NSMakePoint(4,40-font.ascender+font.descender-2) withAttributes:attributes];
      [NSGraphicsContext restoreGraphicsState];
      self.glyphs[glyph]=(__bridge id)rep.CGImage;self.advances[glyph]=@(advance);
    }
  }
  if(!self.digits) self.digits=[NSMutableArray array];
  while(self.digits.count<text.length) { CALayer *digit=[CALayer layer];[self addSublayer:digit];[self.digits addObject:digit]; }
  while(self.digits.count>text.length) { [self.digits.lastObject removeFromSuperlayer];[self.digits removeLastObject]; }
  CGFloat total=0;for(NSUInteger i=0;i<text.length;i++)total+=[self.advances[[text substringWithRange:NSMakeRange(i,1)]] doubleValue];
  BOOL layout=rebuild || self.text.length!=text.length || !CGSizeEqualToSize(self.layoutSize,self.bounds.size) || self.textWidth!=total;
  self.layoutSize=self.bounds.size;self.textWidth=total;
  CGFloat x=(self.bounds.size.width-total)/2;
  for(NSUInteger i=0;i<text.length;i++) {
    NSString *glyph=[text substringWithRange:NSMakeRange(i,1)];CALayer *digit=self.digits[i];
    CGFloat advance=[self.advances[glyph] doubleValue];
    if(rebuild || i>=self.text.length || ![[self.text substringWithRange:NSMakeRange(i,1)] isEqual:glyph]) digit.contents=self.glyphs[glyph];
    if(layout) {digit.contentsScale=scale;digit.frame=CGRectMake(x-4,self.bounds.size.height-40,ceil((advance+8)*scale)/scale,40);}
    x+=advance;
  }
  self.text=[text copy];return YES;
}
@end

// A scene owns only the current picture set. Cached pixels are submitted once;
// Core Animation interpolates each scalar using the pack's original curve.
@interface NMLayerScene : NSObject
@property(nonatomic, strong) CALayer *root;
@property(nonatomic, strong) CALayer *artwork;
@property(nonatomic, strong) NMNumberLayer *counter;
@property(nonatomic, strong) CATextLayer *feedback;
@property(nonatomic, strong) CATextLayer *offworkLabel;
@property(nonatomic, strong) NMNumberLayer *offworkDuration;
@property(nonatomic, copy) NSArray<NSDictionary *> *descriptors;
@property(nonatomic, copy) NSArray<NSArray<CALayer *> *> *nodes;
@property(nonatomic, copy) NSArray<NSDictionary *> *animationTemplates;
@property(nonatomic, strong) CAKeyframeAnimation *feedbackTemplate;
@property(nonatomic) CGFloat layoutScale;
@property(nonatomic) CGFloat layoutBacking;
@property(nonatomic) CGFloat layoutOffset;
@property(nonatomic) BOOL layoutPreview;
@property(nonatomic) BOOL layoutValid;
@property(nonatomic) NSUInteger sceneGeneration;
@property(nonatomic) NSUInteger sceneBuilds;
@property(nonatomic) NSUInteger animationSubmissions;
@property(nonatomic) NSUInteger textUpdates;
- (instancetype)initWithRoot:(CALayer *)root;
- (void)installLayers:(NSArray<NSDictionary *> *)layers images:(NSDictionary<NSString *,NSImage *> *)images;
- (void)layoutWithScale:(CGFloat)scale backing:(CGFloat)backing offset:(CGFloat)offset preview:(BOOL)preview;
- (void)setCounter:(NSString *)counter label:(NSString *)label duration:(NSString *)duration;
- (void)play:(NSTimeInterval)duration;
- (void)play:(NSTimeInterval)duration atTime:(CFTimeInterval)start;
- (void)stop;
@end

static void NMNoImplicit(void (^changes)(void)) {
  [CATransaction begin]; [CATransaction setDisableActions:YES]; changes(); [CATransaction commit];
}
static CAKeyframeAnimation *NMScalarAnimation(NSDictionary *descriptor, NSString *property,
                                             NSString *field, double base, double factor,
                                             NSTimeInterval duration) {
  NSArray<NSDictionary *> *frames = descriptor[@"keyframes"];
  NSMutableArray *values = [NSMutableArray array], *times = [NSMutableArray array];
  NSMutableArray *curves = [NSMutableArray array];
  BOOL smooth = [descriptor[@"interpolation"] isEqual:@"smoothstep"];
  CAMediaTimingFunction *curve = smooth
      ? [CAMediaTimingFunction functionWithControlPoints:1.0f/3 :0 :2.0f/3 :1]
      : [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear];
  auto append = ^(double t, double value) {
    if (values.count) [curves addObject:curve];
    [times addObject:@(t)]; [values addObject:@(base + factor * value)];
  };
  double fallback = ([field isEqual:@"scale_y"] || [field isEqual:@"scale"]) ? 1 : 0;
  if ([frames.firstObject[@"t"] doubleValue] > 0)
    append(0, [(frames.firstObject[field] ?: @(fallback)) doubleValue]);
  for (NSDictionary *frame in frames) append([frame[@"t"] doubleValue], [(frame[field] ?: @(fallback)) doubleValue]);
  if ([times.lastObject doubleValue] < 1) append(1, [(frames.lastObject[field] ?: @(fallback)) doubleValue]);
  if (values.count == 1) append(1, [(frames.firstObject[field] ?: @(fallback)) doubleValue]);
  CAKeyframeAnimation *animation = [CAKeyframeAnimation animationWithKeyPath:property];
  animation.values = values; animation.keyTimes = times; animation.timingFunctions = curves;
  animation.duration = duration; animation.calculationMode = kCAAnimationLinear;
  animation.removedOnCompletion = YES;
  return animation;
}
static CATextLayer *NMSceneText(CGRect frame, CGFloat size, NSColor *color) {
  CATextLayer *layer = [CATextLayer layer]; layer.frame = frame;
  layer.fontSize = size; layer.alignmentMode = kCAAlignmentCenter;
  layer.foregroundColor = color.CGColor;
  layer.shadowColor = NSColor.blackColor.CGColor; layer.shadowOpacity = .8;
  layer.shadowOffset = CGSizeMake(0,-1); layer.shadowRadius = 2;
  return layer;
}
static void NMSetSceneText(CATextLayer *layer, NSString *value, CGFloat size, NSColor *color) {
  layer.string = value.length ? [[NSAttributedString alloc] initWithString:value attributes:@{
    NSFontAttributeName:[NSFont monospacedDigitSystemFontOfSize:size weight:NSFontWeightRegular],
    NSForegroundColorAttributeName:color,
    NSStrokeColorAttributeName:[NSColor colorWithWhite:0 alpha:.7], NSStrokeWidthAttributeName:@(-2.5)
  }] : nil;
}
@implementation NMLayerScene
- (instancetype)initWithRoot:(CALayer *)root {
  if ((self = [super init])) {
    _root = [CALayer layer]; _root.anchorPoint = CGPointZero; _root.position = CGPointZero;
    [root addSublayer:_root];
    _artwork = [CALayer layer]; _artwork.frame = CGRectMake(0,0,240,170); _artwork.masksToBounds = YES;
    [_root addSublayer:_artwork];
    _counter = [NMNumberLayer layer];_counter.frame=CGRectMake(0,210,240,40);
    _feedback = NMSceneText(CGRectMake(0,174,240,30),23,NSColor.orangeColor); _feedback.opacity = 0;
    NMSetSceneText(_feedback,@"+1",23,[NSColor colorWithCalibratedRed:.94 green:.50 blue:.16 alpha:1]);
    _feedbackTemplate=[CAKeyframeAnimation animationWithKeyPath:@"opacity"];
    _feedbackTemplate.values=@[@0,@1,@0,@0];_feedbackTemplate.keyTimes=@[@0,@.30,@.70,@1];
    _feedbackTemplate.calculationMode=kCAAnimationDiscrete;
    _offworkLabel = NMSceneText(CGRectMake(0,55,240,28),24,NSColor.orangeColor);
    _offworkDuration = [NMNumberLayer layer];_offworkDuration.frame=CGRectMake(0,14,240,35);
    for (CALayer *layer in @[_counter,_feedback,_offworkLabel,_offworkDuration]) [_root addSublayer:layer];
  } return self;
}
- (void)installLayers:(NSArray<NSDictionary *> *)layers images:(NSDictionary<NSString *,NSImage *> *)images {
  [self stop]; self.sceneGeneration++; self.sceneBuilds++;
  NMNoImplicit(^{ self.artwork.sublayers = nil; });
  NSMutableArray *nodes = [NSMutableArray array];
  for (NSDictionary *descriptor in layers) {
    NSArray *frame = descriptor[@"frame"], *anchor = descriptor[@"anchor"];
    double w=[frame[2] doubleValue], h=[frame[3] doubleValue];
    double ax=w*[anchor[0] doubleValue], ay=h*[anchor[1] doubleValue];
    CALayer *position=[CALayer layer], *rotation=[CALayer layer], *scale=[CALayer layer], *stretch=[CALayer layer];
    CALayer *image=[CALayer layer]; image.anchorPoint=CGPointZero;
    image.frame=CGRectMake(-ax,-ay,w,h);
    NSImage *source=images[descriptor[@"image"]];
    CGImageRef pixels=[source CGImageForProposedRect:NULL context:nil hints:nil];
    image.contents=(__bridge id)pixels; image.contentsGravity=kCAGravityResize;
    image.minificationFilter=kCAFilterTrilinear; image.magnificationFilter=kCAFilterLinear;
    if ([descriptor[@"contentsRect"] isKindOfClass:NSArray.class]) {
      NSArray *r=descriptor[@"contentsRect"];
      image.contentsRect=CGRectMake([r[0] doubleValue],[r[1] doubleValue],[r[2] doubleValue],[r[3] doubleValue]);
    }
    if ([descriptor[@"flip"] boolValue]) image.transform=CATransform3DMakeScale(1,-1,1);
    [stretch addSublayer:image]; [scale addSublayer:stretch]; [rotation addSublayer:scale];
    [position addSublayer:rotation]; [self.artwork addSublayer:position];
    [nodes addObject:@[position,rotation,scale,stretch]];
  }
  self.descriptors=layers; self.nodes=nodes; [self applyRestPose];
  NSMutableArray *templates=[NSMutableArray array];
  [self.nodes enumerateObjectsUsingBlock:^(NSArray<CALayer *> *node,NSUInteger i,BOOL *) {
    NSDictionary *d=self.descriptors[i];NSArray *r=d[@"frame"],*a=d[@"anchor"];
    double ax=[r[0] doubleValue]+[r[2] doubleValue]*[a[0] doubleValue];
    double ay=[r[1] doubleValue]+[r[3] doubleValue]*[a[1] doubleValue];
    NSArray *specs=@[@[@0,@"position.x",@"x",@(ax),@1],@[@0,@"position.y",@"y",@(ay),@1],
      @[@0,@"opacity",@"alpha",@0,@1],@[@1,@"transform.rotation.z",@"rotation",@0,@(M_PI/180)],
      @[@2,@"transform.scale",@"scale",@0,@1],@[@3,@"transform.scale.y",@"scale_y",@0,@1]];
    for(NSArray *spec in specs) {
      CAKeyframeAnimation *animation=NMScalarAnimation(d,spec[1],spec[2],[spec[3] doubleValue],[spec[4] doubleValue],1);
      BOOL constant=YES;for(NSNumber *v in animation.values) if(![v isEqual:animation.values.firstObject]) {constant=NO;break;}
      if(!constant) [templates addObject:@{@"layer":node[[spec[0] unsignedIntegerValue]],@"animation":animation,@"key":spec[1]}];
    }
  }];self.animationTemplates=templates;
}
- (void)layoutWithScale:(CGFloat)scale backing:(CGFloat)backing offset:(CGFloat)offset preview:(BOOL)preview {
  if(self.layoutValid && self.layoutScale==scale && self.layoutBacking==backing && self.layoutOffset==offset && self.layoutPreview==preview) return;
  self.layoutValid=YES;self.layoutScale=scale;self.layoutBacking=backing;self.layoutOffset=offset;self.layoutPreview=preview;
  NMNoImplicit(^{
    self.root.affineTransform=CGAffineTransformMakeScale(scale,scale);
    self.root.bounds=CGRectMake(0,0,240,250+offset);
    self.artwork.frame=CGRectMake(0,offset,240,170);
    self.counter.frame=CGRectMake(0,210+offset,240,40);
    self.feedback.frame=CGRectMake(0,174+offset,240,30);
    self.counter.hidden=preview; self.feedback.hidden=preview;
    self.offworkLabel.hidden=preview || offset==0; self.offworkDuration.hidden=preview || offset==0;
    for (CALayer *layer in @[self.counter,self.feedback,self.offworkLabel,self.offworkDuration])
      layer.contentsScale=MAX(1,backing*scale);
  });
}
- (void)setCounter:(NSString *)counter label:(NSString *)label duration:(NSString *)duration {
  NSColor *color=[NSColor colorWithCalibratedRed:.78 green:.39 blue:.12 alpha:1];
  NMNoImplicit(^{
    if([self.counter updateText:counter size:counter.length>18?22:26 color:color]) self.textUpdates++;
    if([self.offworkDuration updateText:duration size:24 color:color]) self.textUpdates++;
    NSString *old=[self.offworkLabel.string isKindOfClass:NSAttributedString.class] ? [self.offworkLabel.string string] : self.offworkLabel.string;
    if(![old isEqual:label ?: @""]) { NMSetSceneText(self.offworkLabel,label,24,color);self.textUpdates++; }
  });
}

- (void)applyRestPose {
  NMNoImplicit(^{
    [self.feedback removeAllAnimations]; self.feedback.opacity=0;
    [self.nodes enumerateObjectsUsingBlock:^(NSArray<CALayer *> *node, NSUInteger i, BOOL *) {
      NSDictionary *d=self.descriptors[i]; NSArray *r=d[@"frame"],*a=d[@"anchor"];
      NSDictionary *f=NMFrameAtPhase(d[@"keyframes"],0,[d[@"interpolation"] isEqual:@"smoothstep"]);
      for (CALayer *layer in node) [layer removeAllAnimations];
      node[0].position=CGPointMake([r[0] doubleValue]+[r[2] doubleValue]*[a[0] doubleValue]+[f[@"x"] doubleValue],
                                   [r[1] doubleValue]+[r[3] doubleValue]*[a[1] doubleValue]+[f[@"y"] doubleValue]);
      node[0].opacity=[f[@"alpha"] floatValue];
      node[1].transform=CATransform3DMakeRotation([f[@"rotation"] doubleValue]*M_PI/180,0,0,1);
      node[2].transform=CATransform3DMakeScale([f[@"scale"] doubleValue],[f[@"scale"] doubleValue],1);
      node[3].transform=CATransform3DMakeScale(1,[(f[@"scale_y"] ?: @1) doubleValue],1);
    }];
  });
}
- (void)stop {
  [self.feedback removeAllAnimations];
  for(NSArray<CALayer *> *node in self.nodes) for(CALayer *layer in node)
    if(layer.animationKeys.count) [layer removeAllAnimations];
}
- (void)play:(NSTimeInterval)duration { [self play:duration atTime:CACurrentMediaTime()]; }
- (void)play:(NSTimeInterval)duration atTime:(CFTimeInterval)start {
  self.animationSubmissions++;
  for(NSDictionary *item in self.animationTemplates) {
    CAKeyframeAnimation *animation=item[@"animation"];animation.duration=duration;
    animation.beginTime=[item[@"layer"] convertTime:start fromLayer:nil];
    [item[@"layer"] addAnimation:animation forKey:item[@"key"]];
  }
  self.feedbackTemplate.duration=duration;
  self.feedbackTemplate.beginTime=[self.feedback convertTime:start fromLayer:nil];
  [self.feedback addAnimation:self.feedbackTemplate forKey:@"feedback"];
}
@end
