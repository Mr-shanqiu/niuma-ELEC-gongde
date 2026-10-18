#pragma once

#include "reminder_catalog_crypto.h"

#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <system_error>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace niuma::reminder {

enum class CatalogInstallStatus {
  Installed,
  AlreadyInstalled,
  InvalidPackage,
  UntrustedSignature,
  Downgrade,
  SameVersionDifferentContent,
  IoError,
  CommitUncertain
};

struct CatalogInstallResult {
  CatalogInstallStatus status = CatalogInstallStatus::InvalidPackage;
  std::shared_ptr<ValidatedCatalog> catalog;
  std::string detail;
};

inline bool IsCatalogPackagePath(const std::filesystem::path& path) {
  auto extension = path.extension().native();
  for (auto& ch : extension) {
    if (ch >= 'A' && ch <= 'Z')
      ch = static_cast<std::filesystem::path::value_type>(ch + ('a' - 'A'));
  }
  return extension == std::filesystem::path(".nmgtext").native();
}

// Stores one complete signed catalog. The envelope is retained verbatim so
// startup recovery can repeat signature and schema verification. No package
// path or filename comes from the untrusted payload.
class CatalogUpdateStore {
 public:
  using DirectorySync = std::function<bool(const std::filesystem::path&)>;

  explicit CatalogUpdateStore(std::filesystem::path directory,
                              DirectorySync directory_sync = {})
      : directory_(std::move(directory)), directory_sync_(std::move(directory_sync)) {}

  CatalogInstallResult InstallFile(const std::filesystem::path& source,
                                   const CatalogSignatureVerifier& verify) {
    CatalogInstallResult result;
    if (!IsCatalogPackagePath(source)) {
      result.detail = "select an .nmgtext catalog file";
      return result;
    }
    std::string bytes;
    if (!ReadLocalFile(source, &bytes)) {
      result.status = CatalogInstallStatus::InvalidPackage;
      result.detail = "catalog source is not a stable regular local file or exceeds 2 MiB";
      return result;
    }
    return Install(bytes, verify);
  }

