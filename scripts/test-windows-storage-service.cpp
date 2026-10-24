#include "../src/windows/runtime/storage_service.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using namespace niuma::client::core;
using namespace niuma::windows::runtime;
using Bytes = std::vector<unsigned char>;

#define CHECK(condition) do { if (!(condition)) throw std::runtime_error( \
    std::string("line ") + std::to_string(__LINE__) + ": " #condition); } while (false)

struct Directory {
  std::filesystem::path path;
  Directory() {
    wchar_t root[MAX_PATH]{};
    CHECK(GetTempPathW(MAX_PATH, root));
    for (unsigned i = 0; i < 100; ++i) {
      path = std::filesystem::path(root) / (L"niuma-storage-test-" +
          std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(i));
      if (CreateDirectoryW(path.c_str(), nullptr)) return;
      CHECK(GetLastError() == ERROR_ALREADY_EXISTS);
    }
    throw std::runtime_error("could not create private test directory");
  }
  ~Directory() { std::error_code error; std::filesystem::remove_all(path, error); }
  std::wstring File(const wchar_t* name = L"data.ini") const { return (path / name).wstring(); }
};

Bytes Read(const std::wstring& path) {
  std::ifstream file(std::filesystem::path(path), std::ios::binary);
  CHECK(file.good());
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
void Write(const std::wstring& path, const Bytes& bytes) {
  std::ofstream file(std::filesystem::path(path), std::ios::binary | std::ios::trunc);
  CHECK(file.good());
  file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  file.close(); CHECK(file.good());
}
Bytes Ansi(const std::string& text) { return {text.begin(), text.end()}; }
Bytes Wide(const std::u16string& text) {
  Bytes result{0xff, 0xfe};
  for (char16_t c : text) { result.push_back(static_cast<unsigned char>(c & 255)); result.push_back(static_cast<unsigned char>(c >> 8)); }
  return result;
}
bool Contains(const Bytes& bytes, const Bytes& part) {
  return std::search(bytes.begin(), bytes.end(), part.begin(), part.end()) != bytes.end();
}
std::wstring Profile(const std::wstring& path, const wchar_t* section, const wchar_t* key) {
  wchar_t result[512]{};
  GetPrivateProfileStringW(section, key, L"<missing>", result,
      static_cast<DWORD>(std::size(result)), path.c_str());
  return result;
}
StorageFileResult Wait(StorageService& service) {
  const auto deadline = GetTickCount64() + 10000;
  StorageFileResult result;
  while (!service.TryConsumeResult(result)) {
    CHECK(GetTickCount64() < deadline);
    Sleep(1);
  }
  return result;
}
std::shared_ptr<StorageWrite> Request(const StorageFileState& state, std::uint64_t id) {
  auto request = std::make_shared<StorageWrite>();
  request->id = id; request->versions.fill(id); request->state = state;
  return request;
}

void AnsiHistoryAndUnknownBytes() {
  Directory directory;
  const auto path = directory.File();
  const auto original = Ansi("; keep comment\r\n[STATE]\r\ntotal=41\r\nx=-200\r\ny=70\r\n"
      "selected_scene=2\r\nselected_pack_id=official.offwork-button\r\nfuture = unchanged\r\n"
      "[daily]\r\n2026-10-22=7\r\n2026-10-23=33\r\n2026-10-24=1\r\nnot-a-date=opaque\r\n"
      "[offwork_daily]\r\n2026-10-23=600,1080,1792800000\r\ninvalid-key=future-format\r\n"
      "[future-section]\r\nopaque=\x81\xa0 raw\r\n");
  Write(path, original);
  StorageService service;
  const auto start = service.Start({path});
  CHECK(start.started && start.existed && start.initial.counts.daily.size() == 3);
  CHECK(start.initial.counts.total == 41 && start.initial.window.x == -200);
  CHECK(start.initial.autoHideFullscreen);
  CHECK(start.initial.appearance.selectedScene == 2);
  CHECK(start.initial.appearance.selectedPackId == "official.offwork-button");
  CHECK(start.initial.offworkDays.at(20261023).seconds == 600);
  auto request = Request(start.initial, 1);
  request->state.counts.total = 44;
  request->state.counts.daily[20261024] = 3;
  request->state.counts.daily[20261025] = 1;
  request->state.window = {true, -1000, 90};
  request->state.guide = {true, true};
  request->state.autostart = {true, false};
  request->state.offwork = {true, 19, 30};
  request->state.autoHideFullscreen = false;
  request->state.offworkDays[20261023] = {};  // Explicit deletion, not 0,1080,...
  request->state.offworkDays[20261024] = {true, 120, 1170, 1792886400};
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  CHECK(service.TrySubmit(Request(request->state, 2)) == StorageSubmit::Busy);
  const auto result = Wait(service);
  CHECK(result.id == 1 && result.success && result.replacementOccurred);
  CHECK(Read(service.backup_path()) == original);
  const auto saved = Read(path);
  CHECK(saved[0] == ';');
  CHECK(Contains(saved, Ansi("future = unchanged\r\n")));
  CHECK(Contains(saved, Ansi("[future-section]\r\nopaque=\x81\xa0 raw\r\n")));
  CHECK(Contains(saved, Ansi("not-a-date=opaque\r\n")));
  CHECK(Profile(path, L"state", L"total") == L"44");
  CHECK(Profile(path, L"state", L"x") == L"-1000");
  CHECK(Profile(path, L"state", L"autostart_enabled") == L"0");
  CHECK(Profile(path, L"state", L"basic_guide_shown") == L"1");
  CHECK(Profile(path, L"state", L"auto_hide_fullscreen") == L"0");
  CHECK(Profile(path, L"daily", L"2026-10-22") == L"7");
  CHECK(Profile(path, L"daily", L"2026-10-25") == L"1");
  CHECK(Profile(path, L"offwork_daily", L"2026-10-23") == L"<missing>");
  CHECK(Profile(path, L"offwork_daily", L"2026-10-24") == L"120,1170,1792886400");
  CHECK(service.Stop().stopped);
  StorageService reopen;
  const auto reopened = reopen.Start({path});
  CHECK(reopened.started && reopened.initial.counts.daily.size() == 4);
  CHECK(!reopened.initial.autoHideFullscreen);
  CHECK(reopened.initial.offworkDays.count(20261023) == 0);
  CHECK(reopened.initial.offworkDays.at(20261024).seconds == 120);
  CHECK(reopen.Stop().stopped);
}

void Utf16PreservesEncodingAndUnknownText() {
  Directory directory;
  const auto path = directory.File();
  const auto original = Wide(u"; 中文注释\n[state]\ntotal=5\nselected_pack_id=official.woodfish-sample\n"
      u"自定义键=未改动\n[daily]\n2026-10-24=5\n[扩展节]\n文字=继续保留");
  Write(path, original);
  StorageService service;
  const auto start = service.Start({path});
  CHECK(start.started && start.initial.counts.total == 5);
  auto request = Request(start.initial, 1);
  request->state.counts.total = 6; request->state.counts.daily[20261024] = 6;
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  CHECK(Wait(service).success);
  CHECK(Read(service.backup_path()) == original);
  const auto output = Read(path);
  CHECK(output.size() % 2 == 0 && output[0] == 0xff && output[1] == 0xfe);
  auto unknown = Wide(u"自定义键=未改动\n"); unknown.erase(unknown.begin(), unknown.begin() + 2);
  CHECK(Contains(output, unknown));
  unknown = Wide(u"[扩展节]\n文字=继续保留"); unknown.erase(unknown.begin(), unknown.begin() + 2);
  CHECK(Contains(output, unknown));
  CHECK(Profile(path, L"state", L"total") == L"6");
  CHECK(Profile(path, L"扩展节", L"文字") == L"继续保留");
  CHECK(service.Stop().stopped);
}

void FirstRunAndNativeAnsiCompatibility() {
  Directory directory;
  const auto path = directory.File();
  StorageService service;
  const auto start = service.Start({path});
  CHECK(start.started && !start.existed && !start.initial.window.present);
  CHECK(!start.initial.autostart.configured && start.initial.autostart.enabled);
  auto request = Request(start.initial, 1);
  request->state.counts.daily[20261024] = 0;
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  const auto stop = service.Stop(10000);
  CHECK(stop.stopped && stop.hasResult && stop.result.success && stop.result.id == 1);
  CHECK(!service.Stop(0).hasResult);
  CHECK(!std::filesystem::exists(service.backup_path()));
  const auto created = Read(path);
  CHECK(created[0] == '[' && Profile(path, L"state", L"total") == L"0");
  CHECK(Profile(path, L"state", L"x") == L"<missing>");
  // The legacy Win32 API creates ANSI files when no BOM/file existed. Only
  // fixture setup uses profile writes; never mix them with an active service.
  const auto legacy = directory.File(L"legacy.ini");
  CHECK(WritePrivateProfileStringW(L"state", L"total", L"123", legacy.c_str()));
  CHECK(WritePrivateProfileStringW(L"daily", L"2026-10-24", L"123", legacy.c_str()));
  const auto nativeOriginal = Read(legacy);
  CHECK(nativeOriginal[0] != 0xff);
  StorageService native;
  const auto loaded = native.Start({legacy});
  CHECK(loaded.started && loaded.initial.counts.total == 123);
  auto update = Request(loaded.initial, 1); update->state.guide = {true, true};
  CHECK(native.TrySubmit(update) == StorageSubmit::Accepted && Wait(native).success);
  CHECK(Read(native.backup_path()) == nativeOriginal);
  CHECK(Read(legacy)[0] != 0xff);
  CHECK(native.Stop().stopped);
}

void SingleSlotAndVersionAcknowledgement() {
  Directory directory;
  StorageService service;
  const auto start = service.Start({directory.File()});
  CHECK(start.started);
  StorageState state(start.initial);
  CHECK(state.UpdateWindow({true, 10, 20}, 0) == StorageUpdate::Changed);
  auto first = state.BeginWrite(0, true);
  CHECK(first && service.TrySubmit(first) == StorageSubmit::Accepted);
  CHECK(state.UpdateWindow({true, 100, 200}, 1) == StorageUpdate::Changed);
  CHECK(!state.BeginWrite(1, true));
  CHECK(service.TrySubmit(first) == StorageSubmit::Busy);
  const auto result = Wait(service);
  CHECK(result.success && state.CompleteWrite(result.id, result.success, 2));
  CHECK(state.dirty());  // Older success cannot acknowledge the newer position.
  CHECK(service.TrySubmit(first) == StorageSubmit::Stale);
  auto stale = Request(state.current(), 100); stale->versions.fill(0);
  CHECK(service.TrySubmit(stale) == StorageSubmit::Stale);
  auto latest = state.BeginWrite(2, true);
  CHECK(latest && service.TrySubmit(latest) == StorageSubmit::Accepted);
  const auto second = Wait(service);
  CHECK(second.success && state.CompleteWrite(second.id, true, 3) && !state.dirty());
  CHECK(Profile(directory.File(), L"state", L"x") == L"100");
  CHECK(service.Stop().stopped);
}

void FailedReplacementKeepsOriginalAndCanRetry() {
  Directory directory;
  const auto path = directory.File();
  const auto original = Ansi("[state]\r\ntotal=8\r\n[daily]\r\n2026-10-24=8\r\n");
  Write(path, original);
  StorageService service;
  const auto start = service.Start({path});
  CHECK(start.started);
  // Real sharing violation at ReplaceFile, after the candidate has been
  // written/validated/flushed. The original can be read but not renamed.
  HANDLE blocker = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  CHECK(blocker != INVALID_HANDLE_VALUE);
  auto request = Request(start.initial, 1);
  request->state.counts.total = 9; request->state.counts.daily[20261024] = 9;
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  const auto result = Wait(service);
  CHECK(!result.success && !result.replacementOccurred && result.stage == StorageFileStage::Replace);
  CHECK(Read(path) == original && Read(service.backup_path()) == original);
  CHECK(CloseHandle(blocker));
  request = Request(request->state, 2);
  request->state.counts.total = 10; request->state.counts.daily[20261024] = 10;
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted && Wait(service).success);
  CHECK(Profile(path, L"state", L"total") == L"10");
  CHECK(Read(service.backup_path()) == original);  // Backup is never replaced by an intermediate save.
  CHECK(service.Stop().stopped);
}

