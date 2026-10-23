#include "storage_service.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iterator>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace niuma::windows::runtime {
namespace {
using namespace client::core;
using Bytes = std::vector<unsigned char>;
using Key = std::pair<std::string, std::string>;
using Changes = std::map<Key, std::optional<std::string>>;
constexpr std::size_t kMaximumFileBytes = 32 * 1024 * 1024;
std::atomic<std::uint64_t> sequence{0};

struct Failure { StorageFileStage stage; DWORD error; };
[[noreturn]] void Fail(StorageFileStage stage, DWORD error = GetLastError()) {
  throw Failure{stage, error ? error : ERROR_INVALID_DATA};
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

Bytes ReadHandle(HANDLE file, StorageFileStage stage) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info)) Fail(stage);
  if (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    Fail(stage, ERROR_INVALID_DATA);
  if (info.nFileSizeHigh || info.nFileSizeLow > kMaximumFileBytes)
    Fail(stage, ERROR_FILE_TOO_LARGE);
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) Fail(stage);
  Bytes bytes(info.nFileSizeLow);
  DWORD offset = 0;
  while (offset < bytes.size()) {
    DWORD read = 0;
    if (!ReadFile(file, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &read, nullptr))
      Fail(stage);
    if (!read) Fail(stage, ERROR_HANDLE_EOF);
    offset += read;
  }
  return bytes;
}

Bytes ReadFileBytes(const std::wstring& path, bool& existed, Handle& file,
                    StorageFileStage stage, bool allowMissing = true) {
  file.value = CreateFileW(path.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file.value == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (allowMissing && error == ERROR_FILE_NOT_FOUND) { existed = false; return {}; }
    Fail(stage, error);
  }
  existed = true;
  return ReadHandle(file.value, stage);
}

void WriteNew(const std::wstring& path, const Bytes& bytes, StorageFileStage stage, bool& created) {
  created = false;
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
      CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) Fail(stage);
  created = true;
  DWORD offset = 0;
  while (offset < bytes.size()) {
    DWORD written = 0;
    if (!WriteFile(file.value, bytes.data() + offset,
        static_cast<DWORD>(bytes.size() - offset), &written, nullptr)) Fail(stage);
    if (!written) Fail(stage, ERROR_WRITE_FAULT);
    offset += written;
  }
  if (!FlushFileBuffers(file.value)) Fail(stage);
  if (ReadHandle(file.value, stage) != bytes) Fail(stage, ERROR_CRC);
}

bool Space(char16_t c) { return c == u' ' || c == u'\t' || c == u'\r'; }
std::u16string Trim(std::u16string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), Space);
  const auto last = std::find_if_not(value.rbegin(), value.rend(), Space).base();
  return first < last ? std::u16string(first, last) : std::u16string{};
}
std::string Ascii(const std::u16string& text, bool lower = false) {
  std::string result;
  result.reserve(text.size());
  for (char16_t c : text) {
    if (c > 127) return {};  // Non-ASCII names remain untouched unknown fields.
    if (lower && c >= u'A' && c <= u'Z') c += u'a' - u'A';
    result.push_back(static_cast<char>(c));
  }
  return result;
}
std::u16string Units(const std::string& text) { return {text.begin(), text.end()}; }
struct Line { std::u16string text, ending; };
struct Document {
  Bytes prefix;
  bool wide = false;
  std::u16string newline = u"\r\n";
  std::vector<Line> lines;
};