  CatalogInstallResult Install(const std::string& envelope_bytes,
                               const CatalogSignatureVerifier& verify) {
    CatalogInstallResult result;
    CatalogEnvelope envelope;
    if (!ParseCatalogEnvelope(envelope_bytes, &envelope, &result.detail)) return result;
    const auto message = CatalogSignatureMessage(envelope.payload);
    if (!verify || !verify(envelope.key_id, message, envelope.signature)) {
      result.status = CatalogInstallStatus::UntrustedSignature;
      result.detail = "catalog signature is not trusted";
      return result;
    }
    std::shared_ptr<ValidatedCatalog> candidate;
    if (!ValidateCatalogPayload(envelope.payload, &candidate, &result.detail)) return result;
    if (!EnsureDirectory()) {
      result.status = CatalogInstallStatus::IoError;
      result.detail = "catalog directory is unavailable";
      return result;
    }
    FileLock lock(directory_ / "catalog.lock");
    if (!lock.locked()) {
      result.status = CatalogInstallStatus::IoError;
      result.detail = "catalog lock is unavailable";
      return result;
    }

    std::uint32_t highest = 0;
    std::string highest_digest;
    if (!ReadHighest(&highest, &highest_digest)) {
      result.status = CatalogInstallStatus::IoError;
      result.detail = "catalog version record is invalid";
      return result;
    }
    std::string active_bytes;
    std::shared_ptr<ValidatedCatalog> active;
    if (ReadVerified(directory_ / "official.nmgtext", verify, &active_bytes, &active)) {
      if (active->content_version > highest) {
        highest = active->content_version;
        if (!PayloadDigest(ActivePayload(active_bytes), &highest_digest)) {
          result.status = CatalogInstallStatus::IoError;
          result.detail = "could not verify the active catalog version record";
          return result;
        }
      }
    }
    if (candidate->content_version < highest) {
      result.status = CatalogInstallStatus::Downgrade;
      result.detail = "an older catalog version cannot replace the installed version";
      return result;
    }
    if (candidate->content_version == highest && highest != 0) {
      if (active && envelope.payload == ActivePayload(active_bytes)) {
        result.status = CatalogInstallStatus::AlreadyInstalled;
        result.catalog = std::move(active);
        result.detail = "catalog is already installed";
        return result;
      }
      std::string candidate_digest;
      const bool can_restore_highest =
          (!active || active->content_version < highest) &&
          !highest_digest.empty() && PayloadDigest(envelope.payload, &candidate_digest) &&
          candidate_digest == highest_digest;
      if (!can_restore_highest) {
        result.status = CatalogInstallStatus::SameVersionDifferentContent;
        result.detail = "the same version number is already bound to different content";
        return result;
      }
    }

    const auto current = directory_ / "official.nmgtext";
    const auto backup = directory_ / "official.previous.nmgtext";
    const auto staged = directory_ / "official.nmgtext.tmp";
    const auto version_file = directory_ / "highest-version";
    const auto version_stage = directory_ / "highest-version.tmp";
    if (!WriteDurable(staged, envelope_bytes)) {
      result.status = CatalogInstallStatus::IoError;
      result.detail = "could not stage the new catalog";
      return result;
    }
    std::string candidate_digest;
    if (!PayloadDigest(envelope.payload, &candidate_digest) ||
        !WriteDurable(version_stage,
            SerializeVersionRecord(candidate->content_version, candidate_digest))) {
      RemoveQuietly(staged);
      result.status = CatalogInstallStatus::IoError;
      result.detail = "could not stage the catalog version";
      return result;
    }
    const bool had_current = ReadVerified(current, verify, &active_bytes, &active);
    if (had_current && !ReplaceFile(current, backup)) {
      RemoveQuietly(staged);
      RemoveQuietly(version_stage);
      result.status = CatalogInstallStatus::IoError;
      result.detail = "could not preserve the previous catalog";
      return result;
    }
    if (!ReplaceFile(staged, current)) {
      if (had_current) ReplaceFile(backup, current);
      RemoveQuietly(staged);
      RemoveQuietly(version_stage);
      result.status = CatalogInstallStatus::IoError;
      result.detail = "could not activate the new catalog";
      return result;
    }
    if (!ReplaceFile(version_stage, version_file)) {
      RemoveQuietly(current);
      if (had_current) ReplaceFile(backup, current);
      RemoveQuietly(version_stage);
      result.status = CatalogInstallStatus::IoError;
      result.detail = "could not commit the catalog version record";
      return result;
    }
    if (!SyncDirectory()) {
      result.status = CatalogInstallStatus::CommitUncertain;
      result.detail = "catalog files were replaced, but directory durability could not be confirmed";
      return result;
    }
    result.status = CatalogInstallStatus::Installed;
    result.catalog = std::move(candidate);
    result.detail = "catalog installed";
    return result;
  }

