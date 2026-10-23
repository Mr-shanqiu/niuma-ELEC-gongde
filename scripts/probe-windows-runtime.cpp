// P0 diagnostic only. Uses repository artwork, isolated owned windows and a
// separate witness process. It never opens installed data or registers hooks.
#include "runtime-p0-fixtures.h"
#include "../src/windows/runtime/alpha_region.h"
#include "../src/windows/runtime/prepared_alpha_region.h"

#include <windowsx.h>
#include <objbase.h>
#include <psapi.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace niuma::runtime;
using Clock = std::chrono::steady_clock;
constexpr UINT kStopWitness = WM_APP + 17;
struct WitnessState {
    volatile LONG ready = 0;
    volatile LONG leftClicks = 0;
    volatile LONG rightClicks = 0;
    volatile LONG keys = 0;
    ULONG_PTR window = 0;
};
struct OverlayState {
    LONG clicks = 0, rights = 0;
    LONG menusObserved = 0;
    bool dragging = false;
    POINT cursor{};
    RECT initial{};
};
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Mapping {
    WitnessState* value = nullptr;
    ~Mapping() { if (value) UnmapViewOfFile(value); }
};
struct ComScope {
    HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    ~ComScope() { if (SUCCEEDED(result)) CoUninitialize(); }
};
struct CursorScope {
    POINT saved{};
    CursorScope() { GetCursorPos(&saved); }
    ~CursorScope() { SetCursorPos(saved.x, saved.y); }
};
void Check(bool ok, const std::string& message) {
    if (!ok) throw std::runtime_error(message + " (Win32=" + std::to_string(GetLastError()) + ")");
}
void Pump(DWORD milliseconds) {
    const ULONGLONG end = GetTickCount64() + milliseconds;
    do {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message != WM_QUIT) { TranslateMessage(&message); DispatchMessageW(&message); }
        }
        if (GetTickCount64() >= end) break;
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 2, QS_ALLINPUT);
    } while (true);
}
LRESULT CALLBACK WitnessProc(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto* state = reinterpret_cast<WitnessState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        state = static_cast<WitnessState*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    if (state) {
        if (message == WM_LBUTTONDOWN) InterlockedIncrement(&state->leftClicks);
        if (message == WM_RBUTTONDOWN) InterlockedIncrement(&state->rightClicks);
        if (message == WM_KEYDOWN && w == VK_F24) InterlockedIncrement(&state->keys);
    }
    if (message == WM_PAINT) {
        PAINTSTRUCT paint{}; HDC dc = BeginPaint(window, &paint);
        RECT rect{}; GetClientRect(window, &rect);
        FillRect(dc, &rect, reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1));
        SetTextColor(dc, RGB(30, 30, 30)); SetBkMode(dc, TRANSPARENT);
        DrawTextW(dc, L"P0 separate-process desktop witness", -1, &rect, DT_TOP | DT_LEFT);
        EndPaint(window, &paint); return 0;
    }
    if (message == kStopWitness || message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, w, l);
}
LRESULT CALLBACK OverlayProc(HWND window, UINT message, WPARAM w, LPARAM l) {
    auto* state = reinterpret_cast<OverlayState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        state = static_cast<OverlayState*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    // The OS window region excludes alpha-zero points, even across processes.
    // HTTRANSPARENT is deliberately not used as a substitute for that region.
    if (message == WM_NCHITTEST) return HTCLIENT;
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_PAINT) { PAINTSTRUCT p{}; BeginPaint(window, &p); EndPaint(window, &p); return 0; }
    if (state) {
        if (message == WM_LBUTTONDOWN) {
            ++state->clicks; state->dragging = true;
            GetCursorPos(&state->cursor); GetWindowRect(window, &state->initial); SetCapture(window); return 0;
        }
        if (message == WM_MOUSEMOVE && state->dragging) {
            POINT now{}; GetCursorPos(&now);
            SetWindowPos(window, nullptr, state->initial.left + now.x - state->cursor.x,
                         state->initial.top + now.y - state->cursor.y, 0, 0,
                         SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE); return 0;
        }
        if (message == WM_LBUTTONUP) { state->dragging = false; ReleaseCapture(); return 0; }
        if (message == WM_CAPTURECHANGED) state->dragging = false;
        if (message == WM_RBUTTONDOWN) { ++state->rights; return 0; }
        if (message == WM_RBUTTONUP) {
            HMENU menu = CreatePopupMenu();
            if (!menu) return 0;
            AppendMenuW(menu, MF_STRING, 1, L"P0 owned context menu");
            POINT at{}; GetCursorPos(&at);
            SetTimer(window, 731, 150, nullptr);
            TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
                             at.x, at.y, window, nullptr);
            KillTimer(window, 731); DestroyMenu(menu); return 0;
        }
        if (message == WM_TIMER && w == 731) {
            GUITHREADINFO info{}; info.cbSize = sizeof(info);
            if (GetGUIThreadInfo(GetCurrentThreadId(), &info) && info.hwndMenuOwner)
                ++state->menusObserved;
            EndMenu(); return 0;
        }
    }
    return DefWindowProcW(window, message, w, l);
}
void RegisterProbeClass(const wchar_t* name, WNDPROC procedure) {
    WNDCLASSEXW cls{}; cls.cbSize = sizeof(cls); cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpfnWndProc = procedure; cls.lpszClassName = name; cls.hCursor = LoadCursor(nullptr, IDC_ARROW);
    Check(RegisterClassExW(&cls) != 0, "Register diagnostic window");
}
int Witness(const wchar_t* name) {
    Handle mapping{OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name)};
    Check(mapping.value != nullptr, "Open witness mapping");
    Mapping state{static_cast<WitnessState*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(WitnessState)))};
    Check(state.value != nullptr, "Map witness state");
    RegisterProbeClass(L"NiuMaP0Witness", WitnessProc);
    HWND window = CreateWindowExW(0, L"NiuMaP0Witness", L"Owned P0 witness", WS_POPUP | WS_VISIBLE,
                                  20, 20, 700, 700, nullptr, nullptr, GetModuleHandleW(nullptr), state.value);
    Check(window != nullptr, "Create witness");
    state.value->window = reinterpret_cast<ULONG_PTR>(window);
    InterlockedExchange(&state.value->ready, 1);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    return 0;
}
struct WitnessProcess {
    Handle mapping;
    Mapping state;
    PROCESS_INFORMATION process{};
    WitnessProcess() {
        const auto name = L"Local\\NiuMaP0-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
        mapping.value = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(WitnessState), name.c_str());
        Check(mapping.value != nullptr && GetLastError() != ERROR_ALREADY_EXISTS, "Create owned witness mapping");
        state.value = static_cast<WitnessState*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(WitnessState)));
        Check(state.value != nullptr, "Map owned witness");
        *state.value = WitnessState{};
        wchar_t executable[32768]{}; Check(GetModuleFileNameW(nullptr, executable, 32768) != 0, "Locate diagnostic executable");
        std::wstring command = L"\"" + std::wstring(executable) + L"\" --witness \"" + name + L"\"";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup);
        Check(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process) != 0,
              "Launch separate witness process");
        try {
            const auto deadline = GetTickCount64() + 5000;
            while (InterlockedCompareExchange(&state.value->ready, 0, 0) != 1 && GetTickCount64() < deadline) Pump(10);
            Check(state.value->ready == 1 && IsWindow(window()), "Witness startup");
        } catch (...) { Stop(); throw; }
    }
    HWND window() const { return reinterpret_cast<HWND>(state.value->window); }
    ~WitnessProcess() { Stop(); }
    void Stop() {
        if (process.hProcess) {
            if (state.value && state.value->window) PostMessageW(window(), kStopWitness, 0, 0);
            if (WaitForSingleObject(process.hProcess, 2000) == WAIT_TIMEOUT) {
                // Only the process created and owned above; never search by name.
                TerminateProcess(process.hProcess, 2); WaitForSingleObject(process.hProcess, 2000);
            }
            CloseHandle(process.hThread); CloseHandle(process.hProcess);
            process = {};
        }
    }
};
void Mouse(DWORD flags) {
    INPUT event{}; event.type = INPUT_MOUSE; event.mi.dwFlags = flags;
    Check(SendInput(1, &event, sizeof(event)) == 1, "Send owned diagnostic mouse event");
    Pump(35);
}
void Click(HWND overlay, POINT point, bool right = false) {
    ClientToScreen(overlay, &point); Check(SetCursorPos(point.x, point.y) != 0, "Move diagnostic cursor"); Pump(20);
    Mouse(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN);
    Mouse(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP);
}
std::string JsonString(const std::string& input) {
    std::ostringstream out; out << '"';
    for (const unsigned char c : input) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << '?'; else out << c;
    }
    return out.str() + '"';
}
std::string Narrow(const std::wstring& input) {
    if (input.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
    std::string out(size, '\0'); WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), out.data(), size, nullptr, nullptr);
    return out;
}
struct Record { std::string name; double ms = 0; bool ok = false; };
struct Probe {
    std::ofstream report;
    std::vector<Record> records;
    std::string adapter, error;
    AdapterInfo adapterInfo;
    bool software = true;
    bool interactive = true;
    std::uint64_t textureBytes = 0, cpuTextureBytes = 0, captures = 0, presentCount = 0;
    double regionMean = 0, regionP95 = 0, submitMean = 0;
    double preparationMs = 0;
    std::uint64_t preparedBytes = 0, distantTransparentPixelsPeak = 0;
    std::uint64_t regionSamples = 0, conservativePixelsPeak = 0, rectangleCountPeak = 0;
    explicit Probe(const fs::path& output) : report(output) { Check(report.good(), "Open P0 report"); }
    void Add(std::string name, bool ok, double ms = 0) { records.push_back({std::move(name), ms, ok}); }
    ~Probe() {
        report << "{\n  \"scope\":\"P0 diagnostic, not installed client acceptance\",\n"
               << "  \"crossProcessInteractionExercised\":" << (interactive ? "true" : "false") << ",\n"
               << "  \"adapter\":" << JsonString(adapter) << ",\n  \"softwareAdapter\":" << (software ? "true" : "false")
               << ",\n  \"adapterKind\":" << JsonString(adapterInfo.kind)
               << ",\n  \"adapterClassificationReason\":" << JsonString(adapterInfo.classificationReason)
               << ",\n  \"hardwareAcceleratedIdentity\":" << (adapterInfo.hardwareAccelerated ? "true" : "false")
               << ",\n  \"adapterVendor\":" << adapterInfo.vendorId << ",\n  \"adapterDevice\":" << adapterInfo.deviceId
               << ",\n  \"hardwareCreateResult\":" << static_cast<long>(adapterInfo.hardwareCreateResult)
               << ",\n  \"warpCreateResult\":" << static_cast<long>(adapterInfo.warpCreateResult)
               << ",\n  \"getDescResult\":" << static_cast<long>(adapterInfo.getDescResult)
               << ",\n  \"getDesc1Result\":" << static_cast<long>(adapterInfo.getDesc1Result)
               << ",\n  \"hardwarePerformanceProven\":false,\n  \"physicalTypingMeasured\":false,\n"
               << "  \"error\":" << JsonString(error) << ",\n  \"textureBytesPeak\":" << textureBytes
               << ",\n  \"cpuTextureBytesPeak\":" << cpuTextureBytes << ",\n  \"diagnosticReadbacks\":" << captures
               << ",\n  \"presents\":" << presentCount << ",\n  \"regionMeanMs\":" << regionMean
               << ",\n  \"regionP95Ms\":" << regionP95 << ",\n  \"submitMeanMs\":" << submitMean
               << ",\n  \"regionSamples\":" << regionSamples
               << ",\n  \"regionMethod\":\"prepared source support / subpixel spans\""
               << ",\n  \"regionPreparationMs\":" << preparationMs
               << ",\n  \"preparedMaskBytesPeak\":" << preparedBytes
               << ",\n  \"distantTransparentPixelsPeak\":" << distantTransparentPixelsPeak
               << ",\n  \"conservativePixelsPeak\":" << conservativePixelsPeak
               << ",\n  \"rectangleCountPeak\":" << rectangleCountPeak << ",\n  \"checks\":[\n";
        for (std::size_t i = 0; i < records.size(); ++i) {
            const auto& record = records[i];
            report << (i ? ",\n" : "") << "    {\"name\":" << JsonString(record.name)
                   << ",\"passed\":" << (record.ok ? "true" : "false") << ",\"ms\":" << record.ms << '}';
        }
        report << "\n  ]\n}\n";
    }
};
// Implemented below after the independent alpha-region interface is included.
int RunProbe(const fs::path& root, const fs::path& output, bool allowSoftware, bool interactive);
int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    try {
        if (argc == 3 && std::wstring(argv[1]) == L"--witness") return Witness(argv[2]);
        if (argc < 4 || (std::wstring(argv[1]) != L"--ci-probe" && std::wstring(argv[1]) != L"--display-probe")) {
            std::cerr << "Diagnostic only. Usage: --ci-probe|--display-probe <repo-root> <output-directory> [--allow-software-for-test]\n";
            return 2;
        }
        const bool allowSoftware = argc == 5 && std::wstring(argv[4]) == L"--allow-software-for-test";
        return RunProbe(fs::path(argv[2]), fs::path(argv[3]), allowSoftware, std::wstring(argv[1]) == L"--ci-probe");
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}