Document Decode(const Bytes& bytes) {
  Document result;
  std::size_t start = 0;
  if (bytes.size() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) {
    result.wide = true; result.prefix = {0xff, 0xfe}; start = 2;
    if ((bytes.size() - 2) % 2) Fail(StorageFileStage::Parse, ERROR_INVALID_DATA);
  } else if (bytes.size() >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) {
    Fail(StorageFileStage::Parse, ERROR_NOT_SUPPORTED);
  } else if (bytes.size() >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) {
    result.prefix = {0xef, 0xbb, 0xbf}; start = 3;
  }
  std::u16string text;
  for (std::size_t i = start; i < bytes.size(); i += result.wide ? 2 : 1) {
    const char16_t unit = result.wide ? static_cast<char16_t>(bytes[i] | (bytes[i + 1] << 8)) : bytes[i];
    if (!unit) Fail(StorageFileStage::Parse, ERROR_INVALID_DATA);
    text.push_back(unit);
  }
  std::size_t begin = 0;
  bool foundNewline = false;
  for (std::size_t i = 0; i < text.size(); ++i) {
    if (text[i] != u'\n') continue;
    const bool cr = i > begin && text[i - 1] == u'\r';
    Line line{text.substr(begin, i - begin - (cr ? 1 : 0)), cr ? u"\r\n" : u"\n"};
    if (!foundNewline) { result.newline = line.ending; foundNewline = true; }
    result.lines.push_back(std::move(line)); begin = i + 1;
  }
  if (begin < text.size()) result.lines.push_back({text.substr(begin), {}});
  return result;
}

Bytes Encode(const Document& document) {
  Bytes result = document.prefix;
  for (const auto& line : document.lines) for (const auto* part : {&line.text, &line.ending})
    for (char16_t c : *part) {
      result.push_back(static_cast<unsigned char>(c & 255));
      if (document.wide) result.push_back(static_cast<unsigned char>(c >> 8));
    }
  if (result.size() > kMaximumFileBytes) Fail(StorageFileStage::Prepare, ERROR_FILE_TOO_LARGE);
  return result;
}

bool Section(const Line& line, std::string& name) {
  const auto text = Trim(line.text);
  if (text.empty() || text[0] != u'[') return false;
  const auto end = text.find(u']');
  if (end == std::u16string::npos) return false;
  name = Ascii(Trim(text.substr(1, end - 1)), true);
  return true;
}
bool Assignment(const Line& line, std::string& name, std::u16string& value, std::size_t* split = nullptr) {
  const auto text = Trim(line.text);
  if (text.empty() || text[0] == u';' || text[0] == u'[') return false;
  const auto equal = line.text.find(u'=');
  if (equal == std::u16string::npos) return false;
  name = Ascii(Trim(line.text.substr(0, equal)), true);
  value = Trim(line.text.substr(equal + 1));
  if (value.size() >= 2 && ((value.front() == u'"' && value.back() == u'"') ||
      (value.front() == u'\'' && value.back() == u'\''))) value = value.substr(1, value.size() - 2);
  if (split) *split = equal;
  return !name.empty();
}
using Values = std::map<Key, std::u16string>;
Values ValuesOf(const Document& document) {
  Values result;
  std::string section, key;
  std::u16string value;
  for (const auto& line : document.lines) {
    if (Section(line, section)) continue;
    if (Assignment(line, key, value)) result.emplace(Key{section, key}, value);
  }
  return result;
}