void ExternalChangeAndInvalidStateNeverOverwrite() {
  Directory directory;
  const auto path = directory.File();
  const auto original = Ansi("[state]\ntotal=1\n[daily]\n2026-10-24=1\n");
  Write(path, original);
  StorageService service;
  const auto start = service.Start({path});
  CHECK(start.started);
  const auto externallyChanged = Ansi("[state]\ntotal=7\n[daily]\n2026-10-24=7\n");
  Write(path, externallyChanged);
  auto request = Request(start.initial, 1);
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  auto result = Wait(service);
  CHECK(!result.success && result.error == ERROR_REVISION_MISMATCH && Read(path) == externallyChanged);
  Write(path, original);
  request = Request(start.initial, 2); request->state.offwork.hour = 25;
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  result = Wait(service);
  CHECK(!result.success && Read(path) == original);
  CHECK(service.Stop().stopped);
  const auto invalid = Ansi("[state]\ntotal=not-a-number\n");
  Write(path, invalid);
  StorageService corrupt;
  const auto failed = corrupt.Start({path});
  CHECK(!failed.started && failed.stage == StorageFileStage::Parse && Read(path) == invalid);
  CHECK(corrupt.Stop().stopped);
}

void BoundedStopNeverCancelsOrReplays() {
  Directory directory;
  StorageService service;
  const auto start = service.Start({directory.File()});
  CHECK(start.started);
  auto request = Request(start.initial, 1);
  for (LocalDate date = 20260101; date <= 20261231; ++date)
    if (InputCore::ValidDate(date)) request->state.counts.daily[date] = 1;
  request->state.counts.total = request->state.counts.daily.size();
  CHECK(service.TrySubmit(request) == StorageSubmit::Accepted);
  const auto before = GetTickCount64();
  auto stop = service.Stop(0);
  CHECK(GetTickCount64() - before < 1000);
  CHECK(service.TrySubmit(Request(request->state, 2)) == StorageSubmit::Stopping);
  if (!stop.stopped) {
    // Keep the instance alive. A pending attempt remains pending; it is never
    // acknowledged as failed merely because the zero-wait poll returned.
    CHECK(stop.pendingId == 1);
    stop = service.Stop(10000);
  }
  CHECK(stop.stopped && stop.hasResult && stop.result.id == 1 && stop.result.success);
  CHECK(Profile(directory.File(), L"daily", L"2026-12-31") == L"1");
}
}  // namespace

int main() {
  try {
    const struct { const char* name; void (*run)(); } cases[] = {
      {"ANSI history, unknown bytes, all domains and tombstones", AnsiHistoryAndUnknownBytes},
      {"UTF16 encoding and unknown Unicode text", Utf16PreservesEncodingAndUnknownText},
      {"first-run and native profile ANSI compatibility", FirstRunAndNativeAnsiCompatibility},
      {"single slot and old/new version acknowledgements", SingleSlotAndVersionAcknowledgement},
      {"real replacement failure preserves original and retries latest", FailedReplacementKeepsOriginalAndCanRetry},
      {"external modification and invalid snapshots are not overwritten", ExternalChangeAndInvalidStateNeverOverwrite},
      {"bounded stop retains the actual in-flight attempt", BoundedStopNeverCancelsOrReplays}
    };
    for (const auto& test : cases) { test.run(); std::cout << "PASS " << test.name << '\n'; }
    std::cout << "PASS " << std::size(cases) << " storage service cases (private temporary directories only)\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL " << error.what() << '\n'; return 1;
  }
}
