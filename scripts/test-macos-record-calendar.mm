// Actual production view and date-key functions, memory records and hidden view
// only. Never enters product lifecycle, requests permissions or changes defaults.
#define main NiuMaUnusedApplicationEntry
#import "../src/macos/app.mm"
#undef main
#import <objc/runtime.h>
#include <cassert>
static NSCalendar *ForcedCalendar(id object, SEL selector) {
  (void)object; (void)selector;
  NSCalendar *c=[[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierBuddhist];
  c.timeZone=NSTimeZone.localTimeZone; return c;
}
@interface RecordTestController : MeritController
@property(nonatomic,copy) NSString *clicked;
@end
@implementation RecordTestController
- (void)showCalendarDay:(NSString *)key { self.clicked=key; }
@end
@interface RecordTestView : MeritCalendarView
@property(nonatomic,strong) NSMutableArray<NSString *> *texts;
@end
@implementation RecordTestView
- (void)drawText:(NSString *)text rect:(NSRect)rect size:(CGFloat)size color:(NSColor *)color weight:(NSFontWeight)weight {
  (void)rect;(void)size;(void)color;(void)weight; [self.texts addObject:text];
}
@end
int main() { @autoreleasepool {
 gIsolatedAcceptance=YES; gAcceptancePreferences=[NMEphemeralMeritPreferences new];
 [NSApplication sharedApplication];
 Method method=class_getClassMethod(NSCalendar.class,@selector(currentCalendar));
 IMP original=method_setImplementation(method,(IMP)ForcedCalendar);
 assert([NSCalendar.currentCalendar.calendarIdentifier isEqualToString:NSCalendarIdentifierBuddhist]);
 NSCalendar *greg=RecordCalendar();
 NSDateComponents *known=[NSDateComponents new]; known.year=2026; known.month=10; known.day=19; known.hour=12;
 NSDate *date=[greg dateFromComponents:known];
 assert([DateKeyForDate(date) isEqualToString:@"2026-10-19"]);
 assert([NSCalendar.currentCalendar component:NSCalendarUnitYear fromDate:date]==2569);
 for(const char *language : {"zh","en"}) {
  setenv("NIUMA_UI_LANGUAGE",language,1);
  RecordTestController *controller=[RecordTestController new];
  controller.dailyTotals=[@{@"2026-10-19":@617} mutableCopy]; controller.total=617;
  controller.offworkDailySnapshots=[@{@"2026-10-19":@{@"seconds":@3600,@"targetMinutes":@1080,@"sampledAt":@123}} mutableCopy];
  NSDictionary *originalRecords=[controller.dailyTotals copy];
  RecordTestView *view=[[RecordTestView alloc] initWithFrame:NSMakeRect(0,0,720,724)];
  view.controller=controller; view.texts=[NSMutableArray array];
  view.previousButton=[NSButton new]; view.nextButton=[NSButton new];
  [view showCurrentMonth];
  NSDateComponents *today=[greg components:NSCalendarUnitYear|NSCalendarUnitMonth fromDate:NSDate.date];
  assert(view.year==today.year && view.month==today.month && !view.nextButton.enabled);
  for(int i=0;i<30;++i) [view shiftMonth:-1];
  assert(view.year==2026 && view.month==10 && !view.previousButton.enabled);
  NSWindow *window=[[NSWindow alloc] initWithContentRect:view.bounds styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed=NO; window.contentView=view;
  view.selectedDay=19;
  [view drawRect:view.bounds];
  assert([view.texts containsObject:@"617"]);
  assert([view.texts containsObject:OffworkDurationText(3600)]);
  // Date selection is now a native accessible button and inline detail.
  [view selectDay:view.dayButtons[18]];assert([view.selectedKey isEqual:@"2026-10-19"]);
  for(int i=0;i<30;++i) [view shiftMonth:1];
  assert(view.year==today.year && view.month==today.month && !view.nextButton.enabled);
  assert([controller.dailyTotals isEqual:originalRecords]);
  [window close];
 }
 method_setImplementation(method,original);
 puts("PASS: Buddhist default with Gregorian record keys, month bounds, merit/overtime grid and clicked dates in Chinese/English. No system preferences or user data changed.");
} }
