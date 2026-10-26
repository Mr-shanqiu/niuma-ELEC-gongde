#include <mutex>
#include <ctime>

// The activity algorithm is unchanged. Each operation is a short in-memory
// critical section; persistence and presentation never hold this mutex.
class NMSynchronizedActivity {
  mutable std::mutex mutex_;
  niuma::reminder::ActivitySampler value_;
 public:
  using Sampler=niuma::reminder::ActivitySampler;
  void Observe(Sampler::Event e,std::uint64_t t) { std::lock_guard<std::mutex> l(mutex_);value_.Observe(e,t); }
  void BeginSuspend(std::uint64_t t) { std::lock_guard<std::mutex> l(mutex_);value_.BeginSuspend(t); }
  void ResetForListenerRestart() { std::lock_guard<std::mutex> l(mutex_);value_.ResetForListenerRestart(); }
  void RestoreSegmentConsumed(bool c) { std::lock_guard<std::mutex> l(mutex_);value_.RestoreSegmentConsumed(c); }
  bool ResumeFromSuspend(std::uint64_t t,bool p,bool trusted,std::uint64_t d) { std::lock_guard<std::mutex> l(mutex_);return value_.ResumeFromSuspend(t,p,trusted,d); }
  bool suspended() const { std::lock_guard<std::mutex> l(mutex_);return value_.suspended(); }
  bool segment_consumed() const { std::lock_guard<std::mutex> l(mutex_);return value_.segment_consumed(); }
  std::uint64_t suspend_started_ms() const { std::lock_guard<std::mutex> l(mutex_);return value_.suspend_started_ms(); }
  Sampler::Trigger Evaluate(std::uint64_t t,bool healthy=true) { std::lock_guard<std::mutex> l(mutex_);return value_.Evaluate(t,healthy); }
};

// This is a pending ledger, not an event queue: repeated inputs update a few
// integers. Only distinct calendar dates add entries, exactly as in saved data.
// Payload, key identity, coordinates and window information never enter it.
@interface NMInputMailbox : NSObject {
  NSLock *_lock;
  NSMutableDictionary<NSString *,NSNumber *> *_days;
  unsigned long long _events,_keys,_clicks,_scrolls,_checkKeys,_checkClicks,_checkScrolls,_checkCounted,_checkExpected;
  long long _remaining;
  double _lastScroll,_lastCount,_interval,_checkStart,_checkEnd,_checkLast;
  BOOL _checking;
  time_t _lastWallSecond;
  NSString *_dateKey;
  CGEventType _disabled;
}
- (instancetype)initWithTotal:(long long)total;
- (void)configureCheckFrom:(double)start until:(double)end enabled:(BOOL)enabled;
- (void)record:(CGEventType)type wall:(time_t)wall uptime:(double)uptime;
- (void)invalidateDate;
- (void)disabled:(CGEventType)type;
- (NSDictionary *)take;
@end
@implementation NMInputMailbox
- (instancetype)initWithTotal:(long long)total {
  if ((self=[super init])) { _lock=[NSLock new]; _days=[NSMutableDictionary dictionary];
    _remaining=LLONG_MAX-MAX(0,total); _interval=.22; _lastWallSecond=-1; }
  return self;
}
- (void)configureCheckFrom:(double)start until:(double)end enabled:(BOOL)enabled {
  [_lock lock];_checkStart=start;_checkEnd=end;_checking=enabled;[_lock unlock];
}
- (void)invalidateDate { [_lock lock];_lastWallSecond=-1;[_lock unlock]; }
- (void)disabled:(CGEventType)type { [_lock lock]; _disabled=type; [_lock unlock]; }
- (void)record:(CGEventType)type wall:(time_t)wall uptime:(double)uptime {
  [_lock lock];
  ++_events;
  BOOL checking=_checking && uptime>=_checkStart && uptime<_checkEnd;
  if(type==kCGEventKeyDown) { ++_keys; if(checking) ++_checkKeys; }
  else if(type==kCGEventScrollWheel) { ++_scrolls; if(checking) ++_checkScrolls; }
  else { ++_clicks; if(checking) ++_checkClicks; }
  if(checking) _checkLast=uptime-_checkStart;
  BOOL counted=YES;
  if(type==kCGEventScrollWheel) { counted=_lastScroll<=0 || uptime-_lastScroll>.180; _lastScroll=uptime; }
  if(counted && checking) ++_checkExpected;
  if(counted && _remaining>0) {
    --_remaining;
    if(_lastWallSecond!=wall) {
      struct tm local{};localtime_r(&wall,&local);char key[32]{};strftime(key,sizeof(key),"%Y-%m-%d",&local);
      _dateKey=[NSString stringWithUTF8String:key];_lastWallSecond=wall;
    }
    _days[_dateKey]=@([_days[_dateKey] longLongValue]+1);
    if(checking) ++_checkCounted;
    double gap=uptime-_lastCount;
    _interval=_lastCount<=0 || gap>.6 || gap<0 ? .22 : _interval*.65+gap*.35;
    _lastCount=uptime;
  }
  [_lock unlock];
}
- (NSDictionary *)take {
  [_lock lock];
  NSDictionary *snapshot=@{@"days":_days,@"events":@(_events),@"keys":@(_keys),@"clicks":@(_clicks),@"scrolls":@(_scrolls),
    @"checkKeys":@(_checkKeys),@"checkClicks":@(_checkClicks),@"checkScrolls":@(_checkScrolls),@"checkCounted":@(_checkCounted),@"checkExpected":@(_checkExpected),
    @"checkLast":@(_checkLast),@"interval":@(_interval),@"lastCount":@(_lastCount),@"disabled":@(_disabled)};
  _days=[NSMutableDictionary dictionary]; _events=_keys=_clicks=_scrolls=_checkKeys=_checkClicks=_checkScrolls=_checkCounted=_checkExpected=0; _disabled=(CGEventType)0;
  [_lock unlock];return snapshot;
}
@end

