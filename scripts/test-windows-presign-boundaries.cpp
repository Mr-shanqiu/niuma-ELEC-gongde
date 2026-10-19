#ifdef NDEBUG
#undef NDEBUG
#endif
#define wWinMain NiuMaUnusedApplicationEntry
#include "../src/windows/app.cpp"
#undef wWinMain
#include <cassert>
#include <iostream>

static LRESULT CALLBACK Reject(HWND w, UINT m, WPARAM a, LPARAM b) {
  if (m == WM_COPYDATA) return FALSE;
  return DefWindowProcW(w, m, a, b);
}

static std::vector<std::wstring> processed;
static void TestImport(HWND window, const std::wstring& path) {
  processed.push_back(path);
  // A nested message loop (e.g. a modal import result) cannot process twice.
  DrainPendingImport(window, TestImport);
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wstring(argv[1]) == L"--register") {
    std::wstring error;
    assert(niuma::RegisterPackFileAssociations(argv[2], &error));
    return 0;
  }
  assert(argc == 2);
  gIsolatedAcceptance = true;
  gAcceptanceRoot = argv[1];
  std::filesystem::create_directories(gAcceptanceRoot);
  const auto path = DataPath();
  // Both timer-first (switch only) and input-first (switch then increment),
  // month/year rollover, restart, and failed save followed by another day.
  gState.currentDay = L"2026-10-31";
  gState.total = 100; gState.todayTotal = 40; gState.dirty = true;
  assert(EnsureDay(L"2026-11-01"));
  assert(ReadDailyTotal(L"2026-10-31") == 40 && gState.todayTotal == 0);
  ++gState.total; ++gState.todayTotal;
  assert(!EnsureDay(L"2026-11-01"));
  assert(!SaveCountState(gAcceptanceRoot + L"\\missing\\data.ini"));
  assert(gState.pendingDailyTotals.at(L"2026-10-31") == 40);
  assert(EnsureDay(L"2026-11-02"));
  ++gState.total; ++gState.todayTotal;
  SaveState();
  assert(!gState.dirty && gState.pendingDailyTotals.empty());
  gState.currentDay.clear(); gState.todayTotal = 0;
  assert(ReadDailyTotal(L"2026-10-31") == 40);
  assert(ReadDailyTotal(L"2026-11-01") == 1);
  assert(ReadDailyTotal(L"2026-11-02") == 1);
  assert(GetPrivateProfileIntW(L"state", L"total", 0, path.c_str()) == 102);
  EnsureDay(L"2026-12-31"); gState.todayTotal = 9;
  EnsureDay(L"2027-01-01"); gState.todayTotal = 2; gState.total = 113;
  SaveState(); gState.currentDay.clear(); gState.todayTotal = 0;
  assert(ReadDailyTotal(L"2026-12-31") == 9 && ReadDailyTotal(L"2027-01-01") == 2);
  // A directory instead of an INI deterministically fails even on an admin runner.
  const auto blocked = std::filesystem::path(path);
  std::filesystem::remove(blocked); std::filesystem::create_directory(blocked);
  gState.dirty = true; EnsureDay(L"2027-01-02"); gState.todayTotal = 7;
  SaveState(); assert(gState.dirty && !gState.pendingDailyTotals.empty());
  EnsureDay(L"2027-01-03"); gState.todayTotal = 4;
  std::filesystem::remove(blocked); SaveState(); assert(!gState.dirty);
  gState.currentDay.clear(); gState.todayTotal = 0;
  assert(ReadDailyTotal(L"2027-01-02") == 7 && ReadDailyTotal(L"2027-01-03") == 4);

  WNDCLASSW cls{}; cls.hInstance = GetModuleHandleW(nullptr);
  cls.lpfnWndProc = WindowProcedure; cls.lpszClassName = L"NiuMaPresignReceiver";
  assert(RegisterClassW(&cls));
  HWND receiver = CreateWindowW(cls.lpszClassName, L"", 0, 0, 0, 0, 0,
      HWND_MESSAGE, nullptr, cls.hInstance, nullptr);
  assert(receiver);
  for (const auto* extension : {L".nmgpack", L".nmgpacks", L".nmgtext"}) {
    std::wstring file = L"C:\\fixture" + std::wstring(extension);
    // Both pre-window warning states fail visibly in the caller (return false).
    assert(!TransferImport(nullptr, file, 50));
    assert(!TransferImport(nullptr, file, 50));
    // During initialization requests to an existing window are queued and acked.
    assert(TransferImport(receiver, file, 50));
    assert(gPendingImports.back() == file);
  }
  assert(gPendingImports.size() == 3);
  WindowProcedure(receiver, kImportQueuedMessage, 0, 0);
  assert(gPendingImports.size() == 3); // not ready: never processes startup queue
  assert(!TransferImport(receiver, L"C:\\fixture.txt", 50));
  assert(gPendingImports.size() == 3);
  cls.lpszClassName = L"NiuMaPresignReject"; cls.lpfnWndProc = Reject;
  assert(RegisterClassW(&cls));
  HWND reject = CreateWindowW(cls.lpszClassName, L"", 0, 0,0,0,0, HWND_MESSAGE,
      nullptr, cls.hInstance, nullptr);
  assert(reject && !TransferImport(reject, L"C:\\fixture.nmgtext", 50));
  DestroyWindow(reject);
  gImportReady = true;
  for (int i = 0; i < 5; ++i) DrainPendingImport(receiver, TestImport);
  assert(processed.size() == 3 && gPendingImports.empty() && !gImportActive);
  assert(processed[0] == L"C:\\fixture.nmgpack" && processed[1] == L"C:\\fixture.nmgpacks" && processed[2] == L"C:\\fixture.nmgtext");
  DestroyWindow(receiver);
  std::cout << "PASS: real count persistence across dates/failure/restart; three-file transfer acknowledgment, startup failure and queue validation. No hooks or user profile.\n";
}