struct RegionHandle {
    HRGN value = nullptr;
    ~RegionHandle() { if (value) DeleteObject(value); }
};
using PreparedMasks = std::vector<std::pair<std::uint32_t, PreparedAlphaMask>>;
PreparedAlphaRegionResult RegionFor(int width, int height, const std::vector<Quad>& quads,
                                   const PreparedMasks& masks) {
    std::vector<PreparedAlphaQuad> inputs;
    for (const auto& quad : quads) {
        const auto found = std::find_if(masks.begin(), masks.end(),
            [&](const auto& item) { return item.first == quad.textureId; });
        Check(found != masks.end(), "Resolve prepared alpha mask");
        inputs.push_back(FromRendererPreparedQuad(quad, found->second));
    }
    return BuildPreparedAlphaRegion(width, height, inputs);
}
void InstallRegion(HWND window, PreparedAlphaRegionResult& region) {
    Check(region.region != nullptr, "Prepared region handle missing");
    Check(SetWindowRgn(window, region.region, TRUE) != 0, "Install alpha region");
    region.ReleaseRegion();  // Ownership transferred only after USER accepts it.
}
std::vector<std::uint8_t> RegionMask(const AlphaRegionResult& region) {
    std::vector<std::uint8_t> out(static_cast<std::size_t>(region.width) * region.height, 0);
    for (const auto& rect : region.rectangles)
        for (int y = rect.top; y < rect.bottom; ++y)
            std::fill(out.begin() + static_cast<std::size_t>(y) * region.width + rect.left,
                      out.begin() + static_cast<std::size_t>(y) * region.width + rect.right, 1);
    return out;
}
PixelImage DesktopCrop(HWND window) {
    RECT rect{}; GetWindowRect(window, &rect);
    PixelImage out; out.width = rect.right - rect.left; out.height = rect.bottom - rect.top; out.strideBytes = out.width * 4;
    HDC screen = GetDC(nullptr); HDC memory = CreateCompatibleDC(screen);
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = out.width; info.bmiHeader.biHeight = -static_cast<LONG>(out.height);
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    void* pixels = nullptr; HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (screen && memory && bitmap) {
        HGDIOBJ old = SelectObject(memory, bitmap);
        if (BitBlt(memory, 0, 0, out.width, out.height, screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT)) {
            out.bgraPremultiplied.assign(static_cast<std::uint8_t*>(pixels), static_cast<std::uint8_t*>(pixels) + out.strideBytes * out.height);
            for (std::size_t i = 3; i < out.bgraPremultiplied.size(); i += 4) out.bgraPremultiplied[i] = 255;
        }
        SelectObject(memory, old);
    }
    if (bitmap) DeleteObject(bitmap); if (memory) DeleteDC(memory); if (screen) ReleaseDC(nullptr, screen);
    return out;
}
void InteractionChecks(HWND overlay, OverlayState& overlayState, WitnessProcess& witness,
                       const PixelImage& frame, const AlphaRegionResult& region,
                       const std::string& prefix, Probe& probe) {
    const auto mask = RegionMask(region);
    POINT transparent{-1,-1}, opaque{-1,-1};
    // An interior point of the overall artwork bounds, not just outside HWND.
    int left = static_cast<int>(frame.width), right = 0, top = static_cast<int>(frame.height), bottom = 0;
    for (int y = 0; y < static_cast<int>(frame.height); ++y) for (int x = 0; x < static_cast<int>(frame.width); ++x) {
        if (frame.bgraPremultiplied[y * frame.strideBytes + x * 4 + 3] > 220) {
            left = std::min(left,x); right = std::max(right,x); top = std::min(top,y); bottom = std::max(bottom,y);
            if (opaque.x < 0) opaque = {x,y};
        }
    }
    for (int y = top; y <= bottom && transparent.x < 0; ++y) for (int x = left; x <= right; ++x) {
        if (!mask[y * frame.width + x]) { transparent = {x,y}; break; }
    }
    Check(opaque.x >= 0 && transparent.x >= 0, "Find visible and transparent interior controls");
    AllowSetForegroundWindow(witness.process.dwProcessId);
    SetForegroundWindow(witness.window());
    Check(SetCursorPos(40, 50) != 0, "Move onto witness"); Mouse(MOUSEEVENTF_LEFTDOWN); Mouse(MOUSEEVENTF_LEFTUP);
    Check(GetForegroundWindow() == witness.window(), "Witness owns input focus before probe");
    const LONG beforeBlank = witness.state.value->leftClicks;
    const LONG overlayBefore = overlayState.clicks;
    Click(overlay, transparent);
    probe.Add(prefix + "/blank-cross-process", witness.state.value->leftClicks == beforeBlank + 1 && overlayState.clicks == overlayBefore);
    const LONG beforeOpaque = witness.state.value->leftClicks;
    Click(overlay, opaque);
    probe.Add(prefix + "/opaque-received", overlayState.clicks == overlayBefore + 1 && witness.state.value->leftClicks == beforeOpaque);
    probe.Add(prefix + "/click-no-focus-steal", GetForegroundWindow() == witness.window());
    const LONG beforeRight = overlayState.rights;
    const LONG menusBefore = overlayState.menusObserved;
    Click(overlay, opaque, true);
    probe.Add(prefix + "/native-context-menu", overlayState.rights == beforeRight + 1 &&
              overlayState.menusObserved == menusBefore + 1 && GetForegroundWindow() == witness.window());
    const LONG beforeKey = witness.state.value->keys;
    INPUT keys[2]{}; keys[0].type = keys[1].type = INPUT_KEYBOARD;
    keys[0].ki.wVk = keys[1].ki.wVk = VK_F24; keys[1].ki.dwFlags = KEYEVENTF_KEYUP;
    Check(SendInput(2, keys, sizeof(INPUT)) == 2, "Send F24 to owned witness"); Pump(100);
    probe.Add(prefix + "/keyboard-stays-behind", witness.state.value->keys == beforeKey + 1);
    RECT beforeDrag{}; GetWindowRect(overlay, &beforeDrag);
    POINT drag = opaque; ClientToScreen(overlay, &drag);
    SetCursorPos(drag.x, drag.y); Pump(20); Mouse(MOUSEEVENTF_LEFTDOWN);
    SetCursorPos(drag.x + 13, drag.y + 9); Pump(100); Mouse(MOUSEEVENTF_LEFTUP);
    RECT afterDrag{}; GetWindowRect(overlay, &afterDrag);
    probe.Add(prefix + "/drag-no-focus-steal", afterDrag.left == beforeDrag.left + 13 && afterDrag.top == beforeDrag.top + 9 && GetForegroundWindow() == witness.window());
    SetWindowPos(overlay, nullptr, beforeDrag.left, beforeDrag.top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
}
int RunProbe(const fs::path& root, const fs::path& output, bool allowSoftware, bool interactive) {
    fs::create_directories(output);
    Probe probe(output / "runtime-p0.json");
    probe.interactive = interactive;
    try {
        ComScope com; Check(SUCCEEDED(com.result), "Initialize COM");
        // Passive display mode never moves the pointer, changes foreground,
        // injects input, or captures whatever is behind the owned overlay.
        std::unique_ptr<CursorScope> cursor;
        std::unique_ptr<WitnessProcess> witness;
        if (interactive) {
            cursor = std::make_unique<CursorScope>();
            witness = std::make_unique<WitnessProcess>();
        }
        RegisterProbeClass(L"NiuMaP0Overlay", OverlayProc);
        OverlayState windowState;
        HWND window = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            L"NiuMaP0Overlay", L"Unpublished runtime P0", WS_POPUP, 100, 100, 240, 250,
            nullptr, nullptr, GetModuleHandleW(nullptr), &windowState);
        Check(window != nullptr, "Create composition overlay");
        D3D11Renderer renderer;
        const bool initialized = renderer.Initialize(window, 240, 250, allowSoftware);
        probe.adapterInfo = renderer.Adapter();
        probe.adapter = Narrow(renderer.Adapter().description); probe.software = renderer.Adapter().software;
        Check(initialized, renderer.LastErrorMessage());
        ShowWindow(window, SW_SHOWNOACTIVATE);
        std::vector<double> regionTimes, submitTimes;
        for (bool offwork : {false,true}) {
            p0::FixtureScene scene;
            Check(scene.Load(renderer,root,offwork), scene.LastError());
            PreparedMasks masks;
            std::uint64_t preparedBytes = 0;
            for (const auto& item : scene.Textures()) {
                const auto& image = item.second;
                auto prepared = PrepareAlphaMask({image.bgraPremultiplied.data(), image.bgraPremultiplied.size(),
                    image.width, image.height, image.strideBytes});
                Check(prepared.success, "Prepare source alpha: " + prepared.error);
                preparedBytes += prepared.storageBytes;
                probe.preparationMs += prepared.preparationMs;
                masks.emplace_back(item.first, std::move(prepared));
            }
            probe.preparedBytes = std::max(probe.preparedBytes, preparedBytes);
            std::uint64_t cpuBytes = 0;
            for (const auto& texture : scene.Textures()) cpuBytes += texture.second.bgraPremultiplied.size();
            probe.cpuTextureBytes = std::max(probe.cpuTextureBytes,cpuBytes);
            probe.textureBytes = std::max(probe.textureBytes,renderer.Stats().textureBytes);
            for (float scale : {1.0f,1.5f,2.0f}) {
                const int width = static_cast<int>(240 * scale), height = static_cast<int>(250 * scale);
                SetWindowPos(window,nullptr,100,100,width,height,SWP_NOZORDER | SWP_NOACTIVATE);
                Check(renderer.Resize(width,height),renderer.LastErrorMessage());
                const std::string prefix = scene.Name() + "-" + std::to_string(static_cast<int>(scale*100));
                for (int sample = 0; sample < 12; ++sample) {
                    const float phase = sample / 11.0f;
                    const auto quads = scene.Quads(phase,scale);
                    const auto beginRegion = Clock::now();
                    auto preparedRegion = RegionFor(width,height,quads,masks);
                    Check(preparedRegion.success, "Transform prepared alpha: " + preparedRegion.error);
                    const auto& region = preparedRegion.raster;
                    probe.conservativePixelsPeak = std::max(probe.conservativePixelsPeak,preparedRegion.stats.conservativePixels);
                    probe.rectangleCountPeak = std::max(probe.rectangleCountPeak,static_cast<std::uint64_t>(preparedRegion.stats.rectangleCount));
                    InstallRegion(window,preparedRegion);
                    const double regionMs = std::chrono::duration<double,std::milli>(Clock::now()-beginRegion).count();
                    regionTimes.push_back(regionMs);
                    const auto beginSubmit = Clock::now();
                    Check(renderer.Draw(quads,false),renderer.LastErrorMessage());
                    submitTimes.push_back(std::chrono::duration<double,std::milli>(Clock::now()-beginSubmit).count());
                    // Diagnostic-only readback is excluded from CPU submit timing.
                    PixelImage frame;
                    Check(renderer.Capture(frame),renderer.LastErrorMessage());
                    const auto mask = RegionMask(region);
                    std::size_t clippedVisible = 0, visible = 0, distantTransparent = 0;
                    unsigned clippedAlphaMax = 0;
                    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
                        const auto alpha = frame.bgraPremultiplied[y*frame.strideBytes+x*4+3];
                        if (alpha != 0) { ++visible; if (!mask[y*width+x]) { ++clippedVisible; clippedAlphaMax=std::max(clippedAlphaMax,static_cast<unsigned>(alpha)); } }
                        else if (mask[y*width+x]) {
                            bool nearVisible = false;
                            for (int dy=-2;dy<=2 && !nearVisible;++dy)
                                for (int dx=-2;dx<=2;++dx) {
                                    const int px=x+dx, py=y+dy;
                                    if (px>=0 && py>=0 && px<width && py<height &&
                                        frame.bgraPremultiplied[py*frame.strideBytes+px*4+3]!=0) {
                                        nearVisible=true; break;
                                    }
                                }
                            if (!nearVisible) ++distantTransparent;
                        }
                    }
                    probe.distantTransparentPixelsPeak=std::max(probe.distantTransparentPixelsPeak,static_cast<std::uint64_t>(distantTransparent));
                    probe.Add(prefix+"/alpha-"+std::to_string(sample), visible > 100 && clippedVisible == 0, regionMs);
                    probe.Add(prefix+"/no-distant-transparent-interception-"+std::to_string(sample), distantTransparent==0);
                    if (clippedVisible || distantTransparent)
                        std::cout << prefix << '/' << sample << " clipped=" << clippedVisible
                                  << " maxAlpha=" << clippedAlphaMax << " distant=" << distantTransparent << '\n';
                    std::string pngError;
                    if (sample==0 || sample==5 || sample==11) {
                        Check(p0::SavePng(output/(prefix+"-"+std::to_string(sample)+".png"),frame,pngError),pngError);
                        PixelImage compared = frame;
                        for (int y=0;y<height;++y) for(int x=0;x<width;++x) {
                            const auto offset=y*compared.strideBytes+x*4;
                            const bool shown=frame.bgraPremultiplied[offset+3]!=0;
                            compared.bgraPremultiplied[offset+0]=shown?0:255;
                            compared.bgraPremultiplied[offset+1]=shown && mask[y*width+x]?255:0;
                            compared.bgraPremultiplied[offset+2]=shown && !mask[y*width+x]?255:0;
                            compared.bgraPremultiplied[offset+3]=(shown||mask[y*width+x])?255:0;
                        }
                        Check(p0::SavePng(output/(prefix+"-"+std::to_string(sample)+"-region.png"),compared,pngError),pngError);
                    }
                    Check(renderer.Present(),renderer.LastErrorMessage()); Pump(30);
                    if (sample==0 && interactive) {
                        InteractionChecks(window,windowState,*witness,frame,region,prefix,probe);
                        Pump(100);
                        const auto crop = DesktopCrop(window);
                        if (!crop.bgraPremultiplied.empty())
                            Check(p0::SavePng(output/(prefix+"-desktop.png"),crop,pngError),pngError);
                    }
                }
            }
            scene.Clear(renderer);
            probe.Add(scene.Name()+"/resources-released",renderer.Stats().textureCount==0 && renderer.Stats().textureBytes==0);
        }
        const auto presentsBefore = renderer.Stats().presents;
        Pump(1000);
        probe.Add("idle-no-present",renderer.Stats().presents==presentsBefore);
        probe.captures = renderer.Stats().diagnosticReadbacks;
        probe.presentCount = renderer.Stats().presents;
        probe.regionSamples = regionTimes.size();
        for (double value : regionTimes) probe.regionMean += value / regionTimes.size();
        for (double value : submitTimes) probe.submitMean += value / submitTimes.size();
        std::sort(regionTimes.begin(),regionTimes.end());
        probe.regionP95 = regionTimes[static_cast<std::size_t>((regionTimes.size()-1)*0.95)];
        renderer.Shutdown(); DestroyWindow(window);
        const bool passed = std::all_of(probe.records.begin(),probe.records.end(),[](const auto& item){return item.ok;});
        std::cout << "P0 functional checks " << (passed?"passed":"failed") << "; softwareAdapter=" << probe.software << '\n';
        return passed?0:1;
    } catch (const std::exception& error) { probe.error=error.what(); std::cerr<<probe.error<<'\n'; return 1; }
}