  // Prefer the current signed package; use the previous package only after
  // re-verifying it. The version watermark is never lowered during recovery.
  std::shared_ptr<ValidatedCatalog> Load(const CatalogSignatureVerifier& verify,
                                         bool* recovered = nullptr,
                                         bool* commit_uncertain = nullptr) const {
    if (recovered) *recovered = false;
    if (commit_uncertain) *commit_uncertain = false;
    if (!EnsureDirectory()) return {};
    FileLock lock(directory_ / "catalog.lock");
    if (!lock.locked()) return {};
    RemoveQuietly(directory_ / "official.nmgtext.tmp");
    RemoveQuietly(directory_ / "highest-version.tmp");
    std::string bytes;
    std::shared_ptr<ValidatedCatalog> catalog;
    const auto current = directory_ / "official.nmgtext";
    if (ReadVerified(current, verify, &bytes, &catalog)) {
      std::uint32_t highest = 0;
      std::string highest_digest;
      if (ReadHighest(&highest, &highest_digest) &&
          (catalog->content_version > highest ||
           (catalog->content_version == highest && highest_digest.empty()))) {
        std::string active_digest;
        if (PayloadDigest(ActivePayload(bytes), &active_digest)) {
          const auto staged = directory_ / "highest-version.tmp";
          const auto version_file = directory_ / "highest-version";
          const std::string record = SerializeVersionRecord(
              catalog->content_version, active_digest);
          if (WriteDurable(staged, record) && ReplaceFile(staged, version_file)) {
            if (!SyncDirectory() && commit_uncertain) *commit_uncertain = true;
          } else {
            RemoveQuietly(staged);
          }
        }
      }
      return catalog;
    }
    const auto backup = directory_ / "official.previous.nmgtext";
    if (!ReadVerified(backup, verify, &bytes, &catalog)) return {};
    if (!ReplaceFile(backup, current)) return {};
    if (recovered) *recovered = true;
    if (!SyncDirectory() && commit_uncertain) *commit_uncertain = true;
    return catalog;
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

  bool EnsureDirectory() const {
    std::error_code error;
    std::filesystem::create_directories(directory_, error);
    if (error) return false;
    const auto status = std::filesystem::symlink_status(directory_, error);
    if (error || std::filesystem::is_symlink(status) ||
        !std::filesystem::is_directory(status)) return false;
#if defined(_WIN32)
    const DWORD attributes = GetFileAttributesW(directory_.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ==
            FILE_ATTRIBUTE_DIRECTORY;
#else
    return true;
#endif
  }

  static bool ReadLocalFile(const std::filesystem::path& source, std::string* bytes) {
#if defined(_WIN32)
    HANDLE file = CreateFileW(source.c_str(), GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    BY_HANDLE_FILE_INFORMATION info{};
    LARGE_INTEGER size{};
    bool okay = GetFileInformationByHandle(file, &info) &&
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0 &&
        GetFileSizeEx(file, &size) && size.QuadPart > 0 && size.QuadPart <= 2 * 1024 * 1024;
    std::string result;
    if (okay) result.resize(static_cast<std::size_t>(size.QuadPart));
    std::size_t offset = 0;
    while (okay && offset < result.size()) {
      const DWORD request = static_cast<DWORD>(std::min<std::size_t>(
          result.size() - offset, MAXDWORD));
      DWORD read = 0;
      okay = ReadFile(file, result.data() + offset, request, &read, nullptr) && read == request;
      offset += read;
    }
    if (okay) {
      char extra = 0;
      DWORD read = 0;
      okay = ReadFile(file, &extra, 1, &read, nullptr) && read == 0;
    }
    CloseHandle(file);
    if (okay) *bytes = std::move(result);
    return okay;
#else
    const int fd = open(source.c_str(), O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return false;
    struct stat info{};
    bool okay = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_size > 0 && info.st_size <= 2 * 1024 * 1024;
    std::string result;
    if (okay) result.resize(static_cast<std::size_t>(info.st_size));
    std::size_t offset = 0;
    while (okay && offset < result.size()) {
      const ssize_t count = read(fd, result.data() + offset, result.size() - offset);
      if (count <= 0) okay = false;
      else offset += static_cast<std::size_t>(count);
    }
    if (okay) {
      char extra = 0;
      okay = read(fd, &extra, 1) == 0;
    }
    close(fd);
    if (okay) *bytes = std::move(result);
    return okay;
#endif
  }

  bool ReadHighest(std::uint32_t* highest, std::string* payload_digest) const {
    *highest = 0;
    payload_digest->clear();
    const auto path = directory_ / "highest-version";
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory) return true;
    if (error || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status))
      return false;
#if defined(_WIN32)
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0)
      return false;
#endif
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    std::string record((std::istreambuf_iterator<char>(file)),
                       std::istreambuf_iterator<char>());
    if (file.bad() || record.size() < 2 || record.size() > 128 ||
        record.back() != '\n') return false;
    if (record.rfind("NIUMA_CATALOG_VERSION\t1\n", 0) == 0) {
      constexpr char kVersionHeader[] = "NIUMA_CATALOG_VERSION\t1\n";
      const std::size_t version_start = sizeof(kVersionHeader) - 1;
      const std::size_t version_end = record.find('\n', version_start);
      if (version_end == std::string::npos) return false;
      const std::size_t digest_end = record.find('\n', version_end + 1);
      if (digest_end != record.size() - 1 || digest_end - version_end - 1 != 64)
        return false;
      const std::string digest = record.substr(version_end + 1, 64);
      for (const unsigned char character : digest)
        if (!((character >= '0' && character <= '9') ||
              (character >= 'a' && character <= 'f'))) return false;
      *payload_digest = digest;
      const std::string version_text = record.substr(version_start,
          version_end - version_start);
      std::uint32_t value = 0;
      const auto parsed = std::from_chars(version_text.data(),
          version_text.data() + version_text.size(), value);
      if (parsed.ec != std::errc{} || parsed.ptr != version_text.data() + version_text.size() ||
          value == 0) return false;
      *highest = value;
      return true;
    }
    // Read the earlier numeric-only record conservatively. It still prevents
    // downgrades, but cannot authorize restoring a missing highest payload.
    const std::string text = record.substr(0, record.size() - 1);
    if (record.size() > 11) return false;
    if (text.empty() || text.size() > 10) return false;
    std::uint32_t value = 0;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || value == 0)
      return false;
    *highest = value;
    return true;
  }