bool Unsigned(const std::u16string& text, std::uint64_t& value) {
  if (text.empty()) return false;
  value = 0;
  for (char16_t c : text) {
    if (c < u'0' || c > u'9') return false;
    const auto digit = static_cast<unsigned>(c - u'0');
    if (value > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return false;
    value = value * 10 + digit;
  }
  return true;
}
bool Signed(const std::u16string& text, std::int64_t& value) {
  const bool negative = !text.empty() && text[0] == u'-';
  std::uint64_t number = 0;
  if (!Unsigned(negative ? text.substr(1) : text, number)) return false;
  constexpr auto max = static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
  if (number > max + (negative ? 1u : 0u)) return false;
  value = negative ? (number == max + 1 ? std::numeric_limits<std::int64_t>::min()
                                      : -static_cast<std::int64_t>(number))
                   : static_cast<std::int64_t>(number);
  return true;
}
LocalDate Date(const std::string& text) {
  if (text.size() != 10 || text[4] != '-' || text[7] != '-') return 0;
  LocalDate result = 0;
  for (std::size_t i = 0; i < text.size(); ++i) {
    if (i == 4 || i == 7) continue;
    if (text[i] < '0' || text[i] > '9') return 0;
    result = result * 10 + static_cast<unsigned>(text[i] - '0');
  }
  return InputCore::ValidDate(result) ? result : 0;
}
std::string DateText(LocalDate date) {
  if (!InputCore::ValidDate(date)) Fail(StorageFileStage::Validate, ERROR_INVALID_DATA);
  auto text = std::to_string(date);
  text.insert(0, 8 - text.size(), '0');
  text.insert(4, "-"); text.insert(7, "-"); return text;
}
bool OffworkValue(const std::u16string& text, StorageOffworkDay& day) {
  const auto first = text.find(u','), second = text.find(u',', first == text.npos ? first : first + 1);
  if (first == text.npos || second == text.npos) return false;
  std::int64_t seconds = 0, target = 0, updated = 0;
  if (!Signed(Trim(text.substr(0, first)), seconds) ||
      !Signed(Trim(text.substr(first + 1, second - first - 1)), target) ||
      !Signed(Trim(text.substr(second + 1)), updated) ||
      seconds <= 0 || seconds > 172800 || target < 0 || target >= 1440 || updated <= 0) return false;
  day = {true, static_cast<int>(seconds), static_cast<int>(target), updated}; return true;
}

StorageFileState LoadState(const Document& document) {
  StorageFileState state;
  const auto values = ValuesOf(document);
  const auto get = [&](const char* section, const char* key) -> const std::u16string* {
    const auto entry = values.find({section, key});
    return entry == values.end() ? nullptr : &entry->second;
  };
  const auto integer = [&](const char* section, const char* key, std::int64_t fallback) {
    const auto* value = get(section, key); std::int64_t result = 0;
    return value && Signed(*value, result) ? result : fallback;
  };
  if (const auto* total = get("state", "total"))
    if (!Unsigned(*total, state.counts.total)) Fail(StorageFileStage::Parse, ERROR_INVALID_DATA);
  const auto* x = get("state", "x"); const auto* y = get("state", "y");
  std::int64_t px = 0, py = 0;
  if (x && y && Signed(*x, px) && Signed(*y, py) && px >= INT32_MIN && px <= INT32_MAX &&
      py >= INT32_MIN && py <= INT32_MAX) state.window = {true, static_cast<std::int32_t>(px), static_cast<std::int32_t>(py)};
  const auto scene = integer("state", "selected_scene", 0);
  state.appearance.selectedScene = scene >= 0 && scene <= 3 ? static_cast<int>(scene) : 0;
  if (const auto* pack = get("state", "selected_pack_id")) {
    state.appearance.selectedPackId = Ascii(*pack);
    if (!std::all_of(state.appearance.selectedPackId.begin(), state.appearance.selectedPackId.end(),
        [](unsigned char c) { return c >= 32 && c < 127; })) state.appearance.selectedPackId.clear();
  }
  state.autostart = {integer("state", "autostart_configured", 0) == 1,
                     integer("state", "autostart_enabled", 1) == 1};
  state.guide = {integer("state", "privacy_shown", 0) == 1, integer("state", "basic_guide_shown", 0) == 1};
  state.offwork.enabled = integer("offwork", "enabled", 0) == 1;
  const auto hour = integer("offwork", "hour", 18), minute = integer("offwork", "minute", 0);
  state.offwork.hour = hour >= 0 && hour < 24 ? static_cast<int>(hour) : 18;
  state.offwork.minute = minute >= 0 && minute < 60 ? static_cast<int>(minute) : 0;
  for (const auto& entry : values) {
    const LocalDate date = Date(entry.first.second);
    if (!date) continue;
    if (entry.first.first == "daily") {
      std::uint64_t count = 0;
      if (!Unsigned(entry.second, count)) Fail(StorageFileStage::Parse, ERROR_INVALID_DATA);
      state.counts.daily.emplace(date, count);
    } else if (entry.first.first == "offwork_daily") {
      StorageOffworkDay day;
      if (OffworkValue(entry.second, day)) state.offworkDays.emplace(date, day);
      // Legacy invalid offwork records remain uninterpreted bytes, as before.
    }
  }
  if (state.counts.daily.size() > InputCore::kMaximumDayCapacity ||
      state.offworkDays.size() > InputCore::kMaximumDayCapacity) Fail(StorageFileStage::Parse, ERROR_BUFFER_OVERFLOW);
  return state;
}

Changes MakeChanges(const StorageFileState& state) {
  // Apply the same structural constraints as the coalescing model. This also
  // rejects malformed external writes before a file is created or replaced.
  StorageState validate(state);
  Changes result;
  const auto put = [&](const char* section, const char* key, auto value) {
    result[{section, key}] = std::to_string(value);
  };
  put("state", "total", state.counts.total);
  if (state.window.present) { put("state", "x", state.window.x); put("state", "y", state.window.y); }
  put("state", "selected_scene", state.appearance.selectedScene);
  result[{"state", "selected_pack_id"}] = state.appearance.selectedPackId;
  put("state", "autostart_configured", state.autostart.configured);
  put("state", "autostart_enabled", state.autostart.enabled);
  put("state", "privacy_shown", state.guide.privacyShown);
  put("state", "basic_guide_shown", state.guide.basicGuideShown);
  put("offwork", "enabled", state.offwork.enabled);
  put("offwork", "hour", state.offwork.hour); put("offwork", "minute", state.offwork.minute);
  for (const auto& day : state.counts.daily) result[{"daily", DateText(day.first)}] = std::to_string(day.second);
  for (const auto& day : state.offworkDays) {
    if (!day.second.present) result[{"offwork_daily", DateText(day.first)}] = std::nullopt;
    else result[{"offwork_daily", DateText(day.first)}] = std::to_string(day.second.seconds) + "," +
        std::to_string(day.second.targetMinutes) + "," + std::to_string(day.second.updatedAt);
  }
  return result;
}

void Apply(Document& document, const Changes& changes) {
  Changes missing = changes;
  std::vector<Line> updated;
  updated.reserve(document.lines.size());
  std::string section, key;
  std::u16string value;
  for (auto& line : document.lines) {
    if (Section(line, section)) { updated.push_back(std::move(line)); continue; }
    std::size_t equal = 0;
    if (Assignment(line, key, value, &equal)) {
      const auto change = changes.find({section, key});
      if (change != changes.end()) {
        missing.erase(change->first);
        if (!change->second) continue;
        line.text = line.text.substr(0, equal + 1) + Units(*change->second);
      }
    }
    updated.push_back(std::move(line));
  }
  document.lines = std::move(updated);
  std::map<std::string, std::vector<Line>> additions;
  for (const auto& entry : missing) if (entry.second)
    additions[entry.first.first].push_back({Units(entry.first.second + "=" + *entry.second), document.newline});
  for (auto& group : additions) {
    std::size_t position = document.lines.size();
    bool found = false;
    for (std::size_t i = 0; i < document.lines.size(); ++i) {
      std::string name;
      if (!Section(document.lines[i], name)) continue;
      if (found) { position = i; break; }
      if (name == group.first) found = true;
    }
    if (position && document.lines[position - 1].ending.empty()) document.lines[position - 1].ending = document.newline;
    if (!found) group.second.insert(group.second.begin(), {Units("[" + group.first + "]"), document.newline});
    document.lines.insert(document.lines.begin() + static_cast<std::ptrdiff_t>(position),
        std::make_move_iterator(group.second.begin()), std::make_move_iterator(group.second.end()));
  }
}

void ValidateChanges(const Document& document, const Changes& changes) {
  const auto values = ValuesOf(document);
  for (const auto& change : changes) {
    const auto found = values.find(change.first);
    if (change.second ? (found == values.end() || found->second != Units(*change.second)) : found != values.end())
      Fail(StorageFileStage::Validate, ERROR_INVALID_DATA);
  }
  (void)LoadState(document);
}
}  // namespace

