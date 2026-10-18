#!/usr/bin/env python3
"""Instrument a disposable source snapshot, never the delivered client."""
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
source = args.source.resolve()
if '.local-work' not in source.parts:
    raise SystemExit('Only disposable .local-work source snapshots are supported')

windows = source / 'src/windows/app.cpp'
macos = source / 'src/macos/app.mm'
if (windows.parent / 'app-main.cpp').exists() or (macos.parent / 'app-main.mm').exists():
    raise SystemExit('Snapshot already instrumented; not replayed')
windows.rename(windows.parent / 'app-main.cpp')
macos.rename(macos.parent / 'app-main.mm')
windows.write_text(r'''
#include <windows.h>
static LANGID WINAPI NiuMaGalleryLanguage() { return MAKELANGID(LANG_CHINESE, SUBLANG_CHINESE_SIMPLIFIED); }
#define GetUserDefaultUILanguage NiuMaGalleryLanguage
#define wWinMain NiuMaOriginalEntry
#include "app-main.cpp"
#undef wWinMain

LRESULT CALLBACK GalleryCalendarProbe(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                      UINT_PTR, DWORD_PTR) {
  if (message == WM_APP + 71)
    return niuma::CalendarMonthRange::Month(gCalendar.year, gCalendar.month);
  return DefSubclassProc(window, message, wParam, lParam);
}

LRESULT CALLBACK GalleryHook(int code, WPARAM wParam, LPARAM lParam) {
  if (code >= 0 && wParam == PM_REMOVE) {
    auto* message = reinterpret_cast<MSG*>(lParam);
    if (message->message == WM_APP + 70 && gIsolatedAcceptance) {
      const WPARAM action = message->wParam;
      message->message = WM_NULL;
      if (action == 1) {
        ShowMeritCalendar(gState.window);
        SetWindowSubclass(gCalendar.window, GalleryCalendarProbe, 901, 0);
      }
      else if (action == 2) ShowAppearancePicker(gState.window);
      else if (action == 3) ShowOffworkSettings(gState.window);
      else if (action == 4) ShowAboutDialog(gState.window);
      else if (action == 5) { POINT point{420, 180}; ShowContextMenu(gState.window, point); }
      else if (action == 6) EndMenu();
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command, int show) {
  HHOOK hook = SetWindowsHookExW(WH_GETMESSAGE, GalleryHook, nullptr, GetCurrentThreadId());
  const int result = NiuMaOriginalEntry(instance, previous, command, show);
  if (hook) UnhookWindowsHookEx(hook);
  return result;
}
''', encoding='utf-8')
macos.write_text(r'''
#define main NiuMaOriginalEntry
#import "app-main.mm"
#undef main

static void CaptureView(NSWindow *window, NSString *name) {
  [window displayIfNeeded];
  NSView *view = window.contentView;
  NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
  [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
  NSData *data = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  NSString *directory = [NSString stringWithUTF8String:getenv("NIUMA_UI_GALLERY_OUTPUT")];
  if (!data.length || ![data writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES]) exit(3);
}
static void DismissModalAfterCapture(NSString *name, NSModalResponse response) {
  NSTimer *timer = [NSTimer timerWithTimeInterval:.3 repeats:NO block:^(NSTimer *unused) {
    (void)unused; CaptureView(NSApp.modalWindow, name); [NSApp stopModalWithCode:response];
  }];
  [NSRunLoop.mainRunLoop addTimer:timer forMode:NSModalPanelRunLoopMode];
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSUserDefaults.standardUserDefaults setVolatileDomain:@{@"AppleLanguages":@[@"zh-Hans"]} forName:NSArgumentDomain];
    if (!InitializeAcceptanceContext(argc, argv) || !gIsolatedAcceptance) return 2;
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
    MeritController *controller = [[MeritController alloc] init]; application.delegate = controller;
    NSTimer *timer = [NSTimer timerWithTimeInterval:.8 repeats:NO block:^(NSTimer *unused) {
      (void)unused;
      CaptureView(controller.reminderPanel, @"bubble.png");
      [controller dismissReminder:nil];
      [controller showMeritCalendar:nil]; CaptureView(controller.calendarWindow, @"calendar.png");
      [controller.calendarWindow orderOut:nil];
      [controller showOffworkSettings:nil]; CaptureView(controller.offworkSettingsWindow, @"offwork.png");
      [controller.offworkSettingsWindow orderOut:nil];
      [controller showCountStatus:nil]; CaptureView(controller.countStatusWindow, @"counting-help.png");
      [controller.countStatusWindow orderOut:nil];
      DismissModalAfterCapture(@"appearances.png", NSAlertSecondButtonReturn);
      [controller showAppearancePicker:nil];
      DismissModalAfterCapture(@"about.png", NSAlertFirstButtonReturn);
      [controller showAbout:nil];
      [application terminate:nil];
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
    [application run];
  }
  return 0;
}
''', encoding='utf-8')
print('Instrumented disposable gallery snapshot; delivered source is unchanged')
