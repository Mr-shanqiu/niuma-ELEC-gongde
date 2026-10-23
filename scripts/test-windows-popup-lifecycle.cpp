// Native popup regression tests. Only this test's windows and helper receive input.
#include <windows.h>
#include <windowsx.h>
#include <objidl.h>
#include <gdiplus.h>
#include <algorithm>
#include <iterator>
#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <atomic>
#include "../src/windows/ui_theme.h"

namespace {
#define CHECK(x) do { if(!(x)) throw std::runtime_error(std::string("line ")+std::to_string(__LINE__)+": " #x); } while(false)
HANDLE entered=nullptr;
unsigned eraseCalls=0;
LRESULT CALLBACK Procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_ERASEBKGND) { ++eraseCalls; return 1; }
  if(message==WM_ENTERMENULOOP && entered) SetEvent(entered);
  if(message==WM_CLOSE) { DestroyWindow(window); return 0; }
  if(message==WM_DESTROY) PostQuitMessage(0);
  return DefWindowProcW(window,message,wp,lp);
}
void Surface() {
  HWND window=CreateWindowW(L"NiuMaPopupTest",L"Owned buffered page",WS_OVERLAPPEDWINDOW,
      10,10,80,80,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
  CHECK(window);
  niuma::ui::Apply(window);
  HDC dc=CreateCompatibleDC(nullptr); CHECK(dc);
  HBITMAP bitmap=CreateBitmap(80,80,1,32,nullptr); CHECK(bitmap);
  HGDIOBJ old=SelectObject(dc,bitmap); CHECK(old && old!=HGDI_ERROR);
  const COLORREF sentinel=RGB(19,79,139);
  HBRUSH brush=CreateSolidBrush(sentinel); RECT bounds{0,0,80,80};
  FillRect(dc,&bounds,brush); DeleteObject(brush);
  const auto before=eraseCalls;
  CHECK(SendMessageW(window,WM_ERASEBKGND,reinterpret_cast<WPARAM>(dc),0)==1);
  CHECK(eraseCalls==before+1 && GetPixel(dc,8,8)==sentinel);
  CHECK(GetWindowLongPtrW(window,GWL_STYLE)&WS_CLIPCHILDREN);
  SelectObject(dc,old); DeleteObject(bitmap); DeleteDC(dc); DestroyWindow(window);
  MSG pending{}; while(PeekMessageW(&pending,nullptr,WM_QUIT,WM_QUIT,PM_REMOVE)) {}
  std::cout<<"PASS buffered page controls background erasure; parent clips child controls\n";
}
struct Target {
  PROCESS_INFORMATION process{};
  HWND window=nullptr;
  Target() {
    wchar_t exe[MAX_PATH]{}; CHECK(GetModuleFileNameW(nullptr,exe,MAX_PATH));
    const auto eventName=L"Local\\NiuMaPopupTargetReady-"+std::to_wstring(GetCurrentProcessId());
    HANDLE ready=CreateEventW(nullptr,TRUE,FALSE,eventName.c_str()); CHECK(ready);
    std::wstring command=L"\""+std::wstring(exe)+L"\" --target "+std::to_wstring(GetCurrentProcessId())+L" \""+eventName+L"\"";
    STARTUPINFOW startup{}; startup.cb=sizeof(startup);
    const BOOL started=CreateProcessW(exe,command.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&startup,&process);
    if(!started) { CloseHandle(ready); CHECK(started); }
    const DWORD wait=WaitForSingleObject(ready,5000); CloseHandle(ready);
    CHECK(wait==WAIT_OBJECT_0);
    EnumWindows([](HWND candidate,LPARAM data)->BOOL {
      auto* target=reinterpret_cast<Target*>(data); DWORD pid=0;
      GetWindowThreadProcessId(candidate,&pid);
      if(pid==target->process.dwProcessId && IsWindowVisible(candidate)) {target->window=candidate;return FALSE;}
      return TRUE;
    },reinterpret_cast<LPARAM>(this));
    CHECK(window);
  }
  ~Target() {
    if(window) PostMessageW(window,WM_CLOSE,0,0);
    if(process.hProcess) {
      if(WaitForSingleObject(process.hProcess,5000)!=WAIT_OBJECT_0) TerminateProcess(process.hProcess,2);
      CloseHandle(process.hThread);CloseHandle(process.hProcess);
    }
  }
};
void SendKey(WORD key) {
  INPUT inputs[2]{};
  for(auto& input:inputs) {input.type=INPUT_KEYBOARD;input.ki.wVk=key;}
  inputs[1].ki.dwFlags=KEYEVENTF_KEYUP;
  CHECK(SendInput(2,inputs,sizeof(INPUT))==2);
}
void Menus() {
  Target target;
  HWND owner=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_NOREDIRECTIONBITMAP,
      L"NiuMaPopupTest",L"Owned no-activate widget",WS_POPUP|WS_VISIBLE,
      40,40,120,125,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr);
  CHECK(owner);
  entered=CreateEventW(nullptr,TRUE,FALSE,nullptr); CHECK(entered);
  HANDLE finished=CreateEventW(nullptr,TRUE,FALSE,nullptr); CHECK(finished);
  for(unsigned mode=0;mode<3;++mode) {
    CHECK(SetForegroundWindow(target.window) && GetForegroundWindow()==target.window);
    ResetEvent(entered);ResetEvent(finished);
    HMENU menu=CreatePopupMenu();CHECK(menu); AppendMenuW(menu,MF_STRING,42,L"Owned test action");
    std::atomic<bool> rescued{false},inputFailed{false};
    std::thread input([&] {
      if(WaitForSingleObject(entered,5000)!=WAIT_OBJECT_0) { rescued=true;PostMessageW(owner,WM_CANCELMODE,0,0);return; }
      Sleep(80);
      try {
        if(mode==0) {
          RECT rect{};CHECK(GetWindowRect(target.window,&rect));
          CHECK(SetCursorPos(rect.left+40,rect.top+60));
          INPUT click[2]{};for(auto& i:click)i.type=INPUT_MOUSE;
          click[0].mi.dwFlags=MOUSEEVENTF_LEFTDOWN;click[1].mi.dwFlags=MOUSEEVENTF_LEFTUP;
          CHECK(SendInput(2,click,sizeof(INPUT))==2);
        } else if(mode==1) SendKey(VK_ESCAPE);
        else { SendKey(VK_DOWN);SendKey(VK_RETURN); }
      } catch(...) {inputFailed=true;}
      if(WaitForSingleObject(finished,1500)!=WAIT_OBJECT_0) {rescued=true;PostMessageW(owner,WM_CANCELMODE,0,0);}
    });
    const int command=niuma::ui::TrackMenu(menu,TPM_RETURNCMD|TPM_RIGHTBUTTON|TPM_NONOTIFY,{50,50},owner);
    SetEvent(finished);input.join();DestroyMenu(menu);
    CHECK(!rescued && !inputFailed && command==(mode==2?42:0));
    if(mode==1) CHECK(GetForegroundWindow()==target.window);
    MSG message{};
    while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)) {
      if(message.message!=WM_QUIT) {TranslateMessage(&message);DispatchMessageW(&message);}
    }
  }
  CloseHandle(entered);entered=nullptr;CloseHandle(finished);DestroyWindow(owner);
  std::cout<<"PASS no-activate widget menu: other-process outside click closes, Escape restores focus, selection returns once\n";
}
int Helper(int argc,wchar_t** argv) {
  CHECK(argc==4);
  HANDLE ready=OpenEventW(EVENT_MODIFY_STATE,FALSE,argv[3]);CHECK(ready);
  HWND window=CreateWindowW(L"NiuMaPopupTest",L"Owned external click target",WS_OVERLAPPEDWINDOW|WS_VISIBLE,
      500,60,320,240,nullptr,nullptr,GetModuleHandleW(nullptr),nullptr); CHECK(window);
  SetForegroundWindow(window);AllowSetForegroundWindow(std::stoul(argv[2]));
  SetEvent(ready);CloseHandle(ready);
  MSG message{};while(GetMessageW(&message,nullptr,0,0)>0) {TranslateMessage(&message);DispatchMessageW(&message);}
  return 0;
}
}
int wmain(int argc,wchar_t** argv) {
  try {
    WNDCLASSW cls{};cls.hInstance=GetModuleHandleW(nullptr);cls.lpszClassName=L"NiuMaPopupTest";cls.lpfnWndProc=Procedure;
    CHECK(RegisterClassW(&cls));
    if(argc>1 && wcscmp(argv[1],L"--target")==0) return Helper(argc,argv);
    Gdiplus::GdiplusStartupInput startup;ULONG_PTR gdi=0;
    CHECK(Gdiplus::GdiplusStartup(&gdi,&startup,nullptr)==Gdiplus::Ok);
    Surface();Menus();Gdiplus::GdiplusShutdown(gdi);return 0;
  } catch(const std::exception& error) {std::cerr<<"FAIL "<<error.what()<<" Win32="<<GetLastError()<<"\n";return 1;}
}
