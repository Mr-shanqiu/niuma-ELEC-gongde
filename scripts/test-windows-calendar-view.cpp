// Exercise the actual calendar window with synthetic in-memory records only.
// No client entry, user profile, input listener, install, or storage worker runs.
#define wWinMain NiuMaUnusedCalendarEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <iostream>
#include <stdexcept>
#include <fstream>
#define CHECK(x) do{if(!(x))throw std::runtime_error("line "+std::to_string(__LINE__)+": " #x);}while(false)
std::wstring RecordSignature() {
  std::wstring s=std::to_wstring(gState.total)+L":"+std::to_wstring(gState.todayTotal)+L":"+gState.currentDay;
  for(const auto& d:gState.pendingDailyTotals)s+=d.first+L":"+std::to_wstring(d.second)+L";";
  for(const auto& d:gOffwork.days)s+=d.first+L":"+std::to_wstring(d.second.present)+L":"+std::to_wstring(d.second.dirty)+L":"+
    std::to_wstring(d.second.seconds)+L":"+std::to_wstring(d.second.targetMinutes)+L":"+std::to_wstring(d.second.updatedAt)+L";";
  return s;
}
void PumpCalendar() {MSG m{};while(PeekMessageW(&m,nullptr,0,0,PM_REMOVE)){if(m.message!=WM_QUIT){TranslateMessage(&m);DispatchMessageW(&m);}}}
void Snapshot(const std::wstring& path) {
  UpdateWindow(gCalendar.window);PumpCalendar();RECT r{};CHECK(GetClientRect(gCalendar.window,&r));
  HDC screen=GetDC(gCalendar.window);niuma::render::LayeredSurface surface;
  CHECK(surface.Ensure(screen,r.right,r.bottom));ReleaseDC(gCalendar.window,screen);
  if(CalendarScale(gCalendar.window)<1.1f) {
    CHECK(PrintWindow(gCalendar.window,surface.dc(),PW_CLIENTONLY|2));
  } else {
    // Hosted desktops clip PrintWindow outside the physical screen even with
    // a correctly sized HWND. Exercise the very same production painting into
    // a complete 200% backing DIB; this is not an OS-DPI/hardware acceptance.
    DrawMeritCalendar(surface.dc());
    for(int id:{kCalendarPrevious,kCalendarNext,kCalendarToday}) {
      HWND button=GetDlgItem(gCalendar.window,id);RECT rect{};CHECK(GetWindowRect(button,&rect));
      MapWindowPoints(nullptr,gCalendar.window,reinterpret_cast<POINT*>(&rect),2);
      const int saved=SaveDC(surface.dc());CHECK(saved);
      IntersectClipRect(surface.dc(),rect.left,rect.top,rect.right,rect.bottom);
      SetViewportOrgEx(surface.dc(),rect.left,rect.top,nullptr);
      DRAWITEMSTRUCT item{};item.CtlType=ODT_BUTTON;item.CtlID=id;item.hDC=surface.dc();
      item.hwndItem=button;item.rcItem={0,0,rect.right-rect.left,rect.bottom-rect.top};
      if(!IsWindowEnabled(button))item.itemState=ODS_DISABLED;
      DrawCalendarButton(item);RestoreDC(surface.dc(),saved);
    }
  }
  // Both far corners must be painted; a partial screen capture used to leave
  // these black while the numeric scale check still passed.
  const auto* pixels=static_cast<const BYTE*>(surface.pixels());
  const auto far=(static_cast<std::size_t>(r.bottom)*r.right-1)*4;
  CHECK(pixels[far]>=240 && pixels[far+1]>=240 && pixels[far+2]>=240);
  Gdiplus::Bitmap bitmap(r.right,r.bottom,r.right*4,PixelFormat32bppRGB,static_cast<BYTE*>(surface.pixels()));
  UINT count=0,bytes=0;CHECK(Gdiplus::GetImageEncodersSize(&count,&bytes)==Gdiplus::Ok);
  std::vector<BYTE> storage(bytes);auto* codecs=reinterpret_cast<Gdiplus::ImageCodecInfo*>(storage.data());
  CHECK(Gdiplus::GetImageEncoders(count,bytes,codecs)==Gdiplus::Ok);const CLSID* png=nullptr;
  for(UINT i=0;i<count;++i)if(std::wstring(codecs[i].MimeType)==L"image/png")png=&codecs[i].Clsid;
  CHECK(png && bitmap.Save(path.c_str(),png,nullptr)==Gdiplus::Ok);
}
LRESULT CALLBACK LargeBackingSurface(HWND window,UINT message,WPARAM wParam,LPARAM lParam,UINT_PTR,DWORD_PTR) {
  if(message==WM_GETMINMAXINFO){auto* limits=reinterpret_cast<MINMAXINFO*>(lParam);
    limits->ptMaxTrackSize={8192,8192};limits->ptMaxSize={8192,8192};return 0;}
  return DefSubclassProc(window,message,wParam,lParam);
}
void ClickDay(int day) {
  const auto rect=CalendarCell(day);const float scale=CalendarScale(gCalendar.window);
  SendMessageW(gCalendar.window,WM_LBUTTONUP,0,MAKELPARAM(static_cast<int>((rect.X+20)*scale),static_cast<int>((rect.Y+16)*scale)));
}
int wmain(int argc,wchar_t** argv) {
  ULONG_PTR token=0;
  try {
    CHECK(argc==2);Gdiplus::GdiplusStartupInput options;CHECK(Gdiplus::GdiplusStartup(&token,&options,nullptr)==Gdiplus::Ok);
    CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED)));EnableBestDpiAwareness();
    const std::filesystem::path output=std::filesystem::absolute(argv[1]);std::filesystem::create_directories(output);
    gIsolatedAcceptance=true;gState.dpi=96;gState.currentDay=L"2026-10-26";gState.total=1284530;gState.todayTotal=8642;
    gCalendarTodayForTest.wYear=2026;gCalendarTodayForTest.wMonth=10;gCalendarTodayForTest.wDay=26;gCalendarLanguageForTest=1;
    gState.pendingDailyTotals[L"2019-12-31"]=321;
    for(int day=1;day<=26;++day){wchar_t key[16]{};swprintf_s(key,L"2026-10-%02d",day);gState.pendingDailyTotals[key]=1000+day*139;}
    gOffwork.days.emplace(L"2026-10-13",OffworkDayRecord{true,false,4818,1080,1790000000});
    gOffwork.days.emplace(L"2026-10-20",OffworkDayRecord{true,false,3000,1080,1790000000});
    gOffwork.days.emplace(L"2026-10-26",OffworkDayRecord{true,false,2538,1080,1790000000});
    const auto before=RecordSignature();
    WNDCLASSEXW wc{};wc.cbSize=sizeof(wc);wc.lpfnWndProc=CalendarWindowProcedure;wc.hInstance=GetModuleHandleW(nullptr);
    wc.lpszClassName=kCalendarClass;wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);CHECK(RegisterClassExW(&wc));
    ShowMeritCalendar(nullptr);CHECK(gCalendar.window && gCalendar.selectedDay==26);
    CHECK(gCalendar.range.first==niuma::CalendarMonthRange::Month(2019,12));
    CHECK(!IsWindowEnabled(GetDlgItem(gCalendar.window,kCalendarNext)));
    CHECK(CalendarNumber(18446744073709551615ULL)==L"18,446,744,073,709,551,615");
    CHECK(CalendarOvertimeShort(4818)==L"加班 1时20分" && CalendarOvertimeShort(18)==L"加班 <1分");
    auto month=ReadCalendarMonth();CHECK(month.days[26].merit==8642 && month.days[26].overtimeSeconds==2538);
    CHECK(!month.days[12].overtimeRecorded && month.days[12].merit>0);
    std::uint64_t expected=0;for(int d=1;d<=26;++d)expected+=d==26?8642:1000+d*139;
    CHECK(month.total==expected && !month.totalSaturated);
    // Production uses the input owner's ledger, with pending/current values
    // taking precedence exactly as before. No fake fixture-only read path.
    const auto pending13=gState.pendingDailyTotals[L"2026-10-13"];
    gState.pendingDailyTotals.erase(L"2026-10-13");gInput.authoritative=true;
    gInput.daily={{20261013,777},{20261026,12}};
    CHECK(ReadCalendarMonth().days[13].merit==777 && ReadCalendarMonth().days[26].merit==8642);
    gInput.authoritative=false;gInput.daily.clear();gState.pendingDailyTotals[L"2026-10-13"]=pending13;
    Snapshot((output/L"calendar-zh-100.png").wstring());
    ClickDay(13);CHECK(gCalendar.selectedDay==13);CHECK(ReadCalendarMonth().days[gCalendar.selectedDay].overtimeSeconds==4818);
    Snapshot((output/L"calendar-selected-overtime.png").wstring());
    ClickDay(12);CHECK(gCalendar.selectedDay==12 && !ReadCalendarMonth().days[12].overtimeRecorded);
    Snapshot((output/L"calendar-not-recorded.png").wstring());
    ClickDay(27);CHECK(gCalendar.selectedDay==12); // Future dates cannot become selected.
    SendMessageW(gCalendar.window,WM_COMMAND,kCalendarPrevious,0);CHECK(gCalendar.month==9);
    SendMessageW(gCalendar.window,WM_COMMAND,kCalendarToday,0);CHECK(gCalendar.month==10 && gCalendar.selectedDay==26);
    gCalendar.year=2019;gCalendar.month=12;gCalendar.selectedDay=31;RefreshCalendarNavigation();
    CHECK(!IsWindowEnabled(GetDlgItem(gCalendar.window,kCalendarPrevious)));
    CalendarShiftMonth(-1);CHECK(gCalendar.year==2019 && gCalendar.month==12);
    CalendarMoveSelection(1);CHECK(gCalendar.year==2020 && gCalendar.month==1 && gCalendar.selectedDay==1);
    CalendarMoveSelection(-1);CHECK(gCalendar.year==2019 && gCalendar.month==12 && gCalendar.selectedDay==31);
    gCalendar.year=2024;gCalendar.month=2;gCalendar.selectedDay=31;RefreshCalendarNavigation();CHECK(gCalendar.selectedDay==29);
    gCalendar.year=2021;gCalendar.month=2;RefreshCalendarNavigation();CHECK(gCalendar.selectedDay==28 && CalendarRows()==4);
    gCalendar.year=2020;gCalendar.month=8;gCalendar.selectedDay=31;RefreshCalendarNavigation();CHECK(CalendarRows()==6);
    for(int day=1;day<=31;++day){const auto box=CalendarCell(day);CHECK(box.Y+box.Height<=kCalendarGridTop+kCalendarGridHeight+.01f);
      CHECK(CalendarHitDay(box.X+20,box.Y+10)==day);}
    Snapshot((output/L"calendar-six-rows.png").wstring());
    SendMessageW(gCalendar.window,WM_COMMAND,kCalendarToday,0);
    for(unsigned i=0;i<100;++i){HDC dc=GetDC(gCalendar.window);DrawMeritCalendar(dc);ReleaseDC(gCalendar.window,dc);}
    CHECK(RecordSignature()==before);CHECK(!gInput.service && !gDataStorage.service);
    // A 200% backing surface uses the same actual painting, selection and hit testing.
    CHECK(SetWindowSubclass(gCalendar.window,LargeBackingSurface,995,0));
    RECT high{0,0,1520,1408};AdjustWindowRectEx(&high,WS_CAPTION|WS_SYSMENU|WS_CLIPCHILDREN,FALSE,WS_EX_TOOLWINDOW);
    SetWindowPos(gCalendar.window,nullptr,0,0,high.right-high.left,high.bottom-high.top,SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
    RECT highClient{};GetClientRect(gCalendar.window,&highClient);
    std::cout<<"Backing surface="<<highClient.right<<"x"<<highClient.bottom<<" scale="<<CalendarScale(gCalendar.window)<<"\n";
    CHECK(std::abs(CalendarScale(gCalendar.window)-2.f)<.01f);ClickDay(13);CHECK(gCalendar.selectedDay==13);
    Snapshot((output/L"calendar-zh-200.png").wstring());
    gCalendarLanguageForTest=0;SendMessageW(gCalendar.window,WM_COMMAND,kCalendarToday,0);
    SetWindowTextW(GetDlgItem(gCalendar.window,kCalendarToday),L"Today");
    CHECK(CalendarOvertimeShort(4818)==L"OT 1h 20m");Snapshot((output/L"calendar-en-200.png").wstring());
    // Large historical counters stay exact in details and cannot wrap the summary.
    const auto original=gState.pendingDailyTotals[L"2026-10-01"];
    gState.pendingDailyTotals[L"2026-10-01"]=std::numeric_limits<std::uint64_t>::max();month=ReadCalendarMonth();
    CHECK(month.totalSaturated && month.total==std::numeric_limits<std::uint64_t>::max());ClickDay(1);
    Snapshot((output/L"calendar-large-count.png").wstring());gState.pendingDailyTotals[L"2026-10-01"]=original;
    const auto oldHistory=gState.pendingDailyTotals;const auto oldOffwork=gOffwork.days;
    gState.pendingDailyTotals.clear();gOffwork.days.clear();gState.total=gState.todayTotal=0;ReloadCalendarRange();
    CHECK(gCalendar.range.first==gCalendar.range.last);CalendarShiftMonth(-1);CHECK(gCalendar.month==10);
    gOffwork.days.emplace(L"2019-12-31",OffworkDayRecord{true,false,60,1080,1577808000});ReloadCalendarRange();
    CHECK(gCalendar.range.first==niuma::CalendarMonthRange::Month(2019,12));gOffwork.days.clear();ReloadCalendarRange();
    Snapshot((output/L"calendar-empty.png").wstring());gState.pendingDailyTotals=oldHistory;gOffwork.days=oldOffwork;gState.total=1284530;gState.todayTotal=8642;
    CHECK(RecordSignature()==before);SendMessageW(gCalendar.window,WM_COMMAND,IDCANCEL,0);CHECK(!gCalendar.window && !gCalendar.font);
    std::ofstream report(output/L"calendar-view.json");report<<R"({"status":"PASS","scope":"real calendar window, synthetic in-memory data","readOnlyHistory":true,"noHooksOrStorageWorkers":true,"selectedOvertimeSeconds":true,"missingOvertimeDistinct":true,"monthAndYearBoundaries":true,"leapAndSixRowMonths":true,"futureSelectionRejected":true,"todayNavigation":true,"scale100and200":true,"largeCountSaturation":true,"emptyHistory":true,"userProfileAccessed":false})";
    report.close();CoUninitialize();Gdiplus::GdiplusShutdown(token);
    std::cout<<"CALENDAR_VIEW=PASS real window, selection, overtime, month bounds, 100/200%, long counts and read-only history\n";return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
