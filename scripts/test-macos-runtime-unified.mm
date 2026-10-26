#define NIUMA_MAC_REFERENCE_RENDERER 1
#define main NiumaUnusedEntry
#import "../src/macos/app.mm"
#undef main
#import <mach/mach.h>
#include <cassert>
#include <thread>

static NSString *output;
static void RunFor(double seconds) {
  NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds];
  while(end.timeIntervalSinceNow>0) { [NSApp updateWindows];[NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:end]; }
}
static void WaitFor(BOOL (^ready)(void),double seconds) {
  NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds];while(!ready() && end.timeIntervalSinceNow>0) RunFor(.01);assert(ready());
}
static NSBitmapImageRep *Render(MeritView *view,BOOL reference) {
  NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:240 pixelsHigh:250 bitsPerSample:8
      samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bitmapFormat:0 bytesPerRow:960 bitsPerPixel:32];
  NSGraphicsContext *context=[NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [NSGraphicsContext saveGraphicsState];NSGraphicsContext.currentContext=context;
  CGContextScaleCTM(context.CGContext,2,2);
  if(reference && view.appearancePack) {
    // Independent raster reference for manifest geometry. AppKit's lazy NSImage
    // draw path does not produce package pixels in this bitmap-only harness;
    // do not mislabel that blank capture as the old running application.
    CGContextRef cg=context.CGContext;CGContextScaleCTM(cg,.5,.5);
    CGContextClipToRect(cg,CGRectMake(0,0,240,170));
    for(NSDictionary *layer in view.appearancePack.layers) {
      NSArray *r=layer[@"frame"],*a=layer[@"anchor"];
      NSDictionary *f=NMFrameAtPhase(layer[@"keyframes"],0,[layer[@"interpolation"] isEqual:@"smoothstep"]);
      CGRect rect=CGRectMake([r[0] doubleValue],[r[1] doubleValue],[r[2] doubleValue],[r[3] doubleValue]);
      double ax=rect.origin.x+rect.size.width*[a[0] doubleValue],ay=rect.origin.y+rect.size.height*[a[1] doubleValue];
      CGContextSaveGState(cg);CGContextTranslateCTM(cg,ax+[f[@"x"] doubleValue],ay+[f[@"y"] doubleValue]);
      CGContextRotateCTM(cg,[f[@"rotation"] doubleValue]*M_PI/180);
      CGContextScaleCTM(cg,[f[@"scale"] doubleValue],[f[@"scale"] doubleValue]*[(f[@"scale_y"] ?: @1) doubleValue]);
      CGContextTranslateCTM(cg,-ax,-ay);CGContextSetAlpha(cg,[f[@"alpha"] doubleValue]);
      NSImage *image=view.appearancePack.images[layer[@"image"]];
      CGContextDrawImage(cg,rect,[image CGImageForProposedRect:NULL context:nil hints:nil]);CGContextRestoreGState(cg);
    }
  }else if(reference) [view drawReferenceRect:view.bounds];else { [view syncPresentation]; [view.layer renderInContext:context.CGContext]; }
  [NSGraphicsContext restoreGraphicsState];return rep;
}
static void Save(NSBitmapImageRep *rep,NSString *name) {
  assert([[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[output stringByAppendingPathComponent:name] atomically:YES]);
}
static void SnapshotView(NSView *view,NSString *name) {
  NSBitmapImageRep *rep=[view bitmapImageRepForCachingDisplayInRect:view.bounds];[view cacheDisplayInRect:view.bounds toBitmapImageRep:rep];Save(rep,name);
}
static double CpuSeconds(void) {
  task_thread_times_info_data_t threads{};mach_msg_type_number_t count=TASK_THREAD_TIMES_INFO_COUNT;
  assert(task_info(mach_task_self(),TASK_THREAD_TIMES_INFO,(task_info_t)&threads,&count)==KERN_SUCCESS);
  task_basic_info_data_t basic{};count=TASK_BASIC_INFO_COUNT;
  assert(task_info(mach_task_self(),TASK_BASIC_INFO,(task_info_t)&basic,&count)==KERN_SUCCESS);
  return threads.user_time.seconds+threads.user_time.microseconds/1e6+threads.system_time.seconds+threads.system_time.microseconds/1e6+
      basic.user_time.seconds+basic.user_time.microseconds/1e6+basic.system_time.seconds+basic.system_time.microseconds/1e6;
}
static NSDictionary *Memory(void) {
  task_vm_info_data_t info{};mach_msg_type_number_t count=TASK_VM_INFO_COUNT;
  assert(task_info(mach_task_self(),TASK_VM_INFO,(task_info_t)&info,&count)==KERN_SUCCESS);
  return @{@"footprint":@(info.phys_footprint),@"resident":@(info.resident_size)};
}
@interface UnifiedController : MeritController
- (void)hidden:(BOOL)hidden fullscreen:(BOOL)fullscreen;
@end
@implementation UnifiedController
- (BOOL)hasLiveEventTap { return YES; } // Private capture drives the production input mailbox, never global input.
- (void)hidden:(BOOL)hidden fullscreen:(BOOL)fullscreen {
  _visibility.recoveryAvailable=true;_visibility.manualHidden=hidden;_visibility.fullscreen=fullscreen;[self applyAppearanceVisibility];
}
@end

static void TestMailbox(void) {
  NMInputMailbox *mailbox=[[NMInputMailbox alloc] initWithTotal:12345];
  time_t wall=1793016000;
  for(int i=0;i<10000;i++) [mailbox record:kCGEventKeyDown wall:wall uptime:10+i*.0001];
  NSDictionary *s=[mailbox take];assert([s[@"keys"] intValue]==10000);
  assert([[(NSDictionary *)s[@"days"] allValues].firstObject intValue]==10000);
  assert([(NSDictionary *)[mailbox take][@"days"] count]==0);
  [mailbox record:kCGEventScrollWheel wall:wall uptime:30];
  [mailbox record:kCGEventScrollWheel wall:wall uptime:30.1];
  [mailbox record:kCGEventScrollWheel wall:wall+86400 uptime:30.4];
  s=[mailbox take];assert([s[@"scrolls"] intValue]==3 && [(NSDictionary *)s[@"days"] count]==2);
  long long sum=0;for(NSNumber *n in [(NSDictionary *)s[@"days"] allValues]) sum+=n.longLongValue;assert(sum==2);
  mailbox=[[NMInputMailbox alloc] initWithTotal:LLONG_MAX-1];
  [mailbox record:kCGEventKeyDown wall:wall uptime:1];[mailbox record:kCGEventKeyDown wall:wall uptime:2];
  s=[mailbox take];assert([s[@"keys"] intValue]==2 && [[(NSDictionary *)s[@"days"] allValues].firstObject intValue]==1);
  // The dedicated receiver stops and joins even if its run loop has just started.
  for(int i=0;i<8;i++) {
    CFRunLoopSourceContext context{};CFRunLoopSourceRef source=CFRunLoopSourceCreate(NULL,0,&context);
    NMEventTapThread *thread=[[NMEventTapThread alloc] initWithSource:source];[thread stop];CFRelease(source);
  }
}
static void TestAnimation(MeritView *view) {
  [view syncPresentation];NSUInteger builds=view.renderer.sceneBuilds;
  [view.renderer play:.2];
  for(NSArray<CALayer *> *node in view.renderer.nodes) for(NSUInteger n=0;n<node.count;n++) assert(node[n].animationKeys.count<=(n==0?3:1));
  [view.renderer stop];for(NSArray<CALayer *> *node in view.renderer.nodes) for(CALayer *layer in node) assert(layer.animationKeys.count==0);
  for(int i=0;i<100;i++) [view syncPresentation];assert(view.renderer.sceneBuilds==builds);
  NSDictionary *d=@{@"keyframes":@[@{@"t":@0,@"x":@0},@{@"t":@1,@"x":@10}],@"interpolation":@"smoothstep"};
  CAKeyframeAnimation *a=NMScalarAnimation(d,@"position.x",@"x",0,1,.2);
  float p[2]{};[a.timingFunctions.firstObject getControlPointAtIndex:1 values:p];assert(fabs(p[0]-1.0/3)<1e-6 && p[1]==0);
  [a.timingFunctions.firstObject getControlPointAtIndex:2 values:p];assert(fabs(p[0]-2.0/3)<1e-6 && p[1]==1);
}
static void TestTiming(MeritView *view) {
  CALayer *art=view.renderer.artwork;
  NMNoImplicit(^{art.speed=0;art.timeOffset=10;});[view.renderer play:1];
  for(NSArray<CALayer *> *node in view.renderer.nodes) for(CALayer *layer in node) for(NSString *key in layer.animationKeys) {
    CAAnimation *animation=[[layer animationForKey:key] copy];animation.beginTime=10;[layer addAnimation:animation forKey:key];
  }
  [CATransaction flush];RunFor(.05);
  for(NSNumber *phase in @[@.13,@.42,@.79]) {
    NMNoImplicit(^{art.timeOffset=10+phase.doubleValue;});[CATransaction flush];RunFor(.04);
    [view.renderer.nodes enumerateObjectsUsingBlock:^(NSArray<CALayer *> *node,NSUInteger i,BOOL *) {
      CALayer *present=node[0].presentationLayer;assert(present);
      NSDictionary *d=view.renderer.descriptors[i],*f=NMFrameAtPhase(d[@"keyframes"],phase.doubleValue,[d[@"interpolation"] isEqual:@"smoothstep"]);
      NSArray *r=d[@"frame"],*a=d[@"anchor"];
      double x=[r[0] doubleValue]+[r[2] doubleValue]*[a[0] doubleValue]+[f[@"x"] doubleValue];
      double y=[r[1] doubleValue]+[r[3] doubleValue]*[a[1] doubleValue]+[f[@"y"] doubleValue];
      if(fabs(present.position.x-x)>.02 || fabs(present.position.y-y)>.02) {
        fprintf(stderr,"timing mismatch %s phase=%g layer=%lu actual=%g,%g expected=%g,%g\n",view.appearancePack.identifier.UTF8String,phase.doubleValue,(unsigned long)i,present.position.x,present.position.y,x,y);
      }
      assert(fabs(present.position.x-x)<=.02 && fabs(present.position.y-y)<=.02);
      assert(fabs(present.opacity-[f[@"alpha"] doubleValue])<=.002);
    }];
  }
  [view.renderer stop];NMNoImplicit(^{art.timeOffset=0;art.speed=1;});
}
static void Lifecycle(UnifiedController *c,NSArray<NMAppearancePack *> *catalog) {
  NSMutableArray *samples=[NSMutableArray array];
  const double duration=900;double start=CACurrentMediaTime(),nextInput=start,nextSample=start,nextSwitch=start+5,nextWindows=start+10,closeWindows=0;
  NSUInteger commands=0,cycle=0;long long initial=c.total;NSWindow *gridWindow=nil;
  BOOL wasHidden=NO,hadOffwork=NO;
  while(CACurrentMediaTime()-start<duration) { @autoreleasepool {
    double now=CACurrentMediaTime(),elapsed=now-start;
    while(now>=nextInput) { [c captureInputType:kCGEventKeyDown];[c captureInputType:kCGEventKeyUp];++commands;nextInput+=.2; }
    BOOL hidden=((int)(elapsed/20)%3)==1;
    if(hidden!=wasHidden) {[c hidden:hidden fullscreen:NO];wasHidden=hidden;}
    BOOL offwork=((int)(elapsed/120)%2)==1;
    if(offwork!=hadOffwork) {
      c.offworkEnabled=offwork;[c startOffworkTimer];hadOffwork=offwork;
    }
    if(now>=nextSwitch) { [c applyAppearanceId:catalog[(cycle++)%catalog.count].identifier];nextSwitch+=30; }
    if(now>=nextWindows) {
      if(!c.calendarWindow) {
        c.calendarView=[[MeritCalendarView alloc] initWithFrame:NSMakeRect(0,0,720,724)];c.calendarView.controller=c;
        c.calendarView.previousButton=[NSButton new];c.calendarView.nextButton=[NSButton new];[c.calendarView showCurrentMonth];
        c.calendarWindow=[[NSWindow alloc] initWithContentRect:c.calendarView.bounds styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        c.calendarWindow.releasedWhenClosed=NO;c.calendarWindow.contentView=c.calendarView;
        [c.calendarWindow setFrameOrigin:NSMakePoint(-10000,-10000)];
      }
      [c.calendarWindow orderFront:nil];
      NSView *grid=[c appearanceGrid];gridWindow=[[NSWindow alloc] initWithContentRect:grid.bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
      gridWindow.releasedWhenClosed=NO;gridWindow.contentView=grid;[gridWindow setFrameOrigin:NSMakePoint(-10000,-10000)];[gridWindow orderFront:nil];
      closeWindows=now+2;nextWindows+=60;
    }
    if(closeWindows && now>=closeWindows) {
      [gridWindow close];gridWindow.contentView=nil;gridWindow=nil;c.appearanceButtons=nil;c.appearanceItems=nil;
      [c.calendarWindow close];closeWindows=0;
    }
    if(now>=nextSample) {
      [c drainInput];
      for(NMAppearancePack *pack in catalog) assert(pack.metadataOnly && !pack.images.count && !pack.previewImage);
      assert(c.view.renderer.nodes.count<=6 && c.view.renderer.counter.glyphs.count<=12 && c.view.renderer.counter.digits.count<=32);
      NSDictionary *sample=@{@"elapsedSeconds":@(elapsed),@"memory":Memory(),@"commands":@(commands),@"count":@(c.total),
        @"scene":c.selectedAppearanceId,@"sceneBuilds":@(c.view.renderer.sceneBuilds),@"graphNodes":@(c.view.renderer.nodes.count),
        @"hidden":@(c.appearanceHidden),@"loading":@(c.resourceLoadBusy),@"thumbnailBytes":@(c.thumbnailGrid.cachedBytes)};
      [samples addObject:sample];
      NSData *progress=[NSJSONSerialization dataWithJSONObject:@{@"completed":@NO,@"samples":samples} options:NSJSONWritingPrettyPrinted error:nil];
      assert([progress writeToFile:[output stringByAppendingPathComponent:@"lifecycle-progress.json"] atomically:YES]);
      if(samples.count%4==1) { printf("LIFECYCLE %.0fs commands=%lu footprint=%llu\n",elapsed,(unsigned long)commands,[sample[@"memory"][@"footprint"] unsignedLongLongValue]);fflush(stdout); }
      nextSample+=15;
    }
    RunFor(MIN(.2,MAX(.001,nextInput-CACurrentMediaTime())));
  }}
  if(gridWindow){[gridWindow close];gridWindow.contentView=nil;}[c.calendarWindow close];
  [c drainInput];assert(c.total==initial+(long long)commands);[c saveState];
  UnifiedController *reopened=[UnifiedController new];[reopened loadState];assert(reopened.total==c.total);
  NSData *result=[NSJSONSerialization dataWithJSONObject:@{@"completed":@YES,@"durationSeconds":@(duration),@"commands":@(commands),
    @"countsPreserved":@YES,@"sceneSwitches":@(cycle),@"samples":samples,@"realUserData":@NO,@"globalInput":@NO,
    @"scope":@"15-minute private-input lifecycle, calendar/gallery open-close without focus, not a multi-day leak proof"} options:NSJSONWritingPrettyPrinted error:nil];
  assert([result writeToFile:[output stringByAppendingPathComponent:@"lifecycle.json"] atomically:YES]);
}
static void Performance(UnifiedController *controller,NSArray<NMAppearancePack *> *catalog) {
  NSMutableArray *rows=[NSMutableArray array];
  NSArray *names=@[@"woodfish-idle",@"woodfish-active",@"wealth-active",@"offwork-active",@"hidden-active"];
  NSString *scope=NSProcessInfo.processInfo.environment[@"NIUMA_MAC_PERF_SCOPE"];
  if([scope isEqual:@"active"]) names=@[@"woodfish-active",@"wealth-active",@"offwork-active"];
  if([scope isEqual:@"profile"]) names=@[@"woodfish-active"];
  if([scope isEqual:@"all"]) {
    NSMutableArray *all=[NSMutableArray arrayWithObject:@"woodfish-active"];
    for(NMAppearancePack *p in catalog) [all addObject:[@"pack:" stringByAppendingString:p.identifier]];names=all;
  }
  for(NSString *name in names) {
    [controller stopAnimation];[controller hidden:NO fullscreen:NO];
    if([name hasPrefix:@"pack:"]) {
      NSString *identifier=[name substringFromIndex:5];[controller applyAppearanceId:identifier];
      WaitFor(^{return !controller.resourceLoadBusy;},20);assert([controller.selectedAppearanceId isEqual:identifier]);
    } else if([name hasPrefix:@"wealth"]) {
      NMAppearancePack *pack=nil;for(NMAppearancePack *p in catalog) if([p.identifier containsString:@"wealth"]) pack=p;
      assert(pack);[controller applyAppearanceId:pack.identifier];WaitFor(^{return !controller.resourceLoadBusy;},15);
    } else [controller applyAppearanceId:@"builtin.woodfish"];
    controller.offworkEnabled=[name hasPrefix:@"offwork"] || [name hasPrefix:@"hidden"];
    if(controller.offworkEnabled) [controller startOffworkTimer];else { [controller.offworkTimer invalidate];controller.offworkTimer=nil; }
    [controller stopAnimation];if([name hasPrefix:@"hidden"]) [controller hidden:YES fullscreen:NO];RunFor(.5);
    BOOL active=[scope isEqual:@"all"] || [name containsString:@"active"];
    double duration=[scope isEqual:@"all"] ? 3 : [scope isEqual:@"profile"] ? 10 : active?60:30;double start=CACurrentMediaTime(),previous=start,oldCpu=CpuSeconds(),nextInput=start;
    NSMutableArray *samples=[NSMutableArray array];NSUInteger submissions=controller.view.renderer.animationSubmissions;
    while(CACurrentMediaTime()-start<duration) {
      double now=CACurrentMediaTime();
      if(active && now>=nextInput) { [controller captureInputType:kCGEventKeyDown];[controller captureInputType:kCGEventKeyUp];nextInput+=.2; }
      double wake=MIN(start+duration,previous+1);
      if(active) wake=MIN(wake,nextInput);
      RunFor(MAX(.001,wake-CACurrentMediaTime()));now=CACurrentMediaTime();
      if(now-previous>=1) { double cpu=CpuSeconds();[samples addObject:@((cpu-oldCpu)/(now-previous)*100)];oldCpu=cpu;previous=now; }
    }
    [controller drainInput];NSArray *sorted=[samples sortedArrayUsingSelector:@selector(compare:)];double sum=0;for(NSNumber *n in samples)sum+=n.doubleValue;
    NSDictionary *row=@{@"stage":name,@"seconds":@(duration),@"singleCoreCpuMean":@(sum/samples.count),
      @"singleCoreCpuP95":sorted[MIN(sorted.count-1,(NSUInteger)floor(sorted.count*.95))],@"singleCoreCpuMax":sorted.lastObject,
      @"samples":samples,@"memory":Memory(),@"sceneBuilds":@(controller.view.renderer.sceneBuilds),
      @"animationSubmissions":@(controller.view.renderer.animationSubmissions-submissions)};
    [rows addObject:row];printf("PERF %s %.4f%%\n",name.UTF8String,sum/samples.count);fflush(stdout);
  }
  NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"stages":rows,@"logicalCpus":@(NSProcessInfo.processInfo.processorCount),
     @"cpuConvention":@"one core = 100%; private 5Hz commands, actual scene renderer; no global input"} options:NSJSONWritingPrettyPrinted error:nil];
  assert([json writeToFile:[output stringByAppendingPathComponent:[scope isEqual:@"all"]?@"all-scene-performance.json":([scope isEqual:@"profile"]?@"profile-performance.json":([scope isEqual:@"active"]?@"cached-animation-performance.json":@"performance.json"))] atomically:YES]);
  [controller.offworkTimer invalidate];controller.offworkTimer=nil;[controller hidden:NO fullscreen:NO];
}
int main(int argc,char **argv) { @autoreleasepool {
  assert(argc>=3);output=[NSString stringWithUTF8String:argv[2]];
  gIsolatedAcceptance=YES;gAcceptancePreferences=[NMEphemeralMeritPreferences new];
  [NSApplication sharedApplication];
  NSString *root=[NSString stringWithUTF8String:argv[1]];
  assert([root isEqual:[output stringByAppendingPathComponent:@"profile/AppearancePacks"]]);
  setenv("NIUMA_PACK_ROOT",root.UTF8String,1);
  NSString *today=DateKeyForDate(NSDate.date);
  [MeritPreferences() setInteger:12345 forKey:kTotal];
  [MeritPreferences() setObject:@{@"2020-01-01":@77,today:@23} forKey:kDailyTotals];
  [MeritPreferences() setObject:@{@"2020-01-01":@{@"seconds":@4818,@"targetMinutes":@1080,@"sampledAt":@1577919600}} forKey:kOffworkDailySnapshots];
  [MeritPreferences() setObject:@"retained" forKey:@"unknownFutureField"];
  TestMailbox();
  BOOL importTested=NO;
  const char *archivePath=getenv("NIUMA_MAC_SIGNED_PACK");
  if(archivePath) {
    NSString *importRoot=[output stringByAppendingPathComponent:@"import-profile/AppearancePacks"];
    setenv("NIUMA_PACK_ROOT",importRoot.UTF8String,1);NSError *importError=nil;
    NSURL *archive=[NSURL fileURLWithPath:[NSString stringWithUTF8String:archivePath]];
    NMAppearancePack *imported=[NMAppearancePackStore installArchiveAtURL:archive error:&importError];
    assert(imported && !importError && imported.metadataOnly && !imported.images.count && !imported.previewImage);
    NSData *before=[NSData dataWithContentsOfURL:[imported.directoryURL URLByAppendingPathComponent:@"manifest.json"]];
    NMAppearancePack *duplicate=[NMAppearancePackStore installArchiveAtURL:archive error:&importError];
    assert(duplicate && duplicate.alreadyInstalled && duplicate.metadataOnly);
    assert([before isEqual:[NSData dataWithContentsOfURL:[duplicate.directoryURL URLByAppendingPathComponent:@"manifest.json"]]]);
    assert([NMAppearancePackStore loadResourcesForPack:imported error:&importError] && !importError);
    NSImage *thumbnail=[NMAppearancePackStore thumbnailForPack:imported pixels:256 error:&importError];assert(thumbnail && !importError);
    CGImageRef pixels=[thumbnail CGImageForProposedRect:NULL context:nil hints:nil];assert(CGImageGetWidth(pixels)<=256 && CGImageGetHeight(pixels)<=256);
    setenv("NIUMA_PACK_ROOT",root.UTF8String,1);importTested=YES;
  }
  gAcceptanceRootPath=[output stringByAppendingPathComponent:@"profile"];
  UnifiedController *c=[UnifiedController new];[c applicationDidFinishLaunching:nil];
  assert(!c.appearanceLoadError && c.installedAppearancePacks.count>=22);
  for(NMAppearancePack *p in c.installedAppearancePacks) assert(p.metadataOnly && !p.images.count && !p.previewImage);
  [c.window setFrameOrigin:NSMakePoint(50,100)];
  [c prepareInputDelivery];
  if(argc>3 && strcmp(argv[3],"--lifecycle-only")==0) {
    Lifecycle(c,c.installedAppearancePacks);[c applicationWillTerminate:nil];
    WaitFor(^{return !c.resourceLoadBusy;},20);assert(!c.inputMailbox && !c.inputNotification);
    [c.window close];return 0;
  }
  if(argc>3 && strcmp(argv[3],"--performance-only")==0) {
    Performance(c,c.installedAppearancePacks);[c applicationWillTerminate:nil];[c.window close];return 0;
  }
  dispatch_sync(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{for(int i=0;i<10000;i++) [c captureInputType:kCGEventKeyDown];});
  assert(c.total==12345);[c drainInput];assert(c.total==22345 && c.todayTotal==10023);
  assert(c.dailyTotals[@"2020-01-01"].intValue==77 && [c offworkRecordForDay:@"2020-01-01"]);
  RunFor(.02);assert(c.view.renderer.animationSubmissions==1);[c stopAnimation];TestAnimation(c.view);
  Save(Render(c.view,NO),@"woodfish-layer.png");Save(Render(c.view,YES),@"woodfish-reference.png");
  NSMutableArray *scenes=[NSMutableArray array];
  for(NMAppearancePack *pack in c.installedAppearancePacks) { @autoreleasepool {
    [c applyAppearanceId:pack.identifier];WaitFor(^{return !c.resourceLoadBusy;},20);
    assert([c.selectedAppearanceId isEqual:pack.identifier]);
    [c stopAnimation];[c.view syncPresentation];assert(c.view.renderer.nodes.count==pack.layers.count);
    assert(!c.view.appearancePack.metadataOnly && c.view.appearancePack.images.count<=6);
    TestAnimation(c.view);TestTiming(c.view);
    [scenes addObject:@{@"id":pack.identifier,@"layers":@(pack.layers.count),@"fingerprint":pack.contentFingerprint}];
    if([pack.identifier containsString:@"wealth"] || [pack.identifier containsString:@"offwork"]) {
      NSString *name=[pack.identifier containsString:@"wealth"]?@"wealth":@"offwork";
      Save(Render(c.view,NO),[name stringByAppendingString:@"-layer.png"]);Save(Render(c.view,YES),[name stringByAppendingString:@"-reference.png"]);
    }
  }}
  NMAppearancePack *first=c.installedAppearancePacks.firstObject,*last=c.installedAppearancePacks.lastObject;
  [c applyAppearanceId:first.identifier];[c applyAppearanceId:@"builtin.woodfish"];[c applyAppearanceId:last.identifier];
  WaitFor(^{return !c.resourceLoadBusy && !c.pendingScenePack;},30);assert([c.selectedAppearanceId isEqual:last.identifier]);
  [c applyAppearanceId:@"builtin.woodfish"];assert([c.view.renderedIdentity isEqual:@"builtin:0"] && c.view.renderer.nodes.count==4);
  [c applyAppearanceId:last.identifier];WaitFor(^{return !c.resourceLoadBusy;},20);
  NSString *preserved=[c.selectedAppearanceId copy];
  NSURL *tampered=[NSURL fileURLWithPath:[output stringByAppendingPathComponent:@"tampered.nmgpackdata"]];
  [NSFileManager.defaultManager removeItemAtURL:tampered error:nil];
  assert([NSFileManager.defaultManager copyItemAtURL:first.directoryURL toURL:tampered error:nil]);
  NSError *badError=nil;NMAppearancePack *bad=[NMAppearancePackStore validatePackDirectory:tampered metadataOnly:YES error:&badError];assert(bad && !badError);
  NSURL *manifest=[tampered URLByAppendingPathComponent:@"manifest.json"];
  NSMutableDictionary *badManifest=[[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:manifest] options:0 error:nil] mutableCopy];
  badManifest[@"name_zh"]=@"changed";
  assert([[NSJSONSerialization dataWithJSONObject:badManifest options:0 error:nil] writeToURL:manifest atomically:YES]);
  NSArray *originalCatalog=c.installedAppearancePacks;c.installedAppearancePacks=@[bad];[c applyAppearanceId:bad.identifier];
  WaitFor(^{return !c.resourceLoadBusy;},20);assert([c.selectedAppearanceId isEqual:preserved] && c.appearanceLoadError);
  c.installedAppearancePacks=originalCatalog;c.appearanceLoadError=nil;
  @autoreleasepool {
    NSScrollView *scroll=(NSScrollView *)[c appearanceGrid];NMThumbnailGrid *grid=(NMThumbnailGrid *)scroll.documentView;
    NSWindow *picker=[[NSWindow alloc] initWithContentRect:scroll.bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    picker.releasedWhenClosed=NO;picker.contentView=scroll;[picker orderFront:nil];RunFor(.5);
    for(int step=0;step<8;step++) {
      [scroll.contentView scrollToPoint:NSMakePoint(0,MIN(NSHeight(grid.bounds)-NSHeight(scroll.bounds),step*240))];
      [grid refreshThumbnails:nil];RunFor(.15);
      assert(grid.cache.count<=12 && grid.cachedBytes<=12*256*256*4);
      for(NSButton *button in grid.buttons) if(!NSIntersectsRect(grid.visibleRect,button.frame)) assert(!button.image);
    }
    [c discardRebuildableResources];assert(grid.cache.count==0 && grid.cachedBytes==0);
    [picker close];picker.contentView=nil;c.appearanceButtons=nil;c.appearanceItems=nil;
  }
  [c stopAnimation];NSUInteger submissions=c.view.renderer.animationSubmissions;
  [c hidden:YES fullscreen:NO];for(int i=0;i<12;i++) [c captureInputType:kCGEventKeyDown];[c drainInput];
  assert(c.total==22357 && !c.animationTimer && c.view.renderer.animationSubmissions==submissions);
  [c hidden:YES fullscreen:YES];[c hidden:YES fullscreen:NO];assert(c.appearanceHidden);
  [c hidden:NO fullscreen:NO];[c saveState];
  UnifiedController *reopened=[UnifiedController new];[reopened loadState];assert(reopened.total==22357);
  assert([[MeritPreferences() objectForKey:@"unknownFutureField"] isEqual:@"retained"]);
  MeritCalendarView *calendar=[[MeritCalendarView alloc] initWithFrame:NSMakeRect(0,0,720,724)];calendar.controller=c;
  calendar.previousButton=[NSButton new];calendar.nextButton=[NSButton new];[calendar showCurrentMonth];
  calendar.year=2020;calendar.month=1;calendar.selectedDay=1;SnapshotView(calendar,@"calendar-overtime.png");
  assert([calendar.selectedKey isEqual:@"2020-01-01"] && calendar.dayButtons.count==31);
  [calendar shiftMonth:-1];assert(calendar.year==2020 && calendar.month==1);
  calendar.selectedDay=2;SnapshotView(calendar,@"calendar-missing.png");
  [calendar showCurrentMonth];assert(calendar.nextButton.enabled==NO);
  NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"status":@"passed",@"sceneCount":@(scenes.count),@"scenes":scenes,
      @"oldDataPreserved":@YES,@"metadataOnlyCatalog":@YES,@"inputBurst":@10000,@"hiddenInputs":@12,@"globalInputUsed":@NO,
      @"realPreferencesUsed":@NO,@"realMacHumanAcceptance":@NO,@"signedArchiveImportAndDuplicate":@(importTested)} options:NSJSONWritingPrettyPrinted error:nil];
  assert([json writeToFile:[output stringByAppendingPathComponent:@"functional.json"] atomically:YES]);
  if(argc>3 && strcmp(argv[3],"--performance")==0) Performance(c,c.installedAppearancePacks);
  [c applicationWillTerminate:nil];[c.window close];
  puts("MAC_UNIFIED_FUNCTIONAL=PASS");
}return 0;}
