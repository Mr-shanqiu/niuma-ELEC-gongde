#pragma once

#include <commctrl.h>
#include <uxtheme.h>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "uxtheme.lib")

// Native controls retain their commands, keyboard handling and accessibility.
// This layer changes only their presentation.
namespace niuma::ui {
inline constexpr COLORREF kCanvas = RGB(245, 245, 247);
inline constexpr COLORREF kInk = RGB(29, 29, 31);
inline constexpr COLORREF kMuted = RGB(110, 110, 118);
inline constexpr COLORREF kBlue = RGB(0, 112, 245);
inline HBRUSH CanvasBrush() { static HBRUSH b = CreateSolidBrush(kCanvas); return b; }
inline HBRUSH WhiteBrush() { return static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)); }
inline UINT Dpi(HWND window) {
  using ReadDpi = UINT(WINAPI*)(HWND);
  static auto read = reinterpret_cast<ReadDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
  const UINT dpi = read && window ? read(window) : 96;
  return dpi ? dpi : 96;
}
inline int Dip(int value, UINT dpi) { return MulDiv(value, dpi, 96); }
inline HFONT Font(UINT dpi, int size = 14, int weight = FW_NORMAL, const wchar_t* family = L"Segoe UI") {
  return CreateFontW(-Dip(size, dpi), 0, 0, 0, weight, FALSE, FALSE, FALSE,
      DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
      DEFAULT_PITCH | FF_SWISS, family);
}
inline void RoundPath(Gdiplus::GraphicsPath& path, const Gdiplus::RectF& rect, float radius) {
  const float d = std::min(radius * 2, std::min(rect.Width, rect.Height));
  path.AddArc(rect.X, rect.Y, d, d, 180, 90);
  path.AddArc(rect.GetRight() - d, rect.Y, d, d, 270, 90);
  path.AddArc(rect.GetRight() - d, rect.GetBottom() - d, d, d, 0, 90);
  path.AddArc(rect.X, rect.GetBottom() - d, d, d, 90, 90);
  path.CloseFigure();
}
inline void Rounded(HDC dc, const RECT& rect, COLORREF fill, int radius, COLORREF border = CLR_INVALID) {
  Gdiplus::Graphics graphics(dc);
  graphics.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  Gdiplus::GraphicsPath path;
  RoundPath(path, Gdiplus::RectF(static_cast<float>(rect.left) + .5f,
      static_cast<float>(rect.top) + .5f, static_cast<float>(rect.right - rect.left) - 1,
      static_cast<float>(rect.bottom - rect.top) - 1), static_cast<float>(radius));
  Gdiplus::SolidBrush brush(Gdiplus::Color(255, GetRValue(fill), GetGValue(fill), GetBValue(fill)));
  graphics.FillPath(&brush, &path);
  if (border != CLR_INVALID) {
    Gdiplus::Pen pen(Gdiplus::Color(255, GetRValue(border), GetGValue(border), GetBValue(border)));
    graphics.DrawPath(&pen, &path);
  }
}
inline void WindowChrome(HWND window) {
  using SetAttribute = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
  static HMODULE library = LoadLibraryW(L"dwmapi.dll");
  static auto set = library ? reinterpret_cast<SetAttribute>(GetProcAddress(library, "DwmSetWindowAttribute")) : nullptr;
  if (set) {
    const int round = 2, light = 0;
    const COLORREF caption = kCanvas, ink = kInk, border = RGB(222, 222, 228);
    set(window, 33, &round, sizeof(round));
    set(window, 20, &light, sizeof(light));
    set(window, 35, &caption, sizeof(caption));
    set(window, 36, &ink, sizeof(ink));
    set(window, 34, &border, sizeof(border));
  }
}
template<class Painter>
inline void PaintBuffered(HDC destination, const RECT& bounds, Painter draw) {
  const int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  if (!destination || width <= 0 || height <= 0) return;
  HDC memory = CreateCompatibleDC(destination);
  HBITMAP bitmap = memory ? CreateCompatibleBitmap(destination, width, height) : nullptr;
  HGDIOBJ previous = bitmap ? SelectObject(memory, bitmap) : nullptr;
  if (previous && previous != HGDI_ERROR) {
    SetViewportOrgEx(memory, -bounds.left, -bounds.top, nullptr);
    draw(memory);
    BitBlt(destination, bounds.left, bounds.top, width, height,
        memory, bounds.left, bounds.top, SRCCOPY);
    SelectObject(memory, previous);
  } else {
    draw(destination);
  }
  if (bitmap) DeleteObject(bitmap);
  if (memory) DeleteDC(memory);
}
inline void DrawButton(HWND window, HDC dc) {
  RECT rect{}; GetClientRect(window, &rect);
  FillRect(dc, &rect, CanvasBrush());
  const UINT dpi = Dpi(window);
  const LONG_PTR type = GetWindowLongPtrW(window, GWL_STYLE) & BS_TYPEMASK;
  const bool check = type == BS_CHECKBOX || type == BS_AUTOCHECKBOX;
  const bool primary = type == BS_DEFPUSHBUTTON;
  const bool enabled = IsWindowEnabled(window) != FALSE;
  const LRESULT state = SendMessageW(window, BM_GETSTATE, 0, 0);
  const bool pressed = (state & BST_PUSHED) != 0;
  const bool hover = GetPropW(window, L"NiuMaUiHover") != nullptr;
  // Read only this subclassed button's own caption for native painting.
  wchar_t label[512]{};
  SendMessageW(window, WM_GETTEXT, std::size(label), reinterpret_cast<LPARAM>(label));
  COLORREF ink = enabled ? kInk : RGB(153, 153, 160);
  if (check) {
    RECT box{rect.left + Dip(2, dpi), (rect.bottom - Dip(18, dpi)) / 2,
        rect.left + Dip(20, dpi), (rect.bottom + Dip(18, dpi)) / 2};
    const bool checked = SendMessageW(window, BM_GETCHECK, 0, 0) == BST_CHECKED;
    Rounded(dc, box, checked ? kBlue : RGB(255, 255, 255), Dip(5, dpi),
        checked ? kBlue : RGB(180, 180, 188));
    if (checked) {
      HPEN pen = CreatePen(PS_SOLID, Dip(2, dpi), RGB(255, 255, 255));
      HGDIOBJ old = SelectObject(dc, pen);
      MoveToEx(dc, box.left + Dip(4, dpi), box.top + Dip(9, dpi), nullptr);
      LineTo(dc, box.left + Dip(8, dpi), box.top + Dip(13, dpi));
      LineTo(dc, box.left + Dip(14, dpi), box.top + Dip(5, dpi));
      SelectObject(dc, old); DeleteObject(pen);
    }
    rect.left += Dip(30, dpi);
  } else if (GetDlgCtrlID(window) == 4190) {
    if (hover || pressed) Rounded(dc, rect, RGB(227, 232, 240), Dip(10, dpi));
    wcscpy_s(label, L"\x00D7");
  } else if (GetDlgCtrlID(window) == 4101) {
    FillRect(dc, &rect, WhiteBrush());
    ink = kMuted;
  } else {
    COLORREF fill = primary ? kBlue : (hover ? RGB(227, 232, 240) : RGB(235, 235, 240));
    if (pressed) fill = primary ? RGB(0, 87, 210) : RGB(217, 223, 232);
    if (!enabled) fill = RGB(235, 235, 239);
    Rounded(dc, rect, fill, Dip(8, dpi));
    if (primary && enabled) ink = RGB(255, 255, 255);
    if (GetDlgCtrlID(window) == 1001 && enabled) ink = RGB(190, 49, 58);
  }
  HFONT font = reinterpret_cast<HFONT>(SendMessageW(window, WM_GETFONT, 0, 0));
  HGDIOBJ oldFont = font ? SelectObject(dc, font) : nullptr;
  SetBkMode(dc, TRANSPARENT); SetTextColor(dc, ink);
  DrawTextW(dc, label, -1, &rect, DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | (check ? DT_LEFT : DT_CENTER));
  if (font) SelectObject(dc, oldFont);
  if ((state & BST_FOCUS) && !(SendMessageW(window, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) {
    RECT focus = rect; InflateRect(&focus, -Dip(4, dpi), -Dip(4, dpi)); DrawFocusRect(dc, &focus);
  }
}
inline void PaintButton(HWND window, HDC dc) {
  RECT bounds{}; GetClientRect(window, &bounds);
  PaintBuffered(dc, bounds, [&](HDC frame) { DrawButton(window, frame); });
}
inline LRESULT CALLBACK ButtonProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                        UINT_PTR, DWORD_PTR) {
  if (message == WM_PAINT || message == WM_PRINTCLIENT) {
    PAINTSTRUCT paint{};
    HDC dc = message == WM_PAINT ? BeginPaint(window, &paint) : reinterpret_cast<HDC>(wParam);
    PaintButton(window, dc);
    if (message == WM_PAINT) EndPaint(window, &paint);
    return 0;
  }
  if (message == WM_ERASEBKGND) return 1;
  if (message == WM_MOUSEMOVE) {
    if (!GetPropW(window, L"NiuMaUiHover")) {
      SetPropW(window, L"NiuMaUiHover", reinterpret_cast<HANDLE>(1));
      TRACKMOUSEEVENT event{sizeof(event), TME_LEAVE, window, 0}; TrackMouseEvent(&event);
      InvalidateRect(window, nullptr, FALSE);
    }
  } else if (message == WM_MOUSELEAVE) {
    RemovePropW(window, L"NiuMaUiHover"); InvalidateRect(window, nullptr, FALSE);
  } else if (message == WM_NCDESTROY) {
    RemovePropW(window, L"NiuMaUiHover"); RemoveWindowSubclass(window, ButtonProcedure, 61);
  }
  const LRESULT result = DefSubclassProc(window, message, wParam, lParam);
  if (message == BM_SETCHECK || message == BM_SETSTATE || message == WM_SETFOCUS ||
      message == WM_KILLFOCUS || message == WM_ENABLE || message == WM_LBUTTONUP)
    InvalidateRect(window, nullptr, FALSE);
  return result;
}
inline LRESULT CALLBACK SurfaceProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                         UINT_PTR, DWORD_PTR) {
  if (message == WM_CTLCOLORDLG || message == WM_CTLCOLORSTATIC || message == WM_CTLCOLORBTN) {
    HDC dc = reinterpret_cast<HDC>(wParam); SetTextColor(dc, kInk); SetBkColor(dc, kCanvas);
    SetBkMode(dc, TRANSPARENT); return reinterpret_cast<LRESULT>(CanvasBrush());
  }
  if (message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX) {
    HDC dc = reinterpret_cast<HDC>(wParam); SetTextColor(dc, kInk); SetBkColor(dc, RGB(255, 255, 255));
    return reinterpret_cast<LRESULT>(WhiteBrush());
  }
  // Let a buffered page suppress erasure in its own window procedure. Clearing
  // here used to expose an empty canvas before the page's completed frame.
  // Native dialogs still erase through DefDlgProc and WM_CTLCOLORDLG above.
  if (message == WM_NCDESTROY) {
    if (HFONT font = reinterpret_cast<HFONT>(RemovePropW(window, L"NiuMaUiFont"))) DeleteObject(font);
    RemoveWindowSubclass(window, SurfaceProcedure, 60);
  }
  return DefSubclassProc(window, message, wParam, lParam);
}
inline void Apply(HWND window) {
  if (!window) return;
  HFONT font = reinterpret_cast<HFONT>(GetPropW(window, L"NiuMaUiFont"));
  if (!font) {
    font = Font(Dpi(window)); SetPropW(window, L"NiuMaUiFont", font);
    // A parent background repaint must not blank its native child controls.
    SetWindowLongPtrW(window, GWL_STYLE, GetWindowLongPtrW(window, GWL_STYLE) | WS_CLIPCHILDREN);
    SetWindowSubclass(window, SurfaceProcedure, 60, 0); WindowChrome(window);
  }
  EnumChildWindows(window, [](HWND child, LPARAM data) -> BOOL {
    SendMessageW(child, WM_SETFONT, static_cast<WPARAM>(data), TRUE);
    wchar_t cls[40]{}; GetClassNameW(child, cls, 40);
    SetWindowTheme(child, L"Explorer", nullptr);
    const LONG_PTR type = GetWindowLongPtrW(child, GWL_STYLE) & BS_TYPEMASK;
    if (_wcsicmp(cls, L"Button") == 0 && (type == BS_PUSHBUTTON || type == BS_DEFPUSHBUTTON ||
        type == BS_CHECKBOX || type == BS_AUTOCHECKBOX)) SetWindowSubclass(child, ButtonProcedure, 61, 0);
    return TRUE;
  }, reinterpret_cast<LPARAM>(font));
}

