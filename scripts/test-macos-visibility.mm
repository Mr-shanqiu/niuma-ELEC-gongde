#define main NiuMaUnusedApplicationEntry
#import "../src/macos/app.mm"
#undef main
#include <cassert>
@interface HiddenTestWindow : NSWindow
@property(nonatomic) BOOL orderedOut;
@end
@implementation HiddenTestWindow
- (void)orderOut:(id)sender { (void)sender; self.orderedOut=YES; }
- (void)orderFront:(id)sender { (void)sender; self.orderedOut=NO; }
@end
@interface VisibilityTestController : MeritController
- (void)setTestManual:(BOOL)manual fullscreen:(BOOL)fullscreen recovery:(BOOL)recovery;
@end
@implementation VisibilityTestController
- (void)setTestManual:(BOOL)manual fullscreen:(BOOL)fullscreen recovery:(BOOL)recovery {
  _visibility.manualHidden=manual;_visibility.fullscreen=fullscreen;
  _visibility.recoveryAvailable=recovery; [self applyAppearanceVisibility];
}
@end
int main() { @autoreleasepool {
  gIsolatedAcceptance=YES; gAcceptancePreferences=[NMEphemeralMeritPreferences new];
  [NSApplication sharedApplication];
  VisibilityTestController *controller=[VisibilityTestController new];
  controller.dailyTotals=[NSMutableDictionary dictionary];
  controller.currentDayKey=DateKeyForDate(NSDate.date);
  controller.total=123;controller.todayTotal=23;
  controller.dailyTotals[controller.currentDayKey]=@23;
  controller.view=[[MeritView alloc] initWithFrame:NSMakeRect(0,0,120,125)];
  controller.view.controller=controller;
  HiddenTestWindow *window=[[HiddenTestWindow alloc] initWithContentRect:controller.view.bounds
      styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:YES];
  window.releasedWhenClosed=NO;controller.window=window;
  [controller setTestManual:YES fullscreen:NO recovery:YES];
  assert(window.orderedOut && controller.appearanceHidden);
  for(int i=0;i<100;++i) [controller receiveGlobalEvent:kCGEventKeyDown];
  assert(controller.total==223 && controller.todayTotal==123);
  assert(controller.dailyTotals[controller.currentDayKey].longLongValue==123);
  assert(controller.dirty && !controller.animationTimer && !controller.strikeActive);
  [controller saveState];
  VisibilityTestController *reopened=[VisibilityTestController new];[reopened loadState];
  assert(reopened.total==223);
  [controller setTestManual:YES fullscreen:YES recovery:YES];
  [controller setTestManual:YES fullscreen:NO recovery:YES];
  assert(window.orderedOut);  // Fullscreen exit does not undo manual hide.
  [controller setTestManual:NO fullscreen:NO recovery:YES];
  assert(!window.orderedOut && !controller.animationTimer && !controller.strikeActive);
  [controller setTestManual:NO fullscreen:YES recovery:YES];assert(window.orderedOut);
  [controller setTestManual:YES fullscreen:YES recovery:NO];assert(!window.orderedOut);
  [controller toggleAutoHideFullscreen:nil];
  assert(![MeritPreferences() boolForKey:@"AutoHideFullscreen"]);
  [window close];
  puts("MAC_VISIBILITY=PASS hiddenCounts=100 ephemeralSaveReload=true noAnimation=true manualAutoRecovery=true scope=controller-not-live-fullscreen");
} }