@interface NMEventTapThread : NSObject {
  NSCondition *_condition;
  NSThread *_thread;
  CFRunLoopRef _runLoop;
  CFRunLoopSourceRef _source;
  BOOL _ready,_finished;
}
- (instancetype)initWithSource:(CFRunLoopSourceRef)source;
- (void)stop;
@end
@implementation NMEventTapThread
- (instancetype)initWithSource:(CFRunLoopSourceRef)source {
  if((self=[super init])) {
    _condition=[NSCondition new];_source=(CFRunLoopSourceRef)CFRetain(source);
    _thread=[[NSThread alloc] initWithTarget:self selector:@selector(run) object:nil];
    _thread.name=@"Niuma input events";[_condition lock];[_thread start];
    while(!_ready) [_condition wait];[_condition unlock];
  }return self;
}
- (void)run { @autoreleasepool {
  [_condition lock];_runLoop=CFRunLoopGetCurrent();CFRetain(_runLoop);
  CFRunLoopAddSource(_runLoop,_source,kCFRunLoopDefaultMode);
  CFRunLoopPerformBlock(_runLoop,kCFRunLoopDefaultMode,^{
    [self->_condition lock];self->_ready=YES;[self->_condition broadcast];[self->_condition unlock];
  });
  [_condition unlock];
  CFRunLoopRun();
  CFRunLoopRemoveSource(_runLoop,_source,kCFRunLoopDefaultMode);CFRelease(_source);_source=NULL;
  [_condition lock];CFRelease(_runLoop);_runLoop=NULL;_finished=YES;[_condition broadcast];[_condition unlock];
}}
- (void)stop {
  [_condition lock];if(_runLoop) { CFRunLoopStop(_runLoop);CFRunLoopWakeUp(_runLoop); }
  while(!_finished) [_condition wait];[_condition unlock];_thread=nil;
}
@end
