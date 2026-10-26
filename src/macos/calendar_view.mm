@implementation MeritCalendarView
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)showCurrentMonth {
  NSDateComponents *p=[RecordCalendar() components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:NSDate.date];
  self.year=p.year; self.month=p.month; self.selectedDay=p.day;
  [self reloadMonthRange]; [self refreshNavigation]; [self setNeedsDisplay:YES];
}
- (void)reloadMonthRange {
  NSDateComponents *p=[RecordCalendar() components:NSCalendarUnitYear|NSCalendarUnitMonth fromDate:NSDate.date];
  _monthRange=niuma::CalendarMonthRange((int)p.year,(int)p.month);
  for (NSString *key in self.controller.dailyTotals)
    if ([self.controller.dailyTotals[key] longLongValue]>0) _monthRange.IncludeRecordedDay(std::string_view(key.UTF8String));
  for (NSString *key in self.controller.offworkDailySnapshots)
    if ([self.controller offworkRecordForDay:key]) _monthRange.IncludeRecordedDay(std::string_view(key.UTF8String));
}
- (NSDate *)firstDate {
  NSDateComponents *p=[NSDateComponents new]; p.year=self.year;p.month=self.month;p.day=1;
  return [RecordCalendar() dateFromComponents:p];
}
- (void)refreshNavigation {
  NSDateComponents *now=[RecordCalendar() components:NSCalendarUnitYear|NSCalendarUnitMonth fromDate:NSDate.date];
  if (_monthRange.last!=niuma::CalendarMonthRange::Month((int)now.year,(int)now.month)) [self reloadMonthRange];
  int month=_monthRange.Clamp(niuma::CalendarMonthRange::Month((int)self.year,(int)self.month));
  self.year=month/12;self.month=month%12+1;
  self.previousButton.enabled=_monthRange.CanShift(month,-1); self.nextButton.enabled=_monthRange.CanShift(month,1);
  NSUInteger days=[RecordCalendar() rangeOfUnit:NSCalendarUnitDay inUnit:NSCalendarUnitMonth forDate:self.firstDate].length;
  self.selectedDay=MAX(1,MIN((NSInteger)days,self.selectedDay));
}
- (void)shiftMonth:(NSInteger)delta {
  [self refreshNavigation];
  int month=_monthRange.Shift(niuma::CalendarMonthRange::Month((int)self.year,(int)self.month),delta<0?-1:delta>0?1:0);
  self.year=month/12;self.month=month%12+1; [self refreshNavigation]; [self setNeedsDisplay:YES];
}
- (void)selectDay:(NSButton *)sender {
  self.selectedDay=sender.tag; [self.window makeFirstResponder:self]; [self setNeedsDisplay:YES];
}
- (void)goToday:(id)sender { (void)sender; [self showCurrentMonth]; }
- (NSString *)selectedKey { return [NSString stringWithFormat:@"%04ld-%02ld-%02ld",(long)self.year,(long)self.month,(long)self.selectedDay]; }
- (void)keyDown:(NSEvent *)event {
  NSInteger delta=0;
  switch(event.keyCode) { case 123:delta=-1;break;case 124:delta=1;break;case 125:delta=7;break;case 126:delta=-7;break;
    case 115:[self showCurrentMonth];return;default:[super keyDown:event];return; }
  NSDateComponents *p=[NSDateComponents new];p.year=self.year;p.month=self.month;p.day=self.selectedDay;
  NSDate *next=[RecordCalendar() dateByAddingUnit:NSCalendarUnitDay value:delta toDate:[RecordCalendar() dateFromComponents:p] options:0];
  p=[RecordCalendar() components:NSCalendarUnitYear|NSCalendarUnitMonth|NSCalendarUnitDay fromDate:next];
  int m=niuma::CalendarMonthRange::Month((int)p.year,(int)p.month);
  if (m<_monthRange.first || m>_monthRange.last) return;
  self.year=p.year;self.month=p.month;self.selectedDay=p.day;[self refreshNavigation];[self setNeedsDisplay:YES];
}
- (void)drawText:(NSString *)text rect:(NSRect)rect size:(CGFloat)size color:(NSColor *)color weight:(NSFontWeight)weight {
  NSFont *font=[NSFont systemFontOfSize:size weight:weight];
  CGFloat width=[text sizeWithAttributes:@{NSFontAttributeName:font}].width;
  if(width>NSWidth(rect)) font=[NSFont systemFontOfSize:MAX(9,size*NSWidth(rect)/width) weight:weight];
  [text drawInRect:rect withAttributes:@{NSFontAttributeName:font,NSForegroundColorAttributeName:color}];
}
- (void)lineFrom:(NSPoint)a to:(NSPoint)b {
  [[NSColor colorWithWhite:.9 alpha:1] setStroke]; NSBezierPath *line=[NSBezierPath bezierPath];
  [line moveToPoint:a];[line lineToPoint:b];line.lineWidth=.5;[line stroke];
}
- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;[NSColor.whiteColor setFill];NSRectFill(self.bounds);[self refreshNavigation];
  NSColor *ink=NMUiInk(),*muted=NMUiMuted(),*accent=NMUiMeritGold();
  NSString *title=IsChineseUI() ? [NSString stringWithFormat:@"%ld年%ld月",(long)self.year,(long)self.month]
                               : [NSString stringWithFormat:@"%ld / %02ld",(long)self.year,(long)self.month];
  [self drawText:title rect:NSMakeRect(65,19,220,34) size:25 color:ink weight:NSFontWeightBold];
  NSString *prefix=[NSString stringWithFormat:@"%04ld-%02ld-",(long)self.year,(long)self.month];
  unsigned long long total=0;
  for (NSString *key in self.controller.dailyTotals) if ([key hasPrefix:prefix]) {
    unsigned long long value=MAX(0,[self.controller.dailyTotals[key] longLongValue]);
    total=value>ULLONG_MAX-total ? ULLONG_MAX : total+value;
  }
  NSNumberFormatter *numbers=[NSNumberFormatter new];numbers.numberStyle=NSNumberFormatterDecimalStyle;
  [self drawText:UiText(@"本月功德",@"This month's merit") rect:NSMakeRect(26,86,260,20) size:12 color:muted weight:NSFontWeightRegular];
  [self drawText:[numbers stringFromNumber:@(total)] rect:NSMakeRect(24,108,410,55) size:43 color:ink weight:NSFontWeightBold];
  [accent setFill];NSRectFill(NSMakeRect(26,164,32,3));
  [self drawText:UiText(@"累计功德",@"Lifetime merit") rect:NSMakeRect(535,96,160,20) size:12 color:muted weight:NSFontWeightRegular];
  [self drawText:[numbers stringFromNumber:@(self.controller.total)] rect:NSMakeRect(495,120,200,34) size:25 color:muted weight:NSFontWeightSemibold];
  NSArray *week=IsChineseUI()?@[@"一",@"二",@"三",@"四",@"五",@"六",@"日"]:@[@"MON",@"TUE",@"WED",@"THU",@"FRI",@"SAT",@"SUN"];
  for (NSInteger c=0;c<7;c++) [self drawText:week[c] rect:NSMakeRect(kCalendarLeft+c*kCalendarCellWidth+38,190,52,20) size:12 color:muted weight:NSFontWeightRegular];
  NSInteger offset=([RecordCalendar() component:NSCalendarUnitWeekday fromDate:self.firstDate]+5)%7;
  NSInteger days=[RecordCalendar() rangeOfUnit:NSCalendarUnitDay inUnit:NSCalendarUnitMonth forDate:self.firstDate].length;
  NSString *today=DateKeyForDate(NSDate.date);
  if (self.dayButtons.count!=(NSUInteger)days) {
    for (NSButton *button in self.dayButtons) [button removeFromSuperview];
    NSMutableArray *buttons=[NSMutableArray array];
    for(NSInteger d=1;d<=days;d++) {
      NSButton *button=[NSButton new];button.title=@"";button.bordered=NO;button.transparent=YES;
      button.tag=d;button.target=self;button.action=@selector(selectDay:);[self addSubview:button];[buttons addObject:button];
    }self.dayButtons=buttons;
  }
  for(NSInteger d=1;d<=days;d++) {
    NSInteger slot=offset+d-1;NSRect cell=NSMakeRect(kCalendarLeft+(slot%7)*kCalendarCellWidth,kCalendarTop+(slot/7)*kCalendarCellHeight,kCalendarCellWidth,kCalendarCellHeight);
    NSString *key=[NSString stringWithFormat:@"%@%02ld",prefix,(long)d];
    if(d==self.selectedDay) { [[NSColor colorWithCalibratedRed:1 green:.95 blue:.91 alpha:1] setFill];[[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(cell,2,2) xRadius:7 yRadius:7] fill]; }
    BOOL future=[key compare:today]==NSOrderedDescending;
    id value=self.controller.dailyTotals[key];
    NSString *valueText=value ? [numbers stringFromNumber:value] : UiText(@"未记录",@"No record");
    [self drawText:[NSString stringWithFormat:@"%ld",(long)d] rect:NSMakeRect(cell.origin.x+12,cell.origin.y+5,72,20) size:16
        color:future?[NSColor colorWithWhite:.65 alpha:1]:([key isEqual:today]||d==self.selectedDay?accent:ink) weight:NSFontWeightSemibold];
    if(!future) [self drawText:valueText rect:NSMakeRect(cell.origin.x+12,cell.origin.y+27,80,16) size:11 color:muted weight:NSFontWeightRegular];
    NSDictionary *record=[self.controller offworkRecordForDay:key];
    if(record) {
      long long seconds=[record[@"seconds"] longLongValue];
      NSString *ot=IsChineseUI() ? [NSString stringWithFormat:@"加班%lld时%lld分",seconds/3600,(seconds/60)%60]
                                : [NSString stringWithFormat:@"OT %lldh %lldm",seconds/3600,(seconds/60)%60];
      [self drawText:ot rect:NSMakeRect(cell.origin.x+12,cell.origin.y+44,82,15) size:9 color:accent weight:NSFontWeightRegular];
    }
    NSButton *button=self.dayButtons[d-1];button.frame=cell;
    button.accessibilityLabel=[NSString stringWithFormat:@"%@, %@, %@",key,valueText,record ? OffworkDurationText([record[@"seconds"] longLongValue]) : UiText(@"加班未记录",@"Overtime not recorded")];
    button.accessibilityValue=@(d==self.selectedDay);
  }
  for(NSInteger row=0;row<=6;row++) [self lineFrom:NSMakePoint(kCalendarLeft,kCalendarTop+row*kCalendarCellHeight) to:NSMakePoint(696,kCalendarTop+row*kCalendarCellHeight)];
  for(NSInteger c=1;c<7;c++) [self lineFrom:NSMakePoint(kCalendarLeft+c*kCalendarCellWidth,kCalendarTop) to:NSMakePoint(kCalendarLeft+c*kCalendarCellWidth,kCalendarTop+6*kCalendarCellHeight)];
  NSRect detail=NSMakeRect(24,620,672,86);[[NSColor colorWithCalibratedWhite:.975 alpha:1] setFill];[[NSBezierPath bezierPathWithRoundedRect:detail xRadius:10 yRadius:10] fill];
  NSString *key=self.selectedKey;id value=self.controller.dailyTotals[key];NSDictionary *record=[self.controller offworkRecordForDay:key];
  [self drawText:key rect:NSMakeRect(42,638,210,24) size:17 color:ink weight:NSFontWeightSemibold];
  [self drawText:UiText(@"仅记录操作次数，不记录输入内容",@"Counts only; no input content") rect:NSMakeRect(42,678,280,16) size:10 color:muted weight:NSFontWeightRegular];
  [self drawText:UiText(@"当日功德",@"Daily merit") rect:NSMakeRect(350,634,120,20) size:11 color:muted weight:NSFontWeightRegular];
  [self drawText:value?[numbers stringFromNumber:value]:UiText(@"未记录",@"No record") rect:NSMakeRect(350,657,150,30) size:24 color:ink weight:NSFontWeightBold];
  [self drawText:UiText(@"加班时长",@"Overtime") rect:NSMakeRect(535,634,150,20) size:11 color:muted weight:NSFontWeightRegular];
  [self drawText:record?OffworkDurationText([record[@"seconds"] longLongValue]):UiText(@"未记录",@"No record") rect:NSMakeRect(535,657,156,30) size:22 color:ink weight:NSFontWeightSemibold];
}
@end