struct StorageService::Impl {
  StorageServiceOptions options;
  std::thread worker;
  mutable std::mutex mutex;
  std::condition_variable wake;
  StorageServiceStart startup;
  std::shared_ptr<const StorageWrite> write;
  StorageFileResult result;
  StorageVersions lastVersions{};
  std::uint64_t lastId = 0;
  bool attempted = false, ready = false, started = false, stopping = false, stopped = false, completed = false;
  Bytes baseline;
  bool existed = false, backupMade = false;
  std::wstring suffix, backupPath;

  StorageFileResult Save(const StorageWrite& request) {
    StorageFileResult output;
    output.id = request.id;
    std::wstring temporary;
    bool temporaryOwned = false;
    try {
      temporary = options.path + suffix + L".tmp";
      const auto changes = MakeChanges(request.state);
      Handle original;
      bool sourceExists = false;
      const auto source = ReadFileBytes(options.path, sourceExists, original, StorageFileStage::Read);
      if (sourceExists != existed || source != baseline) Fail(StorageFileStage::Read, ERROR_REVISION_MISMATCH);
      auto document = Decode(source);
      Apply(document, changes);
      auto candidate = Encode(document);
      ValidateChanges(Decode(candidate), changes);
      if (sourceExists && !backupMade) {
        bool backupOwned = false;
        try { WriteNew(backupPath, source, StorageFileStage::Backup, backupOwned); }
        catch (...) { if (backupOwned) DeleteFileW(backupPath.c_str()); throw; }
        backupMade = true;
      }
      // CREATE_NEW prevents accidental adoption/deletion of unrelated files.
      WriteNew(temporary, candidate, StorageFileStage::Prepare, temporaryOwned);
      if (sourceExists) {
        if (!ReplaceFileW(options.path.c_str(), temporary.c_str(), nullptr, 0, nullptr, nullptr))
          Fail(StorageFileStage::Replace);
      } else if (!MoveFileExW(temporary.c_str(), options.path.c_str(), MOVEFILE_WRITE_THROUGH)) {
        Fail(StorageFileStage::Replace);
      }
      temporaryOwned = false;
      output.replacementOccurred = true;
      // Record the installed bytes before final verification: a failed final
      // flush must allow a later serialized latest-state retry, not an old replay.
      baseline = std::move(candidate); existed = true;
      Handle final(CreateFileW(options.path.c_str(), GENERIC_READ | GENERIC_WRITE,
          FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      if (final.value == INVALID_HANDLE_VALUE) Fail(StorageFileStage::Flush);
      if (!FlushFileBuffers(final.value)) Fail(StorageFileStage::Flush);
      if (ReadHandle(final.value, StorageFileStage::Verify) != baseline) Fail(StorageFileStage::Verify, ERROR_CRC);
      output.success = true;
    } catch (const Failure& failure) {
      output.stage = failure.stage; output.error = failure.error;
    } catch (const std::bad_alloc&) {
      output.stage = StorageFileStage::Worker; output.error = ERROR_NOT_ENOUGH_MEMORY;
    } catch (...) {
      output.stage = StorageFileStage::Validate; output.error = ERROR_INVALID_DATA;
    }
    if (temporaryOwned) DeleteFileW(temporary.c_str());
    return output;
  }

  void Run() noexcept {
    try {
      Handle file;
      baseline = ReadFileBytes(options.path, existed, file, StorageFileStage::Open);
      startup.initial = LoadState(Decode(baseline));
      startup.existed = existed;
      startup.started = true;
    } catch (const Failure& failure) { startup.error = failure.error; startup.stage = failure.stage; }
      catch (const std::bad_alloc&) { startup.error = ERROR_NOT_ENOUGH_MEMORY; startup.stage = StorageFileStage::Worker; }
      catch (...) { startup.error = ERROR_INVALID_DATA; startup.stage = StorageFileStage::Parse; }
    std::unique_lock<std::mutex> lock(mutex);
    started = startup.started; ready = true; wake.notify_all();
    if (started) for (;;) {
      wake.wait(lock, [&] { return stopping || (write && !completed); });
      if (write && !completed) {
        const auto request = write;
        lock.unlock();
        auto outcome = Save(*request);
        lock.lock();
        result = outcome; completed = true;
        if (options.notificationWindow && !PostMessageW(options.notificationWindow,
            options.notificationMessage, 0, 0)) result.notificationError = GetLastError();
        wake.notify_all();
      }
      if (stopping) break;
    }
    stopped = true; started = false; wake.notify_all();
  }
};

StorageService::StorageService() : impl_(std::make_unique<Impl>()) {}
StorageService::~StorageService() {
  Stop(0);
  // Never detach a worker that owns the file or let it touch destroyed state.
  // The UI must honor Stop's pending result before destroying this service.
  if (impl_->worker.joinable()) impl_->worker.join();
}

StorageServiceStart StorageService::Start(const StorageServiceOptions& options) {
  auto& self = *impl_;
  if (self.attempted) return {false, false, ERROR_ALREADY_INITIALIZED, StorageFileStage::Worker, {}};
  self.attempted = true;
  if (options.path.empty() || (options.notificationWindow && options.notificationMessage < WM_APP))
    return {false, false, ERROR_INVALID_PARAMETER, StorageFileStage::Open, {}};
  wchar_t full[32768]{};
  const DWORD length = GetFullPathNameW(options.path.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr);
  if (!length || length >= std::size(full) || options.path != full)
    return {false, false, ERROR_BAD_PATHNAME, StorageFileStage::Open, {}};
  self.options = options;
  self.suffix = L".runtime-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
      std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++sequence);
  self.backupPath = options.path + self.suffix + L".original.bak";
  try { self.worker = std::thread([&self] { self.Run(); }); }
  catch (...) { return {false, false, ERROR_NOT_ENOUGH_MEMORY, StorageFileStage::Worker, {}}; }
  std::unique_lock<std::mutex> lock(self.mutex);
  self.wake.wait(lock, [&] { return self.ready; });
  return self.startup;
}

StorageSubmit StorageService::TrySubmit(std::shared_ptr<const StorageWrite> write) noexcept {
  auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  if (self.stopping) return StorageSubmit::Stopping;
  if (!self.started) return StorageSubmit::NotStarted;
  if (self.write) return StorageSubmit::Busy;
  if (!write || !write->id) return StorageSubmit::Invalid;
  if (write->id <= self.lastId) return StorageSubmit::Stale;
  for (std::size_t i = 0; i < write->versions.size(); ++i)
    if (write->versions[i] < self.lastVersions[i]) return StorageSubmit::Stale;
  self.lastId = write->id; self.lastVersions = write->versions;
  self.write = std::move(write); self.completed = false;
  self.wake.notify_one();
  return StorageSubmit::Accepted;
}

bool StorageService::TryConsumeResult(StorageFileResult& result) noexcept {
  auto& self = *impl_;
  std::lock_guard<std::mutex> lock(self.mutex);
  if (!self.completed) return false;
  result = self.result; self.completed = false; self.write.reset();
  return true;
}

StorageServiceStop StorageService::Stop(DWORD timeoutMs) noexcept {
  auto& self = *impl_;
  std::unique_lock<std::mutex> lock(self.mutex);
  self.stopping = true; self.wake.notify_all();
  if (!self.worker.joinable()) self.stopped = true;
  if (!self.stopped && timeoutMs && timeoutMs != INFINITE)
    self.wake.wait_for(lock, std::chrono::milliseconds(timeoutMs), [&] { return self.stopped; });
  StorageServiceStop output;
  output.stopped = self.stopped;
  output.pendingId = !self.stopped && self.write ? self.write->id : 0;
  if (self.stopped && self.completed) {
    output.hasResult = true; output.result = self.result;
    self.completed = false; self.write.reset();
  }
  lock.unlock();
  if (output.stopped && self.worker.joinable()) self.worker.join();
  return output;
}

bool StorageService::running() const noexcept {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->started && !impl_->stopping;
}
const std::wstring& StorageService::backup_path() const noexcept { return impl_->backupPath; }

}  // namespace niuma::windows::runtime
