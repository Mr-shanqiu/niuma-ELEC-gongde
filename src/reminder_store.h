#pragma once

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <io.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace niuma::reminder {

struct HistoryEntry {
  std::string id;
  std::int64_t shown_utc = 0;
};

struct PersistentState {
  std::string daily_date;
  unsigned daily_count = 0;
  std::string warm_date;
  bool warm_used = false;
  std::int64_t last_show_utc = 0;
  std::int64_t quiet_until_utc = 0;
  bool segment_consumed = false;
  bool clock_guard = false;
  std::vector<HistoryEntry> history;
};

enum class StoreResult { Success, LimitReached, ClockGuard, InvalidState, IoError };

class ReminderStore {
 public:
  explicit ReminderStore(std::filesystem::path directory) : directory_(std::move(directory)) {}

  bool IsRecentlyShown(const char* id, std::int64_t now_utc) {
    if (id == nullptr || !EnsureDirectory()) return true;
    FileLock lock(directory_ / "state.lock");
    if (!lock.locked()) return true;
    PersistentState state;
    bool recovered = false;
    if (!Load(&state, &recovered)) return true;
    if (recovered) {
      state.quiet_until_utc = now_utc + 7 * 24 * 60 * 60;
      state.clock_guard = true;
      if (!WriteState(state)) return true;
      return true;
    }
    const bool futureHistory = std::any_of(state.history.begin(), state.history.end(),
        [now_utc](const HistoryEntry& entry) {
          return static_cast<long double>(entry.shown_utc) -
              static_cast<long double>(now_utc) > 120.0L;
        });
    if (state.clock_guard || now_utc < state.quiet_until_utc ||
        IsWallTimeBefore(state.last_show_utc, now_utc) || futureHistory) {
      if (IsWallTimeBefore(state.last_show_utc, now_utc)) {
        state.clock_guard = true;
        WriteState(state);
      }
      return true;
    }
    for (const auto& entry : state.history) {
      if (entry.id == id && now_utc >= entry.shown_utc &&
          now_utc - entry.shown_utc < 7 * 24 * 60 * 60) return true;
    }
    return false;
  }

  bool ReadSelectionHistory(const char* local_date, std::int64_t now_utc,
                            std::unordered_set<std::string>* recent_ids,
                            bool* warm_used_today) {
    if (!ValidDate(local_date) || recent_ids == nullptr || warm_used_today == nullptr ||
        !EnsureDirectory()) return false;
    FileLock lock(directory_ / "state.lock");
    if (!lock.locked()) return false;
    PersistentState state;
    bool recovered = false;
    if (!Load(&state, &recovered)) return false;
    if (recovered) {
      state.quiet_until_utc = now_utc + 7 * 24 * 60 * 60;
      state.clock_guard = true;
      WriteState(state);
      return false;
    }
    const bool wallTimeBack = IsWallTimeBefore(state.last_show_utc, now_utc);
    const bool localDateBack = state.daily_date > local_date;
    if (wallTimeBack) {
      state.clock_guard = true;
      WriteState(state);
      return false;
    }
    if (state.clock_guard || localDateBack || now_utc < state.quiet_until_utc) return false;
    recent_ids->clear();
    for (const auto& entry : state.history) {
      if (now_utc < entry.shown_utc) {
        state.clock_guard = true;
        WriteState(state);
        return false;
      }
      if (now_utc - entry.shown_utc < 7 * 24 * 60 * 60)
        recent_ids->insert(entry.id);
    }
    *warm_used_today = state.warm_date == local_date && state.warm_used;
    return true;
  }

  bool SegmentConsumed() const {
    PersistentState state;
    if (!ReadState(&state)) return true;
    return state.segment_consumed;
  }

  StoreResult SetSegmentConsumed(bool consumed, std::int64_t now_utc) {
    return Update(now_utc, [&consumed](PersistentState& state) {
      state.segment_consumed = consumed;
      return StoreResult::Success;
    });
  }

  bool ClockGuard(std::int64_t now_utc, const char* local_date) const {
    if (!ValidDate(local_date) || !EnsureDirectory()) return true;
    FileLock lock(directory_ / "state.lock");
    if (!lock.locked()) return true;
    PersistentState state;
    bool recovered = false;
    if (!Load(&state, &recovered) || recovered) return true;
    if (state.clock_guard || IsWallTimeBefore(state.last_show_utc, now_utc) ||
        state.daily_date > local_date) return true;
    return std::any_of(state.history.begin(), state.history.end(),
        [now_utc](const HistoryEntry& entry) { return entry.shown_utc > now_utc + 120; });
  }

  StoreResult SetClockGuard(bool guarded, std::int64_t now_utc,
                            const char* local_date) {
    if (!ValidDate(local_date)) return StoreResult::InvalidState;
    return Update(now_utc, [guarded, now_utc, local_date = std::string(local_date)](
        PersistentState& state) {
      if (!guarded) {
        state.daily_date = local_date;
        state.warm_date = local_date;
        if (state.last_show_utc > 0 || !state.history.empty())
          state.last_show_utc = now_utc;
        for (auto& entry : state.history)
          entry.shown_utc = now_utc;
      }
      state.clock_guard = guarded;
      return StoreResult::Success;
    }, true);
  }

  StoreResult TryReserve(const char* id, const char* local_date, bool warm,
                         std::int64_t now_utc) {
    if (!ValidId(id) || !ValidDate(local_date)) return StoreResult::InvalidState;
    return Update(now_utc, [=](PersistentState& state) {
      if (!state.segment_consumed) return StoreResult::LimitReached;
      if (state.clock_guard) return StoreResult::ClockGuard;
      if (local_date < state.daily_date) return StoreResult::ClockGuard;
      if (state.daily_date != local_date) {
        state.daily_date = local_date;
        state.daily_count = 0;
      }
      if (state.warm_date != local_date) {
        state.warm_date = local_date;
        state.warm_used = false;
      }
      if (state.quiet_until_utc > now_utc) return StoreResult::ClockGuard;
      if (state.daily_count >= 5) return StoreResult::LimitReached;
      if (warm && state.warm_used) return StoreResult::LimitReached;
      if (state.last_show_utc > 0) {
        if (now_utc + 120 < state.last_show_utc) return StoreResult::ClockGuard;
        if (now_utc < state.last_show_utc + 45 * 60) return StoreResult::LimitReached;
      }
      for (const auto& entry : state.history) {
        if (entry.id == id) {
          if (now_utc < entry.shown_utc) return StoreResult::ClockGuard;
          if (now_utc - entry.shown_utc < 7 * 24 * 60 * 60)
            return StoreResult::LimitReached;
        }
      }
      state.history.erase(std::remove_if(state.history.begin(), state.history.end(),
          [now_utc](const HistoryEntry& entry) {
            return now_utc >= entry.shown_utc && now_utc - entry.shown_utc >= 14 * 24 * 60 * 60;
          }), state.history.end());
      if (state.history.size() >= 512) return StoreResult::LimitReached;
      state.history.push_back({id, now_utc});
      state.last_show_utc = now_utc;
      ++state.daily_count;
      if (warm) state.warm_used = true;
      return StoreResult::Success;
    });
  }

 private:
  class FileLock {
   public:
    explicit FileLock(const std::filesystem::path& path) {
#if defined(_WIN32)
      handle_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
          FILE_ATTRIBUTE_NORMAL, nullptr);
      if (handle_ == INVALID_HANDLE_VALUE) return;
      OVERLAPPED overlap{};
      if (!LockFileEx(handle_, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &overlap)) {
        CloseHandle(handle_);
        handle_ = INVALID_HANDLE_VALUE;
      }
#else
      fd_ = open(path.c_str(), O_CREAT | O_RDWR, S_IRUSR | S_IWUSR);
      if (fd_ < 0 || flock(fd_, LOCK_EX) != 0) {
        if (fd_ >= 0) close(fd_);
        fd_ = -1;
      }
#endif
    }
    ~FileLock() {
#if defined(_WIN32)
      if (handle_ != INVALID_HANDLE_VALUE) {
        OVERLAPPED overlap{};
        UnlockFileEx(handle_, 0, 1, 0, &overlap);
        CloseHandle(handle_);
      }
#else
      if (fd_ >= 0) { flock(fd_, LOCK_UN); close(fd_); }
#endif
    }
    bool locked() const {
#if defined(_WIN32)
      return handle_ != INVALID_HANDLE_VALUE;
#else
      return fd_ >= 0;
#endif
    }
   private:
#if defined(_WIN32)
    HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
    int fd_ = -1;
#endif
  };

  static bool ValidId(const char* id) {
    if (id == nullptr || *id == '\0' || std::strlen(id) > 64) return false;
    for (const unsigned char c : std::string(id))
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
    return true;
  }

  static bool ValidDate(const char* date) {
    if (date == nullptr || std::strlen(date) != 10) return false;
    for (int i = 0; i < 10; ++i) {
      if (i == 4 || i == 7) { if (date[i] != '-') return false; }
      else if (date[i] < '0' || date[i] > '9') return false;
    }
    return true;
  }

  template <typename Integer>
  static bool ParseInteger(const std::string& text, Integer* value) {
    if (text.empty()) return false;
    const char* begin = text.data();
    const char* end = begin + text.size();
    const auto parsed = std::from_chars(begin, end, *value);
    return parsed.ec == std::errc{} && parsed.ptr == end;
  }

  static FILE* OpenFile(const std::filesystem::path& path, const wchar_t* wide_mode,
                        const char* narrow_mode) {
#if defined(_WIN32)
    (void)narrow_mode;
    return _wfopen(path.c_str(), wide_mode);
#else
    (void)wide_mode;
    return std::fopen(path.c_str(), narrow_mode);
#endif
  }

  bool EnsureDirectory() const {
    std::error_code error;
    std::filesystem::create_directories(directory_, error);
    return !error && std::filesystem::is_directory(directory_, error) && !error;
  }

  bool ReadState(PersistentState* state) const {
    if (!EnsureDirectory()) return false;
    FileLock lock(directory_ / "state.lock");
    if (!lock.locked()) return false;
    bool recovered = false;
    return Load(state, &recovered) && !recovered;
  }

  static bool Parse(const std::string& bytes, PersistentState* state) {
    constexpr const char* version1 = "NIUMA_REMINDER_STATE\t1\n";
    constexpr const char* version2 = "NIUMA_REMINDER_STATE\t2\n";
    const bool isVersion2 = bytes.rfind(version2, 0) == 0;
    if (bytes.size() > 256 * 1024 ||
        (!isVersion2 && bytes.rfind(version1, 0) != 0)) return false;
    PersistentState parsed;
    std::size_t offset = std::strlen(isVersion2 ? version2 : version1);
    bool got_daily = false, got_warm = false, got_last = false, got_quiet = false, got_segment = false;
    bool got_clock_guard = false;
    while (offset < bytes.size()) {
      const std::size_t end = bytes.find('\n', offset);
      if (end == std::string::npos) return false;
      const std::string line = bytes.substr(offset, end - offset);
      offset = end + 1;
      if (line.rfind("daily\t", 0) == 0) {
        const auto split = line.find('\t', 6);
        if (split == std::string::npos || got_daily) return false;
        parsed.daily_date = line.substr(6, split - 6);
        if (!ParseInteger(line.substr(split + 1), &parsed.daily_count)) return false;
        got_daily = (parsed.daily_date.empty() ? parsed.daily_count == 0 :
            ValidDate(parsed.daily_date.c_str())) && parsed.daily_count <= 5;
        if (!got_daily) return false;
      } else if (line.rfind("warm\t", 0) == 0) {
        const auto split = line.find('\t', 5);
        if (split == std::string::npos || got_warm) return false;
        parsed.warm_date = line.substr(5, split - 5);
        const std::string used = line.substr(split + 1);
        if ((!parsed.warm_date.empty() && !ValidDate(parsed.warm_date.c_str())) ||
            (used != "0" && used != "1") || (parsed.warm_date.empty() && used == "1")) return false;
        parsed.warm_used = used == "1"; got_warm = true;
      } else if (line.rfind("last\t", 0) == 0) {
        if (!ParseInteger(line.substr(5), &parsed.last_show_utc)) return false;
        if (parsed.last_show_utc < 0 || got_last) return false;
        got_last = true;
      } else if (line.rfind("quiet\t", 0) == 0) {
        if (!ParseInteger(line.substr(6), &parsed.quiet_until_utc)) return false;
        if (parsed.quiet_until_utc < 0 || got_quiet) return false;
        got_quiet = true;
      } else if (line.rfind("segment\t", 0) == 0) {
        const std::string value = line.substr(8);
        if ((value != "0" && value != "1") || got_segment) return false;
        parsed.segment_consumed = value == "1"; got_segment = true;
      } else if (line.rfind("clock_guard\t", 0) == 0) {
        const std::string value = line.substr(12);
        if ((value != "0" && value != "1") || got_clock_guard) return false;
        parsed.clock_guard = value == "1";
        got_clock_guard = true;
      } else if (line.rfind("id\t", 0) == 0) {
        const auto split = line.find('\t', 3);
        if (split == std::string::npos || parsed.history.size() >= 512) return false;
        const std::string id = line.substr(3, split - 3);
        std::int64_t time = 0;
        if (!ParseInteger(line.substr(split + 1), &time)) return false;
        if (!ValidId(id.c_str()) || time <= 0) return false;
        parsed.history.push_back({id, time});
      } else return false;
    }
    if (!got_daily || !got_warm || !got_last || !got_quiet || !got_segment ||
        (isVersion2 && !got_clock_guard) || (!isVersion2 && got_clock_guard)) return false;
    *state = std::move(parsed);
    return true;
  }

  static std::string Serialize(const PersistentState& state) {
    std::string output = "NIUMA_REMINDER_STATE\t2\n";
    output += "daily\t" + state.daily_date + "\t" + std::to_string(state.daily_count) + "\n";
    output += "warm\t" + state.warm_date + "\t" + (state.warm_used ? "1" : "0") + "\n";
    output += "last\t" + std::to_string(state.last_show_utc) + "\n";
    output += "quiet\t" + std::to_string(state.quiet_until_utc) + "\n";
    output += "segment\t" + std::string(state.segment_consumed ? "1" : "0") + "\n";
    output += "clock_guard\t" + std::string(state.clock_guard ? "1" : "0") + "\n";
    for (const auto& entry : state.history)
      output += "id\t" + entry.id + "\t" + std::to_string(entry.shown_utc) + "\n";
    return output;
  }

  bool ReadFile(const std::filesystem::path& path, PersistentState* state) const {
    std::error_code error;
    if (!std::filesystem::exists(path, error)) return false;
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > 256 * 1024) return false;
    FILE* file = OpenFile(path, L"rb", "rb");
    if (file == nullptr) return false;
    std::string bytes(static_cast<std::size_t>(size), '\0');
    const std::size_t read = bytes.empty() ? 0 : std::fread(bytes.data(), 1, bytes.size(), file);
    const bool okay = !std::ferror(file) && read == bytes.size() && std::fclose(file) == 0;
    return okay && Parse(bytes, state);
  }

  bool Load(PersistentState* state, bool* recovered) const {
    *recovered = false;
    const auto main_path = directory_ / "state.dat";
    std::error_code error;
    if (!std::filesystem::exists(main_path, error)) {
      if (error) return false;
      const auto backup_path = directory_ / "state.bak";
      const bool backup_exists = std::filesystem::exists(backup_path, error);
      if (error) return false;
      if (backup_exists) {
        if (!ReadFile(backup_path, state)) return false;
        *recovered = true;
        return true;
      }
      *state = PersistentState{};
      return true;
    }
    if (ReadFile(main_path, state)) return true;
    if (!ReadFile(directory_ / "state.bak", state)) return false;
    *recovered = true;
    return true;
  }

  bool WriteState(const PersistentState& state) const {
    const std::string bytes = Serialize(state);
    const auto main_path = directory_ / "state.dat";
    const auto temp_path = directory_ / "state.tmp";
    FILE* file = OpenFile(temp_path, L"wb", "wb");
    if (file == nullptr) return false;
    bool okay = std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size() &&
        std::fflush(file) == 0;
#if defined(_WIN32)
    if (okay) okay = _commit(_fileno(file)) == 0;
#else
    if (okay) okay = fsync(fileno(file)) == 0;
#endif
    if (std::fclose(file) != 0) okay = false;
    if (!okay) return false;
#if !defined(_WIN32)
    if (chmod(temp_path.c_str(), S_IRUSR | S_IWUSR) != 0) return false;
#endif
    std::error_code error;
    if (std::filesystem::exists(main_path, error)) {
      if (error) return false;
      PersistentState valid_previous;
      if (ReadFile(main_path, &valid_previous)) {
        if (!std::filesystem::copy_file(main_path, directory_ / "state.bak",
                std::filesystem::copy_options::overwrite_existing, error) || error) return false;
      }
    }
#if defined(_WIN32)
    return MoveFileExW(temp_path.c_str(), main_path.c_str(),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
#else
    if (rename(temp_path.c_str(), main_path.c_str()) != 0) return false;
    const int dir_fd = open(directory_.c_str(), O_RDONLY);
    if (dir_fd < 0) return false;
    const bool synced = fsync(dir_fd) == 0;
    close(dir_fd);
    return synced;
#endif
  }

  static bool IsWallTimeBefore(std::int64_t last_show_utc, std::int64_t now_utc) {
    return last_show_utc > 0 && now_utc < last_show_utc &&
        static_cast<long double>(last_show_utc) - static_cast<long double>(now_utc) > 120.0L;
  }

  template <typename Mutation>
  StoreResult Update(std::int64_t now_utc, Mutation mutation,
                     bool allowWallTimeAnomaly = false) {
    if (!EnsureDirectory()) return StoreResult::IoError;
    FileLock lock(directory_ / "state.lock");
    if (!lock.locked()) return StoreResult::IoError;
    PersistentState state;
    bool recovered = false;
    if (!Load(&state, &recovered)) return StoreResult::InvalidState;
    if (recovered) {
      state.quiet_until_utc = now_utc + 7 * 24 * 60 * 60;
      state.clock_guard = true;
      if (!WriteState(state)) return StoreResult::IoError;
      return StoreResult::ClockGuard;
    }
    if (!allowWallTimeAnomaly && IsWallTimeBefore(state.last_show_utc, now_utc)) {
      state.clock_guard = true;
      WriteState(state);
      return StoreResult::ClockGuard;
    }
    if (!allowWallTimeAnomaly && std::any_of(state.history.begin(), state.history.end(),
        [now_utc](const HistoryEntry& entry) { return entry.shown_utc > now_utc + 120; })) {
      state.clock_guard = true;
      WriteState(state);
      return StoreResult::ClockGuard;
    }
    const StoreResult result = mutation(state);
    if (result != StoreResult::Success) return result;
    return WriteState(state) ? StoreResult::Success : StoreResult::IoError;
  }

  std::filesystem::path directory_;
};

}  // namespace niuma::reminder