  static std::string ActivePayload(const std::string& envelope) {
    CatalogEnvelope parsed;
    return ParseCatalogEnvelope(envelope, &parsed, nullptr) ? parsed.payload : std::string{};
  }

  static bool PayloadDigest(const std::string& payload, std::string* hexadecimal) {
    std::array<std::uint8_t, 32> digest{};
    if (!CatalogSha256(payload, &digest)) return false;
    static constexpr char digits[] = "0123456789abcdef";
    hexadecimal->clear();
    hexadecimal->reserve(digest.size() * 2);
    for (const std::uint8_t byte : digest) {
      hexadecimal->push_back(digits[byte >> 4]);
      hexadecimal->push_back(digits[byte & 0x0f]);
    }
    return true;
  }

  static std::string SerializeVersionRecord(std::uint32_t version,
                                            const std::string& digest) {
    return "NIUMA_CATALOG_VERSION\t1\n" + std::to_string(version) + "\n" +
        digest + "\n";
  }

  static bool ReadVerified(const std::filesystem::path& path,
                           const CatalogSignatureVerifier& verify,
                           std::string* bytes,
                           std::shared_ptr<ValidatedCatalog>* catalog) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    if (error || std::filesystem::is_symlink(status) || !std::filesystem::is_regular_file(status))
      return false;
#if defined(_WIN32)
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0)
      return false;
#endif
    const auto size = std::filesystem::file_size(path, error);
    if (error || size == 0 || size > 2 * 1024 * 1024) return false;
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    std::string raw(static_cast<std::size_t>(size), '\0');
    file.read(raw.data(), static_cast<std::streamsize>(raw.size()));
    if (!file || file.peek() != std::char_traits<char>::eof()) return false;
    CatalogEnvelope envelope;
    if (!ParseCatalogEnvelope(raw, &envelope, nullptr)) return false;
    const auto message = CatalogSignatureMessage(envelope.payload);
    if (!verify || !verify(envelope.key_id, message, envelope.signature)) return false;
    if (!ValidateCatalogPayload(envelope.payload, catalog, nullptr)) return false;
    *bytes = std::move(raw);
    return true;
  }

  static bool WriteDurable(const std::filesystem::path& path, const std::string& bytes) {
#if defined(_WIN32)
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool okay = bytes.size() <= MAXDWORD &&
        WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
        written == bytes.size() && FlushFileBuffers(file);
    CloseHandle(file);
    return okay;
#else
    const int fd = open(path.c_str(), O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW,
                        S_IRUSR | S_IWUSR);
    if (fd < 0) return false;
    std::size_t offset = 0;
    while (offset < bytes.size()) {
      const ssize_t count = write(fd, bytes.data() + offset, bytes.size() - offset);
      if (count <= 0) { close(fd); return false; }
      offset += static_cast<std::size_t>(count);
    }
    const bool synced = fsync(fd) == 0;
    const bool closed = close(fd) == 0;
    return synced && closed;
#endif
  }

  static bool ReplaceFile(const std::filesystem::path& from,
                          const std::filesystem::path& to) {
#if defined(_WIN32)
    return MoveFileExW(from.c_str(), to.c_str(),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    return rename(from.c_str(), to.c_str()) == 0;
#endif
  }

  static void RemoveQuietly(const std::filesystem::path& path) {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
  }

  bool SyncDirectory() const {
    if (directory_sync_) return directory_sync_(directory_);
#if !defined(_WIN32)
    const int fd = open(directory_.c_str(), O_RDONLY);
    if (fd < 0) return false;
    const bool synced = fsync(fd) == 0;
    const bool closed = close(fd) == 0;
    return synced && closed;
#else
    // Install/replace operations use MOVEFILE_WRITE_THROUGH on Windows.
    return true;
#endif
  }

  std::filesystem::path directory_;
  DirectorySync directory_sync_;
};

}  // namespace niuma::reminder
