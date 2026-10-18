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
inline void PaintButton(HWND window, HDC dc) {
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
  wchar_t label[512]{}; GetWindowTextW(window, label, 512);
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
  if (message == WM_ERASEBKGND) {
    RECT rect{}; GetClientRect(window, &rect); FillRect(reinterpret_cast<HDC>(wParam), &rect, CanvasBrush()); return 1;
  }
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

struct MenuItem { const wchar_t* text; const wchar_t* icon; bool checked; bool separator; };
inline bool MeasureMenu(MEASUREITEMSTRUCT* item, UINT dpi) {
  if (!item || item->CtlType != ODT_MENU || !item->itemData) return false;
  const auto* data = reinterpret_cast<const MenuItem*>(item->itemData);
  item->itemWidth = Dip(240, dpi); item->itemHeight = Dip(data->separator ? 12 : 36, dpi); return true;
}
inline bool DrawMenu(DRAWITEMSTRUCT* item, UINT dpi) {
  if (!item || item->CtlType != ODT_MENU || !item->itemData) return false;
  const auto& data = *reinterpret_cast<const MenuItem*>(item->itemData);
  RECT r = item->rcItem; FillRect(item->hDC, &r, WhiteBrush());
  if (data.separator) {
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(230, 230, 235)); HGDIOBJ old = SelectObject(item->hDC, pen);
    MoveToEx(item->hDC, r.left + Dip(14, dpi), (r.top + r.bottom) / 2, nullptr);
    LineTo(item->hDC, r.right - Dip(14, dpi), (r.top + r.bottom) / 2);
    SelectObject(item->hDC, old); DeleteObject(pen); return true;
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