// The region supplies rounded corners on Windows 10 and server desktops too,
// where DWM's Windows 11 corner preference is unavailable.
inline void ClipRoundedWindow(HWND window, int radius) {
  RECT bounds{}; GetWindowRect(window, &bounds);
  HRGN region = CreateRoundRectRgn(0, 0, bounds.right - bounds.left + 1,
      bounds.bottom - bounds.top + 1, radius * 2, radius * 2);
  if (region && !SetWindowRgn(window, region, TRUE)) DeleteObject(region);
}
inline int CardHeader(UINT dpi) { return Dip(52, dpi); }
inline void LayoutCard(HWND window) {
  RECT client{}; GetClientRect(window, &client); const UINT dpi = Dpi(window);
  MoveWindow(GetDlgItem(window, 4191), Dip(22, dpi), Dip(16, dpi),
      std::max(1L, client.right - Dip(82, dpi)), Dip(24, dpi), TRUE);
  MoveWindow(GetDlgItem(window, 4190), client.right - Dip(46, dpi), Dip(12, dpi),
      Dip(32, dpi), Dip(32, dpi), TRUE);
  ClipRoundedWindow(window, Dip(18, dpi));
}
inline LRESULT CALLBACK CardProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                                     UINT_PTR, DWORD_PTR) {
  if (message == WM_SIZE) LayoutCard(window);
  if (message == WM_COMMAND && LOWORD(wParam) == 4190) {
    SendMessageW(window, WM_CLOSE, 0, 0); return 0;
  }
  if (message == WM_NCHITTEST) {
    POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)}; ScreenToClient(window, &point);
    RECT client{}; GetClientRect(window, &client);
    if (point.y >= 0 && point.y < CardHeader(Dpi(window)) &&
        point.x >= 0 && point.x < client.right - Dip(52, Dpi(window))) return HTCAPTION;
  }
  if (message == WM_KEYDOWN && wParam == VK_ESCAPE) {
    SendMessageW(window, WM_CLOSE, 0, 0); return 0;
  }
  if (message == WM_NCDESTROY) {
    if (HFONT font = reinterpret_cast<HFONT>(RemovePropW(window, L"NiuMaCardFont"))) DeleteObject(font);
    RemoveWindowSubclass(window, CardProcedure, 62);
  }
  return DefSubclassProc(window, message, wParam, lParam);
}
inline void Card(HWND window, const wchar_t* title, const wchar_t* closeLabel) {
  if (GetDlgItem(window, 4190)) return;
  const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
  SetWindowLongPtrW(window, GWL_STYLE, (style & ~(WS_CAPTION | WS_BORDER | WS_DLGFRAME)) | WS_POPUP | WS_CLIPCHILDREN);
  SetWindowLongPtrW(window, GWL_EXSTYLE,
      GetWindowLongPtrW(window, GWL_EXSTYLE) & ~(WS_EX_DLGMODALFRAME | WS_EX_CLIENTEDGE | WS_EX_WINDOWEDGE));
  SetWindowSubclass(window, CardProcedure, 62, 0);
  SetWindowPos(window, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  CreateWindowExW(0, L"STATIC", title, WS_CHILD | WS_VISIBLE | SS_LEFT,
      0, 0, 1, 1, window, reinterpret_cast<HMENU>(4191), GetModuleHandleW(nullptr), nullptr);
  CreateWindowExW(0, L"BUTTON", closeLabel, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
      0, 0, 1, 1, window, reinterpret_cast<HMENU>(4190), GetModuleHandleW(nullptr), nullptr);
  Apply(window);
  HFONT font = Font(Dpi(window), 16, FW_SEMIBOLD); SetPropW(window, L"NiuMaCardFont", font);
  SendMessageW(GetDlgItem(window, 4191), WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  LayoutCard(window);
}
// A thread-local menu lifecycle hook only styles this thread's native popup.
// It never observes keyboard/mouse input or another process's windows.
inline LRESULT CALLBACK MenuChromeHook(int code, WPARAM wParam, LPARAM lParam) {
  static thread_local bool applying = false;
  if (code >= 0 && !applying) {
    const auto* event = reinterpret_cast<const CWPSTRUCT*>(lParam);
    if (event->message == WM_NCDESTROY) RemovePropW(event->hwnd, L"NiuMaMenuChromeSize");
    if (event->message == WM_WINDOWPOSCHANGED || event->message == WM_SHOWWINDOW) {
      wchar_t name[32]{}; GetClassNameW(event->hwnd, name, 32);
      if (wcscmp(name, L"#32768") == 0) {
        RECT bounds{}; GetWindowRect(event->hwnd, &bounds);
        const UINT dpi = Dpi(event->hwnd);
        const auto key = static_cast<UINT_PTR>(std::max(0L, bounds.right - bounds.left) & 0xffff) |
            (static_cast<UINT_PTR>(std::max(0L, bounds.bottom - bounds.top) & 0xffff) << 16) |
            (static_cast<UINT_PTR>(dpi) << 32);
        // Reapplying the same region on hover/owner updates invalidates a
        // whole menu whose size has not changed.
        if (reinterpret_cast<UINT_PTR>(GetPropW(event->hwnd, L"NiuMaMenuChromeSize")) != key) {
          applying = true;
          SetPropW(event->hwnd, L"NiuMaMenuChromeSize", reinterpret_cast<HANDLE>(key));
          WindowChrome(event->hwnd);
          ClipRoundedWindow(event->hwnd, Dip(14, dpi));
          applying = false;
        }
      }
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}
inline int TrackMenu(HMENU menu, UINT flags, POINT point, HWND owner) {
  const HWND previous = GetForegroundWindow();
  // A no-activate desktop widget is normally not the foreground window.
  // Native popup menus need a foreground owner to dismiss on outside clicks.
  SetForegroundWindow(owner);
  HHOOK hook = SetWindowsHookExW(WH_CALLWNDPROC, MenuChromeHook, nullptr, GetCurrentThreadId());
  const int result = TrackPopupMenu(menu, flags, point.x, point.y, 0, owner, nullptr);
  if (hook) UnhookWindowsHookEx(hook);
  PostMessageW(owner, WM_NULL, 0, 0);
  // Escape/cancel should return focus; an outside click may already have
  // activated another window, in which case leave that user choice intact.
  if (previous && previous != owner && IsWindow(previous) && GetForegroundWindow() == owner)
    SetForegroundWindow(previous);
  return result;
}
struct MenuItem { const wchar_t* text; const wchar_t* icon; bool checked; bool dividerBefore; };
inline bool MeasureMenu(MEASUREITEMSTRUCT* item, UINT dpi) {
  if (!item || item->CtlType != ODT_MENU || !item->itemData) return false;
  item->itemWidth = Dip(248, dpi); item->itemHeight = Dip(40, dpi); return true;
}
inline bool DrawMenuFrame(DRAWITEMSTRUCT* item, UINT dpi) {
  if (!item || item->CtlType != ODT_MENU || !item->itemData) return false;
  const auto& data = *reinterpret_cast<const MenuItem*>(item->itemData);
  RECT r = item->rcItem; FillRect(item->hDC, &r, WhiteBrush());
  if (data.dividerBefore) {
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(230, 230, 235)); HGDIOBJ old = SelectObject(item->hDC, pen);
    MoveToEx(item->hDC, r.left + Dip(14, dpi), r.top, nullptr);
    LineTo(item->hDC, r.right - Dip(14, dpi), r.top);
    SelectObject(item->hDC, old); DeleteObject(pen);
  }
  RECT background = r; InflateRect(&background, -Dip(5, dpi), -Dip(2, dpi));
  if (item->itemState & ODS_SELECTED) Rounded(item->hDC, background, RGB(235, 240, 248), Dip(7, dpi));
  SetBkMode(item->hDC, TRANSPARENT); SetTextColor(item->hDC, kInk);
  HFONT icon = Font(dpi, 16, FW_NORMAL, L"Segoe MDL2 Assets"); HGDIOBJ old = SelectObject(item->hDC, icon);
  RECT glyph = r; glyph.left += Dip(15, dpi); glyph.right = glyph.left + Dip(22, dpi);
  DrawTextW(item->hDC, data.icon, -1, &glyph, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  HFONT font = Font(dpi); SelectObject(item->hDC, font);
  RECT text = r; text.left += Dip(47, dpi); text.right -= Dip(26, dpi);
  DrawTextW(item->hDC, data.text, -1, &text, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  if (data.checked) { RECT check = r; check.left = check.right - Dip(28, dpi);
    DrawTextW(item->hDC, L"\x2713", -1, &check, DT_CENTER | DT_VCENTER | DT_SINGLELINE); }
  SelectObject(item->hDC, old); DeleteObject(icon); DeleteObject(font); return true;
}
inline bool DrawMenu(DRAWITEMSTRUCT* item, UINT dpi) {
  if (!item || item->CtlType != ODT_MENU || !item->itemData) return false;
  PaintBuffered(item->hDC, item->rcItem, [&](HDC frame) {
    auto buffered = *item; buffered.hDC = frame;
    DrawMenuFrame(&buffered, dpi);
  });
  return true;
}
inline int Message(HWND owner, const wchar_t* text, const wchar_t* title, UINT flags) {
  const UINT type = flags & MB_TYPEMASK;
  if (type != MB_OK && type != MB_OKCANCEL && type != MB_YESNO)
    return MessageBoxW(owner, text, title, flags);
  TASKDIALOGCONFIG config{}; config.cbSize = sizeof(config); config.hwndParent = owner;
  config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW | TDF_SIZE_TO_CONTENT;
  config.pszWindowTitle = title; config.pszMainInstruction = title; config.pszContent = text;
  config.dwCommonButtons = type == MB_YESNO ? TDCBF_YES_BUTTON | TDCBF_NO_BUTTON :
      (type == MB_OKCANCEL ? TDCBF_OK_BUTTON | TDCBF_CANCEL_BUTTON : TDCBF_OK_BUTTON);
  if (flags & MB_DEFBUTTON2) config.nDefaultButton = type == MB_YESNO ? IDNO : IDCANCEL;
  const UINT icon = flags & MB_ICONMASK;
  config.pszMainIcon = icon == MB_ICONERROR ? TD_ERROR_ICON :
      (icon == MB_ICONWARNING ? TD_WARNING_ICON : TD_INFORMATION_ICON);
  int result = IDCANCEL;
  if (SUCCEEDED(TaskDialogIndirect(&config, &result, nullptr, nullptr))) {
    if (type == MB_YESNO && result == IDCANCEL) return IDNO;
    return result;
  }
  return MessageBoxW(owner, text, title, flags);
}
}  // namespace niuma::ui
