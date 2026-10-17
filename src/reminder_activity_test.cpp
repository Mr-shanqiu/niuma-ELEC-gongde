#ifdef NDEBUG
#undef NDEBUG
#endif

#include "reminder_activity.h"
#include "reminder_geometry.h"
#include "reminder_policy.h"
#include "reminder_status.h"
#include "reminder_store.h"
#include "reminder_catalog_update.h"
#include "reminder_catalog_store.h"
#include "reminder_catalog_crypto.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <chrono>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <fstream>
#include <string>
#include <unordered_map>
#include <vector>

#if defined(NDEBUG)
#error "Reminder acceptance tests require active assertions in every build type."
#endif

#if !defined(_WIN32)
#include <sys/wait.h>
#include <unistd.h>
#endif
#if defined(__APPLE__)
#include <sys/stat.h>
#endif

using niuma::reminder::ActivitySampler;
using namespace niuma::reminder;

static void AddClicks(ActivitySampler& sampler, std::uint64_t start) {
  sampler.Observe(ActivitySampler::Event::Click, start);
  sampler.Observe(ActivitySampler::Event::Click, start + 100);
  sampler.Observe(ActivitySampler::Event::Click, start + 200);
}

static std::string EncodeBase64(const std::string& input) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  for (std::size_t offset = 0; offset < input.size(); offset += 3) {
    const std::size_t remaining = input.size() - offset;
    const std::uint32_t a = static_cast<unsigned char>(input[offset]);
    const std::uint32_t b = remaining > 1
        ? static_cast<unsigned char>(input[offset + 1]) : 0;
    const std::uint32_t c = remaining > 2
        ? static_cast<unsigned char>(input[offset + 2]) : 0;
    const std::uint32_t packed = (a << 16) | (b << 8) | c;
    output.push_back(alphabet[(packed >> 18) & 63]);
    output.push_back(alphabet[(packed >> 12) & 63]);
    output.push_back(remaining > 1 ? alphabet[(packed >> 6) & 63] : '=');
    output.push_back(remaining > 2 ? alphabet[packed & 63] : '=');
  }
  return output;
}

static std::string MakeTestEnvelope(const std::string& payload) {
  std::string signature(64, static_cast<char>(0xa5));
  return "{\"format\":\"nmgtext-envelope-v1\",\"key_id\":\"test-only\","
      "\"payload_b64\":\"" + EncodeBase64(payload) + "\",\"signature_b64\":\"" +
      EncodeBase64(signature) + "\"}";
}

static ActivitySampler::Trigger RunHighIntensityBoundary(
    std::size_t activeBucketCount, bool belowScoreThreshold) {
  ActivitySampler sampler;
  sampler.Evaluate(1'000, true);

  std::array<std::uint32_t, 31> scoreQuarterUnits{};
  std::vector<std::size_t> activeBuckets;
  const std::size_t earlyActive = activeBucketCount - 3;
  for (std::size_t bucket = 1; bucket <= earlyActive; ++bucket)
    activeBuckets.push_back(bucket);
  activeBuckets.insert(activeBuckets.end(), {28, 29, 30});

  if (activeBucketCount == 21) {
    scoreQuarterUnits[activeBuckets[0]] = 160;  // 40 points.
    for (std::size_t index = 1; index < activeBuckets.size(); ++index)
      scoreQuarterUnits[activeBuckets[index]] = 112;  // 28 points each.
    if (belowScoreThreshold) scoreQuarterUnits[activeBuckets.back()] = 111;
  } else {
    for (const std::size_t bucket : activeBuckets)
      scoreQuarterUnits[bucket] = 160;
  }

  ActivitySampler::Trigger result = ActivitySampler::Trigger::None;
  for (std::size_t bucket = 1; bucket <= 30; ++bucket) {
    const std::uint64_t base = bucket * ActivitySampler::kBucketMs;
    const std::uint32_t units = scoreQuarterUnits[bucket];
    const std::uint32_t clickCount = units / 4;
    const std::uint32_t scrollCount = units % 4;
    for (std::uint64_t second = 0; second < 10; ++second) {
      const std::uint32_t clicksBeforeSecond = static_cast<std::uint32_t>(second) * 4;
      const std::uint32_t clicksThisSecond = clickCount > clicksBeforeSecond
          ? std::min<std::uint32_t>(4, clickCount - clicksBeforeSecond) : 0;
      for (std::uint32_t index = 0; index < clicksThisSecond; ++index) {
        sampler.Observe(ActivitySampler::Event::Click,
            base + second * 1'000 + 100 + index * 100);
      }
      if (scrollCount > 0 && second >= 10 - scrollCount) {
        sampler.Observe(ActivitySampler::Event::ScrollPulse,
            base + second * 1'000 + 100);
      }
      const std::uint64_t evaluation = base + second * 1'000 + 900;
      const auto observed = sampler.Evaluate(evaluation, true);
      if (observed != ActivitySampler::Trigger::None) result = observed;
    }
  }
  const auto finalEvaluation = sampler.Evaluate(310'000, true);
  if (finalEvaluation != ActivitySampler::Trigger::None) result = finalEvaluation;
  return result;
}

static ActivitySampler::Trigger RunContinuousScroll(unsigned seconds) {
  ActivitySampler sampler;
  sampler.Evaluate(1'000, true);
  ActivitySampler::Trigger result = ActivitySampler::Trigger::None;
  for (std::uint64_t second = 0; second < seconds; ++second) {
    const std::uint64_t event = 10'100 + second * 1'000;
    sampler.Observe(ActivitySampler::Event::ScrollPulse, event);
    const auto observed = sampler.Evaluate(event + 500, true);
    if (observed != ActivitySampler::Trigger::None) result = observed;
  }
  const auto final = sampler.Evaluate(10'000 +
      static_cast<std::uint64_t>(seconds) * 1'000, true);
  if (final != ActivitySampler::Trigger::None) result = final;
  return result;
}

static ActivitySampler::Trigger RunLongBusyRecentBoundary(std::size_t recentActive) {
  assert(recentActive == 17 || recentActive == 18);
  ActivitySampler sampler;
  sampler.Evaluate(1'000, true);
  const std::size_t olderActive = 126 - recentActive;
  for (std::uint64_t bucket = 0; bucket < 169; ++bucket) {
    const std::uint64_t base = 10'000 + bucket * ActivitySampler::kBucketMs;
    const bool segmentStart = bucket == 0;  // Event belongs to closed bucket index 1.
    const bool olderWindowActive = bucket >= 1 && bucket < 1 + olderActive;
    const bool recentWindowActive =
        bucket >= 169 - recentActive && bucket < 169;
    if (segmentStart || olderWindowActive || recentWindowActive)
      AddClicks(sampler, base + 100);
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000)
      sampler.Evaluate(tick + 500, true);
  }
  return sampler.Evaluate(1'700'000, true);
}

static ActivitySampler::Trigger RunSingleSecondBurstLimiterBoundary() {
  ActivitySampler sampler;
  sampler.Evaluate(1'000, true);
  for (std::uint64_t bucket = 0; bucket < 30; ++bucket) {
    const std::uint64_t base = 10'000 + bucket * ActivitySampler::kBucketMs;
    const bool active = bucket < 21 || bucket >= 24;
    if (active) {
      const std::uint64_t burst = base + 100;
      for (unsigned index = 0; index < 100; ++index) {
        sampler.Observe(ActivitySampler::Event::KeyDown, burst);
        sampler.Observe(ActivitySampler::Event::KeyUp, burst);
        sampler.Observe(ActivitySampler::Event::Click, burst);
        sampler.Observe(ActivitySampler::Event::ScrollPulse, burst);
      }
    }
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000)
      sampler.Evaluate(tick + 500, true);
  }
  return sampler.Evaluate(310'000, true);
}

// Cross-platform P-256/SHA-256 positive vector from an ephemeral OpenSSL key.
// Only its public key and signature are retained; this is not a publishing key.
static void TestCatalogP256KnownVector() {
  std::vector<std::uint8_t> public_xy;
  std::vector<std::uint8_t> signature;
  assert(DecodeBase64("AOQaIt2kk5rilG++ZKnt478zIJZTm1TW6LbCwASrdI+d4WE1WpdVXdc9G0yofWL7WEnhdwDxEHDiJwpSQNcf5Q==", &public_xy));
  assert(DecodeBase64("fnxmtQhTyJUuCaDbpgIzFoXuZkfwtxqcIDLgyHDFAxPGbHPGqENfdmLxFNZmX1dwFWBVLyLrVVRNYyCke7LWxw==", &signature));
  const auto message = CatalogSignatureMessage("catalog signature fixture");
  assert(VerifyCatalogP256(public_xy, message, signature));
  auto changed_message = message;
  changed_message.back() ^= 1;
  assert(!VerifyCatalogP256(public_xy, changed_message, signature));
  changed_message = message;
  changed_message.front() ^= 1;
  assert(!VerifyCatalogP256(public_xy, changed_message, signature));
  auto changed_signature = signature;
  changed_signature.front() ^= 1;
  assert(!VerifyCatalogP256(public_xy, message, changed_signature));
  auto changed_key = public_xy;
  changed_key.front() ^= 1;
  assert(!VerifyCatalogP256(changed_key, message, signature));
  signature.pop_back();
  assert(!VerifyCatalogP256(public_xy, message, signature));
  public_xy.pop_back();
  assert(!VerifyCatalogP256(public_xy, message, changed_signature));
}

// This signed fixture binds the exact UTF-8 updatePayload below. It exercises
// envelope parsing, the production crypto verifier, durable install and recovery.
// The ephemeral test private key was never retained or used as a publishing key.
static void TestRealSignedCatalogStore(const std::string& payload,
                                      const std::filesystem::path& directory) {
  std::vector<std::uint8_t> public_xy;
  assert(DecodeBase64("GE5yFsTviiQC3NW+AdRU6Ai+kE5SFmaRKx9HI1j6bESvC8adLIpkmXEkzcj7NVljdrsR+xdXKyWahsvlkDjI5g==", &public_xy));
  const auto verify = MakeCatalogSignatureVerifier({{"test-integration-p256", public_xy}});
  const std::string signature2 = "MeOhyVqsPyLYAeyKsHZZHkFYRcNt1XSIKcVypYpx+K09zzluMTu/t0KtTg8/PKQ37ZHwyl0ugLusWuqk2ubGUQ==";
  const std::string signature3 = "rbgyDizvVCjnzJIn1AVA1EnaxPQffh9weI9dzbk0JE35tdoyoH4iVql80H6DhN2jWX5SYYIFjlSlJ/2dL2kDQw==";
  const auto envelope = [](const std::string& bytes, const std::string& signature) {
    return "{\"format\":\"nmgtext-envelope-v1\",\"key_id\":\"test-integration-p256\","
        "\"payload_b64\":\"" + EncodeBase64(bytes) + "\",\"signature_b64\":\"" +
        signature + "\"}";
  };
  std::filesystem::create_directories(directory);
  const auto source = directory / "source.nmgtext";
  {
    std::ofstream file(source, std::ios::binary);
    file << envelope(payload, signature2);
    assert(file.good());
  }
  CatalogUpdateStore store(directory / "catalog");
  ReminderStore history(directory / "history");
  constexpr std::int64_t now = 1'800'000'000;
  assert(history.SetSegmentConsumed(true, now) == StoreResult::Success);
  assert(history.TryReserve("nm.en.9001", "2027-01-15", false, now) == StoreResult::Success);
  auto installed = store.InstallFile(source, verify);
  assert(installed.status == CatalogInstallStatus::Installed && installed.catalog &&
      installed.catalog->content_version == 2 && installed.catalog->items.size() == 2);
  auto loaded = store.Load(verify);
  assert(loaded && loaded->content_version == 2 && loaded->items.size() == 2);
  assert(store.InstallFile(source, verify).status == CatalogInstallStatus::AlreadyInstalled);
  auto changed_payload = payload;
  const auto text = changed_payload.find("A useful work joke.");
  assert(text != std::string::npos);
  changed_payload[text] ^= 1;
  assert(store.Install(envelope(changed_payload, signature2), verify).status ==
      CatalogInstallStatus::UntrustedSignature);
  auto unknown_key = envelope(payload, signature2);
  const auto key = unknown_key.find("test-integration-p256");
  assert(key != std::string::npos);
  unknown_key.replace(key, std::strlen("test-integration-p256"), "unknown-test-key");
  assert(store.Install(unknown_key, verify).status == CatalogInstallStatus::UntrustedSignature);
  std::vector<std::uint8_t> changed_signature;
  assert(DecodeBase64(signature2, &changed_signature));
  changed_signature.front() ^= 1;
  assert(store.Install(envelope(payload, EncodeBase64(std::string(
      changed_signature.begin(), changed_signature.end()))), verify).status ==
      CatalogInstallStatus::UntrustedSignature);
  assert(store.Load(verify)->content_version == 2);
  auto newer = payload;
  const auto version = newer.find("\"content_version\":2");
  assert(version != std::string::npos);
  newer.replace(version, std::strlen("\"content_version\":2"), "\"content_version\":3");
  assert(store.Install(envelope(newer, signature3), verify).status == CatalogInstallStatus::Installed);
  assert(store.Load(verify)->content_version == 3);
  {
    std::ofstream corrupt(directory / "catalog" / "official.nmgtext", std::ios::binary);
    corrupt << "corrupted current package";
    assert(corrupt.good());
  }
  bool recovered = false;
  loaded = store.Load(verify, &recovered);
  assert(recovered && loaded && loaded->content_version == 2);
  assert(store.Install(envelope(payload, signature2), verify).status == CatalogInstallStatus::Downgrade);
  assert(store.Install(envelope(newer, signature3), verify).status == CatalogInstallStatus::Installed);
  assert(store.Load(verify)->content_version == 3);
  std::unordered_set<std::string> recent;
  bool warm = true;
  assert(history.ReadSelectionHistory("2027-01-15", now + 1, &recent, &warm));
  assert(recent.count("nm.en.9001") == 1 && !warm && history.SegmentConsumed());
}

#if defined(__APPLE__)
static void TestCatalogP256() {
  int bits_value = 256;
  CFNumberRef bits = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &bits_value);
  const void* keys[] = {kSecAttrKeyType, kSecAttrKeySizeInBits};
  const void* values[] = {kSecAttrKeyTypeECSECPrimeRandom, bits};
  CFDictionaryRef attributes = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (bits) CFRelease(bits);
  CFErrorRef error = nullptr;
  SecKeyRef private_key = SecKeyCreateRandomKey(attributes, &error);
  if (attributes) CFRelease(attributes);
  if (error) CFRelease(error);
  assert(private_key != nullptr);
  SecKeyRef public_key = SecKeyCopyPublicKey(private_key);
  error = nullptr;
  CFDataRef public_data = SecKeyCopyExternalRepresentation(public_key, &error);
  if (error) CFRelease(error);
  assert(public_data != nullptr && CFDataGetLength(public_data) == 65 &&
      CFDataGetBytePtr(public_data)[0] == 0x04);
  std::vector<std::uint8_t> public_xy(CFDataGetBytePtr(public_data) + 1,
                                      CFDataGetBytePtr(public_data) + 65);
  const char message_bytes[] = "NMG-TEXT-v1\0catalog signature fixture";
  const std::string message(message_bytes, sizeof(message_bytes) - 1);
  CFDataRef message_data = CFDataCreate(kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(message.data()), static_cast<CFIndex>(message.size()));
  error = nullptr;
  CFDataRef der = SecKeyCreateSignature(private_key,
      kSecKeyAlgorithmECDSASignatureMessageX962SHA256, message_data, &error);
  if (error) CFRelease(error);
  assert(der != nullptr);
  const UInt8* encoded = CFDataGetBytePtr(der);
  const std::size_t der_size = static_cast<std::size_t>(CFDataGetLength(der));
  std::vector<std::uint8_t> raw(64, 0);
  std::size_t cursor = 0;
  assert(der_size >= 8 && encoded[cursor++] == 0x30);
  const std::size_t sequence_size = encoded[cursor++];
  assert(sequence_size == der_size - cursor);
  for (int scalar = 0; scalar < 2; ++scalar) {
    assert(encoded[cursor++] == 0x02);
    const std::size_t length = encoded[cursor++];
    assert(length > 0 && length <= 33 && cursor + length <= der_size);
    std::size_t begin = cursor;
    std::size_t value_size = length;
    if (value_size == 33) { assert(encoded[begin] == 0); ++begin; --value_size; }
    assert(value_size <= 32);
    const std::size_t destination = static_cast<std::size_t>(scalar) * 32 + 32 - value_size;
    std::copy(encoded + begin, encoded + begin + value_size, raw.begin() + destination);
    cursor += length;
  }
  assert(cursor == der_size);
  assert(VerifyCatalogP256(public_xy,
      std::vector<std::uint8_t>(message.begin(), message.end()), raw));
  auto tampered = message;
  tampered.back() ^= 1;
  assert(!VerifyCatalogP256(public_xy,
      std::vector<std::uint8_t>(tampered.begin(), tampered.end()), raw));
  CFRelease(der);
  CFRelease(message_data);
  CFRelease(public_data);
  CFRelease(public_key);
  CFRelease(private_key);
}
#endif

static std::wstring QuoteWindowsArgument(const std::wstring& argument) {
  std::wstring quoted(1, L'"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
    } else if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
    } else {
      quoted.append(backslashes, L'\\');
      backslashes = 0;
      quoted.push_back(character);
    }
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

#if defined(_WIN32)
static bool WindowsAsciiArgument(const wchar_t* value, std::string* output) {
  if (value == nullptr || output == nullptr) return false;
  output->clear();
  while (*value != L'\0') {
    if (*value > 0x7f) return false;
    output->push_back(static_cast<char>(*value++));
  }
  return true;
}

static int RunWindowsReservationChild(int argc, wchar_t** argv) {
  if (argc != 8 || std::wcscmp(argv[1], L"--reserve-child") != 0) return -1;
  HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[6]);
  HANDLE start = OpenEventW(SYNCHRONIZE, FALSE, argv[7]);
  if (ready == nullptr || start == nullptr) {
    if (ready != nullptr) CloseHandle(ready);
    if (start != nullptr) CloseHandle(start);
    return 3;
  }
  const bool signaledReady = SetEvent(ready) != FALSE;
  const DWORD released = signaledReady ? WaitForSingleObject(start, 15000) : WAIT_FAILED;
  CloseHandle(ready);
  CloseHandle(start);
  if (released != WAIT_OBJECT_0) return 4;

  std::string id;
  std::string localDate;
  if (!WindowsAsciiArgument(argv[3], &id) || !WindowsAsciiArgument(argv[4], &localDate))
    return 5;
  wchar_t* end = nullptr;
  const long long now = _wcstoi64(argv[5], &end, 10);
  if (end == argv[5] || *end != L'\0') return 6;
  ReminderStore store{std::filesystem::path(argv[2])};
  const auto result = store.TryReserve(id.c_str(), localDate.c_str(), false, now);
  return result == StoreResult::Success ? 0 :
      result == StoreResult::LimitReached ? 1 : 2;
}

static bool RunWindowsReservationRace(const std::filesystem::path& directory,
                                      std::int64_t nowUtc, unsigned competitors) {
  std::vector<wchar_t> executableBuffer(32768, L'\0');
  const DWORD executableLength = GetModuleFileNameW(nullptr, executableBuffer.data(),
      static_cast<DWORD>(executableBuffer.size()));
  if (executableLength == 0 ||
      static_cast<std::size_t>(executableLength) >= executableBuffer.size()) return false;
  // Keep an explicitly terminated string: this value is passed both to
  // QuoteWindowsArgument and CreateProcessW's lpApplicationName.
  const std::wstring executable(executableBuffer.data(), executableLength);
  const std::wstring eventBase = L"Local\\NiuMaReminderTest_" +
      std::to_wstring(GetCurrentProcessId()) + L"_" +
      std::to_wstring(GetTickCount64());
  const std::wstring startName = eventBase + L"_start";
  HANDLE startEvent = CreateEventW(nullptr, TRUE, FALSE, startName.c_str());
  if (startEvent == nullptr) return false;

  std::vector<HANDLE> readyEvents;
  std::vector<HANDLE> processHandles;
  readyEvents.reserve(competitors);
  processHandles.reserve(competitors);
  bool okay = true;
  for (unsigned index = 0; index < competitors && okay; ++index) {
    const std::wstring readyName = eventBase + L"_ready_" + std::to_wstring(index);
    HANDLE readyEvent = CreateEventW(nullptr, TRUE, FALSE, readyName.c_str());
    if (readyEvent == nullptr) { okay = false; break; }
    readyEvents.push_back(readyEvent);
    const std::wstring id = L"nm.race.win." + std::to_wstring(index);
    std::wstring command = QuoteWindowsArgument(executable) +
        L" --reserve-child " + QuoteWindowsArgument(directory.wstring()) + L" " +
        QuoteWindowsArgument(id) + L" " + QuoteWindowsArgument(L"2026-10-28") + L" " +
        QuoteWindowsArgument(std::to_wstring(nowUtc)) + L" " +
        QuoteWindowsArgument(readyName) + L" " + QuoteWindowsArgument(startName);
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), mutableCommand.data(), nullptr, nullptr,
            FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
      okay = false;
      break;
    }
    CloseHandle(process.hThread);
    processHandles.push_back(process.hProcess);
  }

  if (okay) {
    for (const HANDLE readyEvent : readyEvents) {
      if (WaitForSingleObject(readyEvent, 15000) != WAIT_OBJECT_0) {
        okay = false;
        break;
      }
    }
  }
  if (SetEvent(startEvent) == FALSE) okay = false;

  if (okay && !processHandles.empty()) {
    if (WaitForMultipleObjects(static_cast<DWORD>(processHandles.size()),
            processHandles.data(), TRUE, 15000) != WAIT_OBJECT_0) okay = false;
  }
  if (!okay) {
    for (const HANDLE process : processHandles) {
      DWORD exitCode = 0;
      if (GetExitCodeProcess(process, &exitCode) && exitCode == STILL_ACTIVE)
        TerminateProcess(process, 10);
    }
  }

  unsigned winners = 0;
  for (const HANDLE process : processHandles) {
    WaitForSingleObject(process, 5000);
    DWORD exitCode = 10;
    if (!GetExitCodeProcess(process, &exitCode) || (exitCode != 0 && exitCode != 1)) {
      okay = false;
    } else if (exitCode == 0) {
      ++winners;
    }
    CloseHandle(process);
  }
  for (const HANDLE readyEvent : readyEvents) CloseHandle(readyEvent);
  CloseHandle(startEvent);
  return okay && processHandles.size() == competitors && winners == 1;
}
#endif

#if defined(_WIN32)
int wmain(int argc, wchar_t** argv) {
  const int childResult = RunWindowsReservationChild(argc, argv);
  if (childResult >= 0) return childResult;
#else
int main() {
  assert(ClassifyRuntimeStatus(false, false, false, false) ==
      RuntimeStatus::StorageUnavailable);
  assert(ClassifyRuntimeStatus(true, true, true, true) ==
      RuntimeStatus::StorageFault);
  assert(ClassifyRuntimeStatus(true, false, true, true) ==
      RuntimeStatus::ClockGuarded);
  assert(ClassifyRuntimeStatus(true, false, false, false) ==
      RuntimeStatus::ListenerUnavailable);
  assert(ClassifyRuntimeStatus(true, false, false, true) == RuntimeStatus::Ready);

#endif
  assert(QuoteWindowsArgument(L"") == L"\"\"");
  assert(QuoteWindowsArgument(L"plain") == L"\"plain\"");
  assert(QuoteWindowsArgument(L"a\"b") == L"\"a\\\"b\"");
  assert(QuoteWindowsArgument(L"dir with space\\") ==
      L"\"dir with space\\\\\"");
  assert(QuoteWindowsArgument(L"路径 含 空格") == L"\"路径 含 空格\"");

  assert(kCatalogItemCount == 1600);
  assert(kCalendarCount == 24);

  const BubbleRect macAbove = PlaceBubble(
      {100, 100, 100, 100}, {0, 0, 500, 500}, 200, 80, 10, VerticalAxis::Up);
  assert(macAbove.x == 50 && macAbove.y == 210);
  const BubbleRect macSide = PlaceBubble(
      {240, 500, 80, 80}, {0, 0, 500, 600}, 180, 100, 10, VerticalAxis::Up);
  assert(macSide.x == 50 && macSide.y == 490);
  const BubbleRect macBelow = PlaceBubble(
      {210, 300, 80, 80}, {0, 0, 500, 400}, 200, 100, 10, VerticalAxis::Up);
  assert(macBelow.x == 150 && macBelow.y == 190);
  const BubbleRect windowsSecondary = PlaceBubble(
      {-1800, 300, 80, 80}, {-1920, 0, 1920, 1080}, 200, 100, 12,
      VerticalAxis::Down);
  assert(windowsSecondary.x == -1860 && windowsSecondary.y == 188);
  const BubbleRect clamped = PlaceBubble(
      {-1950, -25, 80, 80}, {-1920, 0, 1920, 1080}, 200, 100, 12,
      VerticalAxis::Down);
  assert(clamped.x >= -1908 && clamped.x + clamped.width <= -12);
  assert(clamped.y >= 12 && clamped.y + clamped.height <= 968);
  WallClockGuard clockGuard;
  clockGuard.Start(1'000, 10'000, false);
  assert(clockGuard.Observe(1'001, 11'000) == WallClockGuard::Transition::None);
  assert(clockGuard.Observe(1'125, 12'000) == WallClockGuard::Transition::Guarded);
  assert(clockGuard.guarded());
  assert(clockGuard.Observe(1'425, 311'999) == WallClockGuard::Transition::None);
  assert(clockGuard.guarded());  // 299,999 ms of stable clock is not enough.
  assert(clockGuard.Observe(1'425, 312'000) == WallClockGuard::Transition::Recovered);
  assert(!clockGuard.guarded());
  WallClockGuard backwardClock;
  backwardClock.Start(2'000, 50'000, false);
  assert(backwardClock.Observe(1'999, 51'000) == WallClockGuard::Transition::None);
  assert(backwardClock.Observe(1'878, 52'000) == WallClockGuard::Transition::Guarded);
  backwardClock.RestoreGuard();
  assert(backwardClock.guarded());
  assert(backwardClock.Observe(2'177, 351'999) == WallClockGuard::Transition::None);
  assert(backwardClock.guarded());
  assert(backwardClock.Observe(2'178, 352'000) ==
      WallClockGuard::Transition::Recovered);
  WallClockGuard restoredClock;
  restoredClock.Start(3'000, 100'000, true);
  assert(restoredClock.Observe(3'299, 399'000) == WallClockGuard::Transition::None);
  assert(restoredClock.Observe(3'300, 400'000) ==
      WallClockGuard::Transition::Recovered);
  const std::string updatePayload = R"json({
    "schema_version":2,"catalog_id":"official.multilingual","content_version":2,
    "calendar_version":"2026-v2","calendar_year_start":2026,"calendar_year_end":2026,
    "languages":["zh-CN","en"],
    "calendars":[
      {"id":"new_year","language":"zh-CN","type":"annual_gregorian","month":1,"day":1},
      {"id":"en.new_year","language":"en","type":"annual_gregorian","month":1,"day":1}
    ],
    "items":[
      {"id":"nm.zh.9001","language":"zh-CN","category":"ordinary","tone":"humor","text":"中文提醒内容","triggers":["high_intensity"],"requires_overtime":false,"local_time":{"start_minute":0,"end_minute":1440},"festival_id":null,"before_days":0,"after_days":0,"regions":["*"]},
      {"id":"nm.en.9001","language":"en","category":"ordinary","tone":"humor","text":"A useful work joke.","triggers":["high_intensity"],"requires_overtime":false,"local_time":{"start_minute":0,"end_minute":1440},"festival_id":null,"before_days":0,"after_days":0,"regions":["*"]}
    ]
  })json";
  std::shared_ptr<ValidatedCatalog> parsedCatalog;
  std::string parseError;
  std::vector<std::uint8_t> decoded;
  assert(DecodeBase64("TQ==", &decoded) && decoded == std::vector<std::uint8_t>{'M'});
  assert(DecodeBase64("TWE=", &decoded) && decoded == (std::vector<std::uint8_t>{'M', 'a'}));
  assert(DecodeBase64("TWFu", &decoded) && decoded == (std::vector<std::uint8_t>{'M', 'a', 'n'}));
  assert(!DecodeBase64("TR==", &decoded));  // Non-zero unused padding bits.
  assert(!DecodeBase64("TWF=", &decoded));
  assert(!DecodeBase64("T=Fu", &decoded));
  assert(!DecodeBase64("TWFu====", &decoded));
  std::string largeEnvelope = "{\"data\":\"" +
      std::string(1024 * 1024, 'x') + "\"}";
  JsonValue parsedLargeEnvelope;
  assert(JsonParser(largeEnvelope).Parse(&parsedLargeEnvelope, &parseError, 4,
      2 * 1024 * 1024));
  assert(!VerifyCatalogP256({}, {}, {}));
  TestCatalogP256KnownVector();
#if defined(__APPLE__)
  TestCatalogP256();
#endif
  const auto signatureMessage = CatalogSignatureMessage("abc");
  assert(signatureMessage.size() == sizeof("NMG-TEXT-v1") + 3);
  assert(std::memcmp(signatureMessage.data(), "NMG-TEXT-v1\0abc", signatureMessage.size()) == 0);
  std::array<std::uint8_t, 32> payloadDigest{};
  const std::array<std::uint8_t, 32> expectedAbcDigest = {
      0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
      0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
      0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
      0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad};
  assert(CatalogSha256("abc", &payloadDigest) && payloadDigest == expectedAbcDigest);
  const auto catalogDirectory = std::filesystem::path(".local-work/acceptance") /
      ("reminder-catalog-store-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::remove_all(catalogDirectory);
  TestRealSignedCatalogStore(updatePayload, catalogDirectory / "real-p256-chain");
  CatalogUpdateStore catalogStore(catalogDirectory);
  ReminderStore catalogHistoryStore(catalogDirectory / "reminder-history");
  const CatalogSignatureVerifier testVerifier = [](
      const std::string& keyId, const std::vector<std::uint8_t>& message,
      const std::vector<std::uint8_t>& signature) {
    return keyId == "test-only" && signature.size() == 64 &&
        std::all_of(signature.begin(), signature.end(),
            [](std::uint8_t byte) { return byte == 0xa5; }) &&
        message.size() > sizeof("NMG-TEXT-v1") &&
        std::memcmp(message.data(), "NMG-TEXT-v1\0", sizeof("NMG-TEXT-v1")) == 0;
  };
  const auto uncertainCommitDirectory = catalogDirectory / "uncertain-directory-sync";
  CatalogUpdateStore uncertainCommitStore(uncertainCommitDirectory,
      [](const std::filesystem::path&) { return false; });
  auto uncertainCommit = uncertainCommitStore.Install(
      MakeTestEnvelope(updatePayload), testVerifier);
  assert(uncertainCommit.status == CatalogInstallStatus::CommitUncertain);
  assert(!uncertainCommit.catalog);
  CatalogUpdateStore reopenedAfterUncertainCommit(uncertainCommitDirectory);
  auto catalogAfterUncertainCommit = reopenedAfterUncertainCommit.Load(testVerifier);
  assert(catalogAfterUncertainCommit && catalogAfterUncertainCommit->content_version == 2);

  std::filesystem::create_directories(catalogDirectory);
  const auto sourcePackage = catalogDirectory / "update.nmgtext";
  {
    std::ofstream package(sourcePackage, std::ios::binary);
    package << MakeTestEnvelope(updatePayload);
  }
  auto untrusted = catalogStore.InstallFile(sourcePackage,
      [](const std::string&, const std::vector<std::uint8_t>&,
         const std::vector<std::uint8_t>&) { return false; });
  assert(untrusted.status == CatalogInstallStatus::UntrustedSignature);
  std::string unknownKeyEnvelope = MakeTestEnvelope(updatePayload);
  const auto testKey = unknownKeyEnvelope.find("test-only");
  assert(testKey != std::string::npos);
  unknownKeyEnvelope.replace(testKey, std::strlen("test-only"), "unknown-key");
  assert(catalogStore.Install(unknownKeyEnvelope, testVerifier).status ==
      CatalogInstallStatus::UntrustedSignature);
  assert(catalogStore.Install(std::string(2 * 1024 * 1024 + 1, 'x'), testVerifier).status ==
      CatalogInstallStatus::InvalidPackage);
  auto installed = catalogStore.InstallFile(sourcePackage, testVerifier);
  assert(installed.status == CatalogInstallStatus::Installed &&
      installed.catalog && installed.catalog->content_version == 2);
  constexpr std::int64_t catalogHistoryTime = 1'800'000'000;
  assert(catalogHistoryStore.SetSegmentConsumed(true, catalogHistoryTime) == StoreResult::Success);
  assert(catalogHistoryStore.TryReserve("nm.en.9001", "2027-01-15", true,
      catalogHistoryTime) == StoreResult::Success);
#if defined(__APPLE__)
  const auto linkedPackage = catalogDirectory / "linked.nmgtext";
  std::filesystem::create_symlink(sourcePackage, linkedPackage);
  auto symlinkRejected = catalogStore.InstallFile(linkedPackage, testVerifier);
  assert(symlinkRejected.status == CatalogInstallStatus::InvalidPackage);
#endif
  auto loadedUpdate = catalogStore.Load(testVerifier);
  assert(loadedUpdate && loadedUpdate->content_version == 2);
  auto repeated = catalogStore.Install(MakeTestEnvelope(updatePayload), testVerifier);
  assert(repeated.status == CatalogInstallStatus::AlreadyInstalled);
  std::string sameVersionChanged = updatePayload;
  const auto originalText = sameVersionChanged.find("A useful work joke.");
  assert(originalText != std::string::npos);
  sameVersionChanged.replace(originalText, std::strlen("A useful work joke."),
      "A different work joke.");
  auto collision = catalogStore.Install(MakeTestEnvelope(sameVersionChanged), testVerifier);
  assert(collision.status == CatalogInstallStatus::SameVersionDifferentContent);
  std::string newerPayload = updatePayload;
  const auto versionField = newerPayload.find("\"content_version\":2");
  assert(versionField != std::string::npos);
  newerPayload.replace(versionField, std::strlen("\"content_version\":2"),
      "\"content_version\":3");
  std::filesystem::create_directory(catalogDirectory / "official.nmgtext.tmp");
  auto stageFailure = catalogStore.Install(MakeTestEnvelope(newerPayload), testVerifier);
  assert(stageFailure.status == CatalogInstallStatus::IoError);
  auto afterStageFailure = catalogStore.Load(testVerifier);
  assert(afterStageFailure && afterStageFailure->content_version == 2);
  std::filesystem::remove_all(catalogDirectory / "official.nmgtext.tmp");
  std::filesystem::create_directory(catalogDirectory / "highest-version.tmp");
  auto watermarkStageFailure = catalogStore.Install(
      MakeTestEnvelope(newerPayload), testVerifier);
  assert(watermarkStageFailure.status == CatalogInstallStatus::IoError);
  auto afterWatermarkStageFailure = catalogStore.Load(testVerifier);
  assert(afterWatermarkStageFailure && afterWatermarkStageFailure->content_version == 2);
  std::filesystem::remove_all(catalogDirectory / "highest-version.tmp");
  auto upgraded = catalogStore.Install(MakeTestEnvelope(newerPayload), testVerifier);
  assert(upgraded.status == CatalogInstallStatus::Installed &&
      upgraded.catalog && upgraded.catalog->content_version == 3);
  {
    // Model a crash after the active package replacement but before the
    // matching version watermark replacement completed.
    std::ofstream staleWatermark(catalogDirectory / "highest-version",
        std::ios::binary | std::ios::trunc);
    staleWatermark << "2\n";
    assert(staleWatermark.good());
  }
  CatalogUpdateStore uncertainRepairStore(catalogDirectory,
      [](const std::filesystem::path&) { return false; });
  bool watermarkRepairUncertain = false;
  auto repairedAfterInterruptedCommit = uncertainRepairStore.Load(
      testVerifier, nullptr, &watermarkRepairUncertain);
  assert(repairedAfterInterruptedCommit &&
      repairedAfterInterruptedCommit->content_version == 3);
  assert(watermarkRepairUncertain);
  auto confirmedRepairStore = CatalogUpdateStore(catalogDirectory);
  bool watermarkRepairConfirmedUncertain = true;
  auto confirmedRepair = confirmedRepairStore.Load(
      testVerifier, nullptr, &watermarkRepairConfirmedUncertain);
  assert(confirmedRepair && confirmedRepair->content_version == 3);
  assert(!watermarkRepairConfirmedUncertain);
  {
    std::ifstream repairedWatermark(catalogDirectory / "highest-version", std::ios::binary);
    std::string header;
    std::getline(repairedWatermark, header);
    assert(header == "NIUMA_CATALOG_VERSION\t1");
    std::string repairedVersion;
    std::getline(repairedWatermark, repairedVersion);
    assert(repairedVersion == "3");
  }
  std::string interruptedChangedPayload = newerPayload;
  const auto interruptedText = interruptedChangedPayload.find("A useful work joke.");
  assert(interruptedText != std::string::npos);
  interruptedChangedPayload.replace(interruptedText, std::strlen("A useful work joke."),
      "Changed after interrupted activation.");
  assert(catalogStore.Install(MakeTestEnvelope(interruptedChangedPayload), testVerifier).status ==
      CatalogInstallStatus::SameVersionDifferentContent);
  std::string newestPayload = newerPayload;
  const auto newestVersionField = newestPayload.find("\"content_version\":3");
  assert(newestVersionField != std::string::npos);
  newestPayload.replace(newestVersionField, std::strlen("\"content_version\":3"),
      "\"content_version\":4");
  const auto catalogBackup = catalogDirectory / "official.previous.nmgtext";
  const auto preservedCatalogBackup = catalogDirectory / "official.previous.preserved";
  assert(std::filesystem::exists(catalogBackup));
  std::filesystem::rename(catalogBackup, preservedCatalogBackup);
  std::filesystem::create_directory(catalogBackup);
  auto catalogBackupFailure = catalogStore.Install(
      MakeTestEnvelope(newestPayload), testVerifier);
  assert(catalogBackupFailure.status == CatalogInstallStatus::IoError);
  auto afterCatalogBackupFailure = catalogStore.Load(testVerifier);
  assert(afterCatalogBackupFailure && afterCatalogBackupFailure->content_version == 3);
  std::filesystem::remove(catalogBackup);
  std::filesystem::rename(preservedCatalogBackup, catalogBackup);
  {
    std::ofstream damaged(catalogDirectory / "official.nmgtext", std::ios::binary | std::ios::trunc);
    damaged << "damaged";
  }
  bool recoveredCatalog = false;
  bool recoveryCommitUncertain = false;
  CatalogUpdateStore uncertainRecoveryStore(catalogDirectory,
      [](const std::filesystem::path&) { return false; });
  auto recoveredCatalogValue = uncertainRecoveryStore.Load(
      testVerifier, &recoveredCatalog, &recoveryCommitUncertain);
  assert(recoveredCatalog);
  assert(recoveredCatalogValue);
  assert(recoveredCatalogValue->content_version == 2);
  assert(recoveryCommitUncertain);
  std::string changedHighestPayload = newerPayload;
  const auto newerText = changedHighestPayload.find("A useful work joke.");
  assert(newerText != std::string::npos);
  changedHighestPayload.replace(newerText, std::strlen("A useful work joke."),
      "A different highest-version joke.");
  auto changedHighest = catalogStore.Install(
      MakeTestEnvelope(changedHighestPayload), testVerifier);
  assert(changedHighest.status == CatalogInstallStatus::SameVersionDifferentContent);
  auto restoredHighest = catalogStore.Install(MakeTestEnvelope(newerPayload), testVerifier);
  assert(restoredHighest.status == CatalogInstallStatus::Installed &&
      restoredHighest.catalog && restoredHighest.catalog->content_version == 3);
  auto rollbackAttempt = catalogStore.Install(MakeTestEnvelope(updatePayload), testVerifier);
  assert(rollbackAttempt.status == CatalogInstallStatus::Downgrade);
  std::unordered_set<std::string> catalogRecentIds;
  bool catalogWarmUsed = false;
  assert(catalogHistoryStore.ReadSelectionHistory("2027-01-15",
      catalogHistoryTime + 45 * 60, &catalogRecentIds, &catalogWarmUsed));
  assert(catalogRecentIds.count("nm.en.9001") == 1 && catalogWarmUsed);
  assert(catalogHistoryStore.SegmentConsumed());
  assert(catalogHistoryStore.TryReserve("nm.en.9001", "2027-01-15", true,
      catalogHistoryTime + 45 * 60) == StoreResult::LimitReached);
#if defined(__APPLE__)
  const auto versionWatermark = catalogDirectory / "highest-version";
  const int immutableSet = chflags(versionWatermark.c_str(), UF_IMMUTABLE);
  CatalogInstallResult versionCommitFailure;
  if (immutableSet == 0)
    versionCommitFailure = catalogStore.Install(MakeTestEnvelope(newestPayload), testVerifier);
  const int immutableCleared = immutableSet == 0
      ? chflags(versionWatermark.c_str(), 0) : -1;
  auto afterVersionCommitFailure = immutableCleared == 0
      ? catalogStore.Load(testVerifier) : std::shared_ptr<ValidatedCatalog>{};
  assert(immutableSet == 0 && immutableCleared == 0);
  assert(versionCommitFailure.status == CatalogInstallStatus::IoError);
  assert(afterVersionCommitFailure && afterVersionCommitFailure->content_version == 3);
  assert(catalogStore.Install(MakeTestEnvelope(newerPayload), testVerifier).status ==
      CatalogInstallStatus::AlreadyInstalled);
#endif
  std::filesystem::remove_all(catalogDirectory);
  assert(ValidateCatalogPayload(updatePayload, &parsedCatalog, &parseError));
  assert(parsedCatalog->view().item_count == 2 && parsedCatalog->view().content_version == 2);
  assert(!ValidateCatalogPayload("{\"schema_version\":2,\"schema_version\":2}",
      &parsedCatalog, &parseError));
  std::string mixedWildcard = updatePayload;
  const auto wildcard = mixedWildcard.find("\"regions\":[\"*\"]");
  assert(wildcard != std::string::npos);
  mixedWildcard.replace(wildcard, std::strlen("\"regions\":[\"*\"]"),
      "\"regions\":[\"*\",\"US\"]");
  assert(!ValidateCatalogPayload(mixedWildcard, &parsedCatalog, &parseError));
  std::string duplicateId = updatePayload;
  const auto englishId = duplicateId.find("nm.en.9001");
  assert(englishId != std::string::npos);
  duplicateId.replace(englishId, std::strlen("nm.en.9001"), "nm.zh.9001");
  assert(!ValidateCatalogPayload(duplicateId, &parsedCatalog, &parseError));
  std::string invalidUtf8 = updatePayload;
  const auto validText = invalidUtf8.find("A useful work joke.");
  assert(validText != std::string::npos);
  const std::string malformedText = std::string("A ") + static_cast<char>(0xc0) +
      static_cast<char>(0xaf) + " joke.";
  invalidUtf8.replace(validText, std::strlen("A useful work joke."), malformedText);
  assert(!ValidateCatalogPayload(invalidUtf8, &parsedCatalog, &parseError));
  std::string overlongText = updatePayload;
  const auto shortText = overlongText.find("A useful work joke.");
  assert(shortText != std::string::npos);
  overlongText.replace(shortText, std::strlen("A useful work joke."), std::string(161, 'x'));
  assert(!ValidateCatalogPayload(overlongText, &parsedCatalog, &parseError));
  std::string scriptField = updatePayload;
  const auto regionField = scriptField.find("\"regions\":[\"*\"]}");
  assert(regionField != std::string::npos);
  scriptField.replace(regionField, std::strlen("\"regions\":[\"*\"]}"),
      "\"regions\":[\"*\"],\"script\":\"ignored\"}");
  assert(!ValidateCatalogPayload(scriptField, &parsedCatalog, &parseError));
  std::ifstream packagedJson("assets/reminders/official-multilingual-v1.json", std::ios::binary);
  assert(packagedJson.good());
  std::ostringstream packagedBytes;
  packagedBytes << packagedJson.rdbuf();
  const std::string completePayload = packagedBytes.str();
  assert(ValidateCatalogPayload(completePayload, &parsedCatalog, &parseError));
  assert(parsedCatalog->view().item_count == 1600 && parsedCatalog->view().calendar_count == 24);
  std::size_t zhCount = 0, enCount = 0;
  const CatalogView completeView = parsedCatalog->view();
  const CatalogView builtinView = kBuiltinCatalogView;
  assert(completeView.item_count == builtinView.item_count);
  assert(completeView.calendar_count == builtinView.calendar_count);
  std::unordered_map<std::string, const CatalogItem*> builtinById;
  for (std::size_t index = 0; index < builtinView.item_count; ++index)
    assert(builtinById.emplace(builtinView.items[index].id,
        &builtinView.items[index]).second);
  for (std::size_t index = 0; index < completeView.item_count; ++index) {
    const auto& item = completeView.items[index];
    const auto builtin = builtinById.find(item.id);
    assert(builtin != builtinById.end());
    const CatalogItem& compiled = *builtin->second;
    assert(std::strcmp(item.language, compiled.language) == 0);
    assert(std::strcmp(item.category, compiled.category) == 0);
    assert(std::strcmp(item.tone, compiled.tone) == 0);
    assert(std::strcmp(item.text, compiled.text) == 0);
    assert(item.triggers == compiled.triggers);
    assert(item.requires_overtime == compiled.requires_overtime);
    assert(item.start_minute == compiled.start_minute);
    assert(item.end_minute == compiled.end_minute);
    assert(std::strcmp(item.festival_id, compiled.festival_id) == 0);
    assert(item.before_days == compiled.before_days);
    assert(item.after_days == compiled.after_days);
    assert(std::strcmp(item.regions, compiled.regions) == 0);
    if (std::strcmp(item.language, "zh-CN") == 0) ++zhCount;
    if (std::strcmp(item.language, "en") == 0) ++enCount;
  }
  assert(zhCount == 800 && enCount == 800);
  std::unordered_map<std::string, const Calendar*> builtinCalendarsById;
  for (std::size_t index = 0; index < builtinView.calendar_count; ++index)
    assert(builtinCalendarsById.emplace(builtinView.calendars[index].id,
        &builtinView.calendars[index]).second);
  for (std::size_t index = 0; index < completeView.calendar_count; ++index) {
    const auto& calendar = completeView.calendars[index];
    const auto builtin = builtinCalendarsById.find(calendar.id);
    assert(builtin != builtinCalendarsById.end());
    const Calendar& compiled = *builtin->second;
    assert(std::strcmp(calendar.language, compiled.language) == 0);
    assert(std::strcmp(calendar.type, compiled.type) == 0);
    assert(calendar.month == compiled.month);
    assert(calendar.day == compiled.day);
    assert(std::strcmp(calendar.dates, compiled.dates) == 0);
  }
  SelectionContext us;
  us.locale = Locale::English;
  us.region = "US";
  us.trigger = 2;
  us.year = 2026;
  us.month = 11;
  us.day = 26;
  us.minute_of_day = 12 * 60;
  const auto usItems = EligibleItems(us, [](const char*) { return false; });
  const auto containsFestival = [](const SelectionContext& context, const char* festivalId) {
    const auto items = EligibleItems(context, [](const char*) { return false; });
    return std::any_of(items.begin(), items.end(), [festivalId](const CatalogItem* item) {
      return std::strcmp(item->festival_id, festivalId) == 0;
    });
  };
  const auto containsId = [](const std::vector<const CatalogItem*>& items,
                             const char* itemId) {
    return std::any_of(items.begin(), items.end(), [itemId](const CatalogItem* item) {
      return std::strcmp(item->id, itemId) == 0;
    });
  };
  bool sawUsThanksgiving = false;
  for (const CatalogItem* item : usItems)
    if (std::strcmp(item->festival_id, "en.us_thanksgiving") == 0) sawUsThanksgiving = true;
  assert(sawUsThanksgiving);
  assert(containsId(usItems, "nm.en.0001"));
  SelectionContext gbSameEnglish = us;
  gbSameEnglish.region = "GB";
  const auto gbSameEnglishItems = EligibleItems(gbSameEnglish,
      [](const char*) { return false; });
  assert(containsId(gbSameEnglishItems, "nm.en.0001"));
  const auto usAfterIdWasShown = EligibleItems(us,
      [](const char* id) { return std::strcmp(id, "nm.en.0001") == 0; });
  const auto gbAfterIdWasShown = EligibleItems(gbSameEnglish,
      [](const char* id) { return std::strcmp(id, "nm.en.0001") == 0; });
  assert(!containsId(usAfterIdWasShown, "nm.en.0001"));
  assert(!containsId(gbAfterIdWasShown, "nm.en.0001"));
  std::uint32_t selectionRoll = 50;
  const CatalogItem* selectedOrdinary = SelectItem(usItems, false,
      [&selectionRoll](std::size_t bound) { return selectionRoll % bound; });
  assert(selectedOrdinary != nullptr &&
      std::strcmp(selectedOrdinary->category, "ordinary") == 0);
  selectionRoll = 0;
  const CatalogItem* selectedFestival = SelectItem(usItems, false,
      [&selectionRoll](std::size_t bound) { return selectionRoll % bound; });
  assert(selectedFestival != nullptr &&
      std::strcmp(selectedFestival->category, "festival") == 0);

  bool hasHumor = false, hasWarm = false;
  bool hasOrdinary = false, hasFestival = false;
  for (const CatalogItem* item : usItems) {
    hasHumor |= std::strcmp(item->tone, "humor") == 0;
    hasWarm |= std::strcmp(item->tone, "warm") == 0;
    hasOrdinary |= std::strcmp(item->category, "ordinary") == 0;
    hasFestival |= std::strcmp(item->category, "festival") == 0;
  }
  assert(hasHumor && hasWarm && hasOrdinary && hasFestival);
  std::mt19937 selectionRng(0x4e4d4701U);
  std::size_t warmSelected = 0, festivalSelected = 0;
  constexpr std::size_t kSelectionTrials = 20'000;
  for (std::size_t trial = 0; trial < kSelectionTrials; ++trial) {
    const CatalogItem* item = SelectItem(usItems, false,
        [&selectionRng](std::size_t bound) {
          return std::uniform_int_distribution<std::size_t>(0, bound - 1)(selectionRng);
        });
    assert(item != nullptr);
    if (std::strcmp(item->tone, "warm") == 0) ++warmSelected;
    if (std::strcmp(item->category, "festival") == 0) ++festivalSelected;
  }
  const double warmRate = static_cast<double>(warmSelected) / kSelectionTrials;
  const double festivalRate = static_cast<double>(festivalSelected) / kSelectionTrials;
  assert(warmRate > 0.18 && warmRate < 0.22);
  assert(festivalRate > 0.38 && festivalRate < 0.42);

  SelectionContext ca = us;
  ca.region = "CA";
  const auto caItems = EligibleItems(ca, [](const char*) { return false; });
  for (const CatalogItem* item : caItems)
    assert(std::strcmp(item->festival_id, "en.us_thanksgiving") != 0);
  SelectionContext caThanksgiving = us;
  caThanksgiving.region = "CA";
  caThanksgiving.month = 10;
  caThanksgiving.day = 12;
  assert(containsFestival(caThanksgiving, "en.ca_thanksgiving"));
  assert(!containsFestival(caThanksgiving, "en.us_thanksgiving"));

  SelectionContext usLaborDay = us;
  usLaborDay.region = "US";
  usLaborDay.month = 9;
  usLaborDay.day = 7;
  SelectionContext caLaborDay = usLaborDay;
  caLaborDay.region = "CA";
  SelectionContext auLaborDay = usLaborDay;
  auLaborDay.region = "AU";
  assert(containsFestival(usLaborDay, "en.na_labor_day"));
  assert(containsFestival(caLaborDay, "en.na_labor_day"));
  assert(!containsFestival(auLaborDay, "en.na_labor_day"));

  SelectionContext nzLabourDay = us;
  nzLabourDay.region = "NZ";
  nzLabourDay.month = 10;
  nzLabourDay.day = 26;
  SelectionContext auOnNzLabourDay = nzLabourDay;
  auOnNzLabourDay.region = "AU";
  assert(containsFestival(nzLabourDay, "en.nz_labour_day"));
  assert(!containsFestival(auOnNzLabourDay, "en.nz_labour_day"));

  SelectionContext usIndependence = us;
  usIndependence.month = 7;
  usIndependence.day = 3;
  assert(!containsFestival(usIndependence, "en.us_independence"));
  usIndependence.day = 4;
  assert(containsFestival(usIndependence, "en.us_independence"));

  SelectionContext boxingDay = us;
  boxingDay.region = "CA";
  boxingDay.month = 12;
  boxingDay.day = 26;
  assert(containsFestival(boxingDay, "en.boxing_day"));
  boxingDay.region = "IE";
  assert(!containsFestival(boxingDay, "en.boxing_day"));
  boxingDay.region = "CA";
  boxingDay.day = 27;  // A weekend/substitute day is not the named festival date.
  assert(!containsFestival(boxingDay, "en.boxing_day"));

  SelectionContext gbBonfire = us;
  gbBonfire.region = "GB";
  gbBonfire.month = 11;
  gbBonfire.day = 5;
  gbBonfire.minute_of_day = 17 * 60 + 59;
  assert(!containsFestival(gbBonfire, "en.gb_bonfire"));
  gbBonfire.minute_of_day = 18 * 60;
  assert(containsFestival(gbBonfire, "en.gb_bonfire"));
  gbBonfire.region = "US";
  assert(!containsFestival(gbBonfire, "en.gb_bonfire"));

  const int easterYears[] = {2026, 2027, 2028};
  const int easterMonths[] = {4, 3, 4};
  const int easterDays[] = {5, 28, 16};
  for (std::size_t index = 0; index < std::size(easterYears); ++index) {
    SelectionContext easter = us;
    easter.year = easterYears[index];
    easter.month = easterMonths[index];
    easter.day = easterDays[index];
    assert(containsFestival(easter, "en.easter"));
    easter.day += 1;
    assert(!containsFestival(easter, "en.easter"));
  }

  SelectionContext halloween = us;
  halloween.month = 10;
  halloween.day = 31;
  assert(containsFestival(halloween, "en.halloween"));
  halloween.day = 1;
  halloween.month = 11;
  assert(!containsFestival(halloween, "en.halloween"));

  SelectionContext christmasEve = us;
  christmasEve.month = 12;
  christmasEve.day = 24;
  christmasEve.minute_of_day = 17 * 60 + 59;
  assert(!containsFestival(christmasEve, "en.christmas_eve"));
  christmasEve.minute_of_day = 18 * 60;
  assert(containsFestival(christmasEve, "en.christmas_eve"));
  christmasEve.minute_of_day = 23 * 60 + 59;
  assert(containsFestival(christmasEve, "en.christmas_eve"));
  christmasEve.day = 25;
  christmasEve.minute_of_day = 0;
  assert(!containsFestival(christmasEve, "en.christmas_eve"));

  SelectionContext newYearsEve = us;
  newYearsEve.region = "*";
  newYearsEve.month = 12;
  newYearsEve.day = 31;
  newYearsEve.minute_of_day = 17 * 60 + 59;
  assert(!containsFestival(newYearsEve, "en.new_year_eve"));
  newYearsEve.minute_of_day = 23 * 60 + 59;
  assert(containsFestival(newYearsEve, "en.new_year_eve"));
  newYearsEve.year = 2027;
  newYearsEve.month = 1;
  newYearsEve.day = 1;
  newYearsEve.minute_of_day = 0;
  assert(!containsFestival(newYearsEve, "en.new_year_eve"));
  assert(containsFestival(newYearsEve, "en.new_year"));

  SelectionContext afterDateTable = us;
  afterDateTable.year = 2041;
  afterDateTable.month = 4;
  afterDateTable.day = 5;
  const auto afterDateTableItems = EligibleItems(afterDateTable,
      [](const char*) { return false; });
  bool afterDateTableHasOrdinary = false;
  for (const CatalogItem* item : afterDateTableItems) {
    if (std::strcmp(item->category, "ordinary") == 0) afterDateTableHasOrdinary = true;
    assert(std::strcmp(item->festival_id, "en.easter") != 0);
  }
  assert(afterDateTableHasOrdinary);
  SelectionContext fixedHolidayAfterDateTable = afterDateTable;
  fixedHolidayAfterDateTable.month = 1;
  fixedHolidayAfterDateTable.day = 1;
  assert(containsFestival(fixedHolidayAfterDateTable, "en.new_year"));

  SelectionContext unknown = us;
  unknown.region = "*";
  const auto unknownItems = EligibleItems(unknown, [](const char*) { return false; });
  bool unknownHasOrdinary = false;
  for (const CatalogItem* item : unknownItems) {
    if (std::strcmp(item->category, "ordinary") == 0) unknownHasOrdinary = true;
    assert(std::strcmp(item->category, "festival") != 0);
  }
  assert(unknownHasOrdinary);  // Unknown regions retain ordinary English at US Thanksgiving.

  SelectionContext unsupportedRegion = us;
  unsupportedRegion.region = "IN";
  const auto unsupportedRegionItems = EligibleItems(unsupportedRegion,
      [](const char*) { return false; });
  bool unsupportedHasOrdinary = false;
  for (const CatalogItem* item : unsupportedRegionItems) {
    if (std::strcmp(item->category, "ordinary") == 0) unsupportedHasOrdinary = true;
    assert(std::strcmp(item->category, "festival") != 0);
  }
  assert(unsupportedHasOrdinary);  // en-IN is not guessed to be a supported festival market.

  SelectionContext unknownNewYearsEve = unknown;
  unknownNewYearsEve.month = 12;
  unknownNewYearsEve.day = 31;
  unknownNewYearsEve.minute_of_day = 18 * 60;
  const auto unknownNewYearsEveItems = EligibleItems(unknownNewYearsEve,
      [](const char*) { return false; });
  bool sawGlobalNewYearsEve = false;
  for (const CatalogItem* item : unknownNewYearsEveItems) {
    if (std::strcmp(item->category, "festival") == 0) {
      assert(std::strcmp(item->festival_id, "en.new_year_eve") == 0);
      sawGlobalNewYearsEve = true;
    }
  }
  assert(sawGlobalNewYearsEve);

  SelectionContext unknownNewYear = unknown;
  unknownNewYear.month = 1;
  unknownNewYear.day = 1;
  unknownNewYear.minute_of_day = 0;
  const auto unknownNewYearItems = EligibleItems(unknownNewYear,
      [](const char*) { return false; });
  bool sawGlobalNewYear = false;
  for (const CatalogItem* item : unknownNewYearItems) {
    if (std::strcmp(item->category, "festival") == 0) {
      assert(std::strcmp(item->festival_id, "en.new_year") == 0);
      sawGlobalNewYear = true;
    }
  }
  assert(sawGlobalNewYear);

  SelectionContext zh = us;
  zh.locale = Locale::Chinese;
  zh.region = "US";
  zh.day = 1;
  zh.month = 5;
  const auto zhItems = EligibleItems(zh, [](const char*) { return false; });
  bool sawChineseLaborDay = false;
  for (const CatalogItem* item : zhItems)
    if (std::strcmp(item->festival_id, "labor_day") == 0) sawChineseLaborDay = true;
  assert(sawChineseLaborDay);

  SelectionContext unknownOvertime = us;
  unknownOvertime.overtime = Overtime::Unknown;
  const auto noOvertimeItems = EligibleItems(unknownOvertime, [](const char*) { return false; });
  for (const CatalogItem* item : noOvertimeItems) assert(!item->requires_overtime);
  bool sawEligibleHumor = false;
  for (const CatalogItem* item : noOvertimeItems)
    if (std::strcmp(item->tone, "humor") == 0) sawEligibleHumor = true;
  assert(sawEligibleHumor);
  for (unsigned roll = 0; roll < 100; ++roll) {
    const CatalogItem* selected = SelectItem(noOvertimeItems, true,
        [roll](std::size_t bound) { return roll % bound; });
    assert(selected == nullptr || std::strcmp(selected->tone, "warm") != 0);
  }

  SelectionContext nightOnly = us;
  nightOnly.minute_of_day = 23 * 60 + 59;
  const auto lateItems = EligibleItems(nightOnly, [](const char*) { return false; });
  assert(!lateItems.empty());
  nightOnly.minute_of_day = 24 * 60;
  assert(EligibleItems(nightOnly, [](const char*) { return false; }).empty());

  SelectionContext stale = us;
  assert(!EligibleItems(stale, [](const char* id) {
    return std::strcmp(id, "nm.en.0001") == 0;
  }).empty());
  assert(EligibleItems(stale, [](const char*) { return true; }).empty());

  const auto store_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-test-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore store(store_root);
  constexpr std::int64_t start_utc = 1'800'000'000;
  assert(store.SetSegmentConsumed(true, start_utc) == StoreResult::Success);
  assert(store.TryReserve("nm.en.0001", "2026-10-18", false, start_utc) == StoreResult::Success);
  assert(store.IsRecentlyShown("nm.en.0001", start_utc + 1));
  assert(store.TryReserve("nm.en.0001", "2026-10-18", false,
      start_utc + 45 * 60) == StoreResult::LimitReached);
  assert(store.TryReserve("nm.en.0002", "2026-10-18", false,
      start_utc + 45 * 60 - 1) == StoreResult::LimitReached);
  assert(store.TryReserve("nm.en.0002", "2026-10-18", false,
      start_utc + 45 * 60) == StoreResult::Success);
  assert(store.SetSegmentConsumed(false, start_utc + 45 * 60) == StoreResult::Success);
  assert(store.TryReserve("nm.en.0003", "2026-10-18", false,
      start_utc + 90 * 60) == StoreResult::LimitReached);
  assert(store.SetSegmentConsumed(true, start_utc + 90 * 60) == StoreResult::Success);
  assert(store.TryReserve("nm.en.0003", "2026-10-18", true,
      start_utc + 90 * 60) == StoreResult::Success);
  assert(store.SetSegmentConsumed(true, start_utc + 135 * 60) == StoreResult::Success);
  assert(store.TryReserve("nm.en.0004", "2026-10-18", true,
      start_utc + 135 * 60) == StoreResult::LimitReached);
  assert(store.TryReserve("nm.en.0004", "2026-10-18", false,
      start_utc + 135 * 60) == StoreResult::Success);
  ReminderStore restarted_store(store_root);
  assert(restarted_store.IsRecentlyShown("nm.en.0004", start_utc + 135 * 60));
  assert(restarted_store.SegmentConsumed());
  std::unordered_set<std::string> stored_recent;
  bool stored_warm = false;
  assert(restarted_store.ReadSelectionHistory("2026-10-18", start_utc + 140 * 60,
      &stored_recent, &stored_warm));
  assert(stored_recent.count("nm.en.0004") == 1 && stored_warm);
  assert(restarted_store.TryReserve("nm.en.0005", "2026-10-18", false,
      start_utc + 180 * 60) == StoreResult::Success);
  assert(restarted_store.TryReserve("nm.en.0006", "2026-10-18", false,
      start_utc + 225 * 60) == StoreResult::LimitReached);
  assert(restarted_store.TryReserve("nm.en.0004", "2026-10-18", false,
      start_utc + 200 * 60) == StoreResult::LimitReached);
  assert(restarted_store.TryReserve("nm.en.0004", "2026-10-26", false,
      start_utc + 8 * 24 * 60 * 60) == StoreResult::Success);
  {
    std::ofstream damaged(store_root / "state.dat", std::ios::binary | std::ios::trunc);
    damaged << "interrupted-write";
  }
  assert(restarted_store.IsRecentlyShown("nm.en.0005", start_utc + 8 * 24 * 60 * 60));
  assert(restarted_store.TryReserve("nm.en.0005", "2026-10-26", false,
      start_utc + 8 * 24 * 60 * 60) == StoreResult::ClockGuard);
  std::filesystem::remove(store_root / "state.dat");
  assert(!restarted_store.ReadSelectionHistory("2026-10-26", start_utc + 8 * 24 * 60 * 60,
      &stored_recent, &stored_warm));
  assert(restarted_store.TryReserve("nm.en.0005", "2026-10-26", false,
      start_utc + 8 * 24 * 60 * 60) == StoreResult::ClockGuard);
  std::filesystem::remove_all(store_root);

  const auto dedup_boundary_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-dedup-boundary-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore dedupBoundaryStore(dedup_boundary_root);
  const std::int64_t dedupStart = 1'800'100'000;
  constexpr std::int64_t kIdCooldownSeconds = 7 * 24 * 60 * 60;
  assert(dedupBoundaryStore.SetSegmentConsumed(true, dedupStart) == StoreResult::Success);
  assert(dedupBoundaryStore.TryReserve("nm.en.boundary", "2026-10-18", false,
      dedupStart) == StoreResult::Success);
  assert(dedupBoundaryStore.IsRecentlyShown("nm.en.boundary",
      dedupStart + kIdCooldownSeconds - 1));
  assert(dedupBoundaryStore.TryReserve("nm.en.boundary", "2026-10-25", false,
      dedupStart + kIdCooldownSeconds - 1) == StoreResult::LimitReached);
  assert(!dedupBoundaryStore.IsRecentlyShown("nm.en.boundary",
      dedupStart + kIdCooldownSeconds));
  assert(dedupBoundaryStore.TryReserve("nm.en.boundary", "2026-10-25", false,
      dedupStart + kIdCooldownSeconds) == StoreResult::Success);
  std::filesystem::remove_all(dedup_boundary_root);

  const auto bilingual_quota_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-bilingual-quota-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore bilingualQuotaStore(bilingual_quota_root);
  const std::int64_t bilingualStart = 1'800'200'000;
  assert(bilingualQuotaStore.SetSegmentConsumed(true, bilingualStart) == StoreResult::Success);
  for (unsigned slot = 0; slot < 5; ++slot) {
    const std::string id = slot % 2 == 0
        ? "nm.zh.quota." + std::to_string(slot)
        : "nm.en.quota." + std::to_string(slot);
    assert(bilingualQuotaStore.TryReserve(id.c_str(), "2026-10-18", false,
        bilingualStart + slot * 45 * 60) == StoreResult::Success);
  }
  assert(bilingualQuotaStore.TryReserve("nm.en.quota.overflow", "2026-10-18", false,
      bilingualStart + 5 * 45 * 60) == StoreResult::LimitReached);
  std::unordered_set<std::string> bilingualHistory;
  bool bilingualWarmUsed = false;
  assert(bilingualQuotaStore.ReadSelectionHistory("2026-10-18",
      bilingualStart + 5 * 45 * 60, &bilingualHistory, &bilingualWarmUsed));
  assert(bilingualHistory.size() == 5);
  assert(bilingualHistory.count("nm.zh.quota.0") == 1);
  assert(bilingualHistory.count("nm.en.quota.1") == 1);
  std::filesystem::remove_all(bilingual_quota_root);

  const auto bilingual_warm_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-bilingual-warm-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore bilingualWarmStore(bilingual_warm_root);
  const std::int64_t bilingualWarmStart = 1'800'300'000;
  assert(bilingualWarmStore.SetSegmentConsumed(true, bilingualWarmStart) ==
      StoreResult::Success);
  assert(bilingualWarmStore.TryReserve("nm.zh.warm", "2026-10-18", true,
      bilingualWarmStart) == StoreResult::Success);
  assert(bilingualWarmStore.TryReserve("nm.en.warm", "2026-10-18", true,
      bilingualWarmStart + 45 * 60) == StoreResult::LimitReached);
  assert(bilingualWarmStore.TryReserve("nm.en.humor", "2026-10-18", false,
      bilingualWarmStart + 45 * 60) == StoreResult::Success);
  assert(bilingualWarmStore.ReadSelectionHistory("2026-10-18",
      bilingualWarmStart + 45 * 60, &bilingualHistory, &bilingualWarmUsed));
  assert(bilingualWarmUsed);
  assert(bilingualHistory.count("nm.zh.warm") == 1);
  assert(bilingualHistory.count("nm.en.warm") == 0);
  assert(bilingualHistory.count("nm.en.humor") == 1);
  std::filesystem::remove_all(bilingual_warm_root);

  const auto clock_store_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-clock-guard-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore clockStore(clock_store_root);
  const std::int64_t clockStart = 1'800'000'000;
  assert(clockStore.SetSegmentConsumed(true, clockStart) == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0100", "2027-01-15", false,
      clockStart) == StoreResult::Success);
  const std::int64_t clockBack = clockStart - 600;
  assert(clockStore.ClockGuard(clockBack, "2027-01-15"));
  assert(clockStore.IsRecentlyShown("nm.en.0100", clockBack));
  assert(clockStore.ClockGuard(clockBack, "2027-01-15"));
  assert(!clockStore.ReadSelectionHistory("2027-01-15", clockBack,
      &stored_recent, &stored_warm));
  assert(clockStore.TryReserve("nm.en.0101", "2027-01-15", false,
      clockBack + 45 * 60) == StoreResult::ClockGuard);
  const std::int64_t stableClock = clockBack + 300;
  assert(clockStore.SetClockGuard(false, stableClock, "2027-01-15") == StoreResult::Success);
  assert(!clockStore.ClockGuard(stableClock, "2027-01-15"));
  assert(clockStore.ReadSelectionHistory("2027-01-15", stableClock,
      &stored_recent, &stored_warm));
  assert(stored_recent.count("nm.en.0100") == 1);
  assert(clockStore.TryReserve("nm.en.0100", "2027-01-15", false,
      stableClock + 45 * 60) == StoreResult::LimitReached);
  assert(clockStore.TryReserve("nm.en.0101", "2027-01-15", false,
      stableClock + 45 * 60) == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0102", "2027-01-15", false,
      stableClock + 90 * 60) == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0103", "2027-01-15", false,
      stableClock + 135 * 60) == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0104", "2027-01-15", false,
      stableClock + 180 * 60) == StoreResult::Success);
  const std::int64_t forwardJump = clockStart + 24 * 60 * 60;
  assert(clockStore.SetClockGuard(true, forwardJump, "2027-01-16") == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0105", "2027-01-16", false,
      forwardJump + 45 * 60) == StoreResult::ClockGuard);
  const std::int64_t forwardRecovery = forwardJump + 300;
  assert(clockStore.SetClockGuard(false, forwardRecovery, "2027-01-16") == StoreResult::Success);
  assert(clockStore.TryReserve("nm.en.0105", "2027-01-16", false,
      forwardRecovery + 45 * 60) == StoreResult::LimitReached);
  assert(clockStore.TryReserve("nm.en.0105", "2027-01-17", false,
      forwardRecovery + 24 * 60 * 60) == StoreResult::Success);
  std::filesystem::remove_all(clock_store_root);

  const auto legacy_store_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-legacy-state-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directories(legacy_store_root);
  {
    std::ofstream legacyState(legacy_store_root / "state.dat", std::ios::binary);
    legacyState << "NIUMA_REMINDER_STATE\t1\n"
        "daily\t2027-01-15\t1\n"
        "warm\t2027-01-15\t1\n"
        "last\t1800000000\n"
        "quiet\t0\n"
        "segment\t1\n"
        "id\tnm.en.0200\t1800000000\n";
    assert(legacyState.good());
  }
  ReminderStore legacyStore(legacy_store_root);
  assert(legacyStore.IsRecentlyShown("nm.en.0200", 1'800'000'001));
  assert(legacyStore.SegmentConsumed());
  assert(legacyStore.SetClockGuard(true, 1'800'000'001, "2027-01-15") ==
      StoreResult::Success);
  {
    std::ifstream migratedState(legacy_store_root / "state.dat", std::ios::binary);
    std::string header;
    std::getline(migratedState, header);
    assert(header == "NIUMA_REMINDER_STATE\t2");
  }
  std::filesystem::remove_all(legacy_store_root);

  const auto writeFailureRoot = std::filesystem::temp_directory_path() /
      ("niuma-reminder-write-failure-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore writeFailureStore(writeFailureRoot);
  const std::int64_t writeFailureStart = start_utc + 30 * 24 * 60 * 60;
  assert(writeFailureStore.SetSegmentConsumed(true, writeFailureStart) == StoreResult::Success);
  assert(writeFailureStore.TryReserve("nm.en.0008", "2026-11-17", false,
      writeFailureStart) == StoreResult::Success);
  std::filesystem::create_directory(writeFailureRoot / "state.tmp");
  assert(writeFailureStore.TryReserve("nm.en.0009", "2026-11-17", false,
      writeFailureStart + 45 * 60) == StoreResult::IoError);
  std::unordered_set<std::string> writeFailureHistory;
  assert(writeFailureStore.ReadSelectionHistory("2026-11-17",
      writeFailureStart + 45 * 60, &writeFailureHistory, &stored_warm));
  assert(writeFailureHistory.count("nm.en.0008") == 1);
  assert(writeFailureHistory.count("nm.en.0009") == 0);
  std::filesystem::remove_all(writeFailureRoot / "state.tmp");
  const auto stateBackup = writeFailureRoot / "state.bak";
  const auto preservedStateBackup = writeFailureRoot / "state.bak.preserved";
  assert(std::filesystem::exists(stateBackup));
  std::filesystem::rename(stateBackup, preservedStateBackup);
  std::filesystem::create_directory(stateBackup);
  assert(writeFailureStore.TryReserve("nm.en.0010", "2026-11-17", false,
      writeFailureStart + 45 * 60) == StoreResult::IoError);
  assert(writeFailureStore.ReadSelectionHistory("2026-11-17",
      writeFailureStart + 45 * 60, &writeFailureHistory, &stored_warm));
  assert(writeFailureHistory.count("nm.en.0008") == 1);
  assert(writeFailureHistory.count("nm.en.0010") == 0);
  std::filesystem::remove(stateBackup);
  std::filesystem::rename(preservedStateBackup, stateBackup);
#if defined(__APPLE__)
  const auto immutableState = writeFailureRoot / "state.dat";
  const int stateImmutableSet = chflags(immutableState.c_str(), UF_IMMUTABLE);
  StoreResult stateCommitFailure = StoreResult::InvalidState;
  if (stateImmutableSet == 0)
    stateCommitFailure = writeFailureStore.TryReserve("nm.en.0011", "2026-11-17", false,
        writeFailureStart + 45 * 60);
  const int stateImmutableCleared = stateImmutableSet == 0
      ? chflags(immutableState.c_str(), 0) : -1;
  const bool restoredStateReadable = stateImmutableCleared == 0 &&
      writeFailureStore.ReadSelectionHistory("2026-11-17",
          writeFailureStart + 45 * 60, &writeFailureHistory, &stored_warm);
  assert(stateImmutableSet == 0 && stateImmutableCleared == 0);
  assert(stateCommitFailure == StoreResult::IoError);
  assert(restoredStateReadable);
  assert(writeFailureHistory.count("nm.en.0008") == 1);
  assert(writeFailureHistory.count("nm.en.0011") == 0);
#endif
  std::filesystem::remove_all(writeFailureRoot);

  const auto boundary_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-boundary-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore boundary_store(boundary_root);
  assert(boundary_store.SetSegmentConsumed(true, start_utc) == StoreResult::Success);
  assert(boundary_store.TryReserve("nm.en.0007", "2026-10-18", false,
      start_utc) == StoreResult::Success);
  assert(boundary_store.SetSegmentConsumed(true, start_utc + 7 * 24 * 60 * 60) == StoreResult::Success);
  assert(boundary_store.TryReserve("nm.en.0007", "2026-10-25", false,
      start_utc + 7 * 24 * 60 * 60) == StoreResult::Success);
  std::filesystem::remove_all(boundary_root);

#if !defined(_WIN32)
  // The daily cap and cooldown must remain atomic across independent processes,
  // not merely across ReminderStore objects in one process.
  const auto concurrent_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-concurrent-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore concurrent_setup(concurrent_root);
  const std::int64_t concurrent_start = start_utc + 10 * 24 * 60 * 60;
  assert(concurrent_setup.SetSegmentConsumed(true, concurrent_start) == StoreResult::Success);
  for (unsigned slot = 0; slot < 4; ++slot) {
    assert(concurrent_setup.TryReserve(("nm.seed." + std::to_string(slot)).c_str(),
        "2026-10-28", false, concurrent_start + slot * 45 * 60) == StoreResult::Success);
  }
  constexpr unsigned kCompetitors = 6;
  std::vector<pid_t> competitors;
  for (unsigned index = 0; index < kCompetitors; ++index) {
    const pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
      ReminderStore contender(concurrent_root);
      const auto result = contender.TryReserve(
          ("nm.race." + std::to_string(index)).c_str(), "2026-10-28", false,
          concurrent_start + 4 * 45 * 60);
      _exit(result == StoreResult::Success ? 0 :
            result == StoreResult::LimitReached ? 1 : 2);
    }
    competitors.push_back(child);
  }
  unsigned winners = 0;
  for (const pid_t child : competitors) {
    int status = 0;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && (WEXITSTATUS(status) == 0 || WEXITSTATUS(status) == 1));
    if (WEXITSTATUS(status) == 0) ++winners;
  }
  assert(winners == 1);
  std::unordered_set<std::string> concurrent_history;
  assert(concurrent_setup.ReadSelectionHistory("2026-10-28",
      concurrent_start + 4 * 45 * 60, &concurrent_history, &stored_warm));
  assert(concurrent_history.size() == 5);
  std::filesystem::remove_all(concurrent_root);
#endif
#if defined(_WIN32)
  const auto windows_concurrent_root = std::filesystem::temp_directory_path() /
      ("niuma-reminder-windows-concurrent-" + std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count()));
  ReminderStore windows_concurrent_setup(windows_concurrent_root);
  const std::int64_t windows_concurrent_start = start_utc + 10 * 24 * 60 * 60;
  assert(windows_concurrent_setup.SetSegmentConsumed(true,
      windows_concurrent_start) == StoreResult::Success);
  for (unsigned slot = 0; slot < 4; ++slot) {
    assert(windows_concurrent_setup.TryReserve(
        ("nm.seed.win." + std::to_string(slot)).c_str(), "2026-10-28", false,
        windows_concurrent_start + slot * 45 * 60) == StoreResult::Success);
  }
  constexpr unsigned kWindowsCompetitors = 6;
  const bool windowsRacePassed = RunWindowsReservationRace(
      windows_concurrent_root, windows_concurrent_start + 4 * 45 * 60,
      kWindowsCompetitors);
  assert(windowsRacePassed);
  std::unordered_set<std::string> windows_concurrent_history;
  assert(windows_concurrent_setup.ReadSelectionHistory("2026-10-28",
      windows_concurrent_start + 4 * 45 * 60,
      &windows_concurrent_history, &stored_warm));
  assert(windows_concurrent_history.size() == 5);
  std::filesystem::remove_all(windows_concurrent_root);
#endif

  ActivitySampler gate;
  gate.Observe(ActivitySampler::Event::KeyDown, 1'000);
  gate.Observe(ActivitySampler::Event::KeyDown, 1'100);
  gate.Observe(ActivitySampler::Event::KeyDown, 1'200);
  gate.Observe(ActivitySampler::Event::KeyUp, 1'300);
  gate.Observe(ActivitySampler::Event::KeyDown, 1'400);
  assert(gate.Evaluate(10'000) == ActivitySampler::Trigger::None);

  ActivitySampler high;
  high.Evaluate(1'000, true);
  ActivitySampler::Trigger highTrigger = ActivitySampler::Trigger::None;
  for (std::uint64_t bucket = 0; bucket < 30; ++bucket) {
    const auto base = 10'000 + bucket * ActivitySampler::kBucketMs;
    for (std::uint64_t second = 0; second < 2; ++second) {
      const auto at = base + second * 1'000;
      for (int key = 0; key < 8; ++key) {
        high.Observe(ActivitySampler::Event::KeyDown, at + key * 20);
        high.Observe(ActivitySampler::Event::KeyUp, at + key * 20 + 10);
      }
      for (int click = 0; click < 4; ++click)
        high.Observe(ActivitySampler::Event::Click, at + 200 + click * 20);
    }
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000) {
      const auto observed = high.Evaluate(tick + 500, true);
      if (observed != ActivitySampler::Trigger::None) highTrigger = observed;
    }
  }
  assert(highTrigger == ActivitySampler::Trigger::HighIntensity);
  assert(high.segment_consumed());
  assert(high.Evaluate(10'000 + 30 * 10'000 + 1'000) ==
      ActivitySampler::Trigger::None);
  assert(RunHighIntensityBoundary(21, false) ==
      ActivitySampler::Trigger::HighIntensity);  // Exactly 600 points, 21 active buckets.
  assert(RunHighIntensityBoundary(21, true) ==
      ActivitySampler::Trigger::None);  // 599.75 points must stay below threshold.
  assert(RunHighIntensityBoundary(20, false) ==
      ActivitySampler::Trigger::None);  // Score alone cannot replace the active-bucket minimum.
  assert(RunSingleSecondBurstLimiterBoundary() == ActivitySampler::Trigger::None);
  assert(RunContinuousScroll(300) == ActivitySampler::Trigger::None);  // At most 75 points in five minutes.
  assert(RunContinuousScroll(1'680) == ActivitySampler::Trigger::LongBusy);  // Rolling remains activity.

  ActivitySampler longBusy;
  longBusy.Evaluate(1'000, true);
  ActivitySampler::Trigger longTrigger = ActivitySampler::Trigger::None;
  for (std::uint64_t bucket = 0; bucket < 168; ++bucket) {
    const auto base = 10'000 + bucket * ActivitySampler::kBucketMs;
    if (bucket % 4 != 0) AddClicks(longBusy, base + 100);
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000) {
      const auto observed = longBusy.Evaluate(tick + 500, true);
      if (observed != ActivitySampler::Trigger::None) longTrigger = observed;
    }
  }
  const auto nextLongTrigger = longBusy.Evaluate(1'700'000, true);
  if (nextLongTrigger != ActivitySampler::Trigger::None) longTrigger = nextLongTrigger;
  assert(longTrigger == ActivitySampler::Trigger::LongBusy);
  assert(longBusy.segment_consumed());

  ActivitySampler longSingleSegment;
  longSingleSegment.Evaluate(1'000, true);
  unsigned longBusyCandidates = 0;
  // Keep one uninterrupted busy segment for 26 hours; local-day quota rollover
  // must not create a second segment opportunity at midnight.
  for (std::uint64_t bucket = 0; bucket < 9'360; ++bucket) {
    const auto base = 10'000 + bucket * ActivitySampler::kBucketMs;
    AddClicks(longSingleSegment, base + 100);
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000) {
      if (longSingleSegment.Evaluate(tick + 500, true) == ActivitySampler::Trigger::LongBusy)
        ++longBusyCandidates;
    }
  }
  assert(longBusyCandidates == 1);  // 26 uninterrupted hours still yield only one segment candidate.
  assert(longSingleSegment.segment_consumed());

  ActivitySampler belowLongBusy;
  belowLongBusy.Evaluate(1'000, true);
  for (std::uint64_t bucket = 0; bucket < 168; ++bucket) {
    const auto base = 10'000 + bucket * ActivitySampler::kBucketMs;
    if (bucket % 4 != 0 && bucket != 2) AddClicks(belowLongBusy, base + 100);
    for (std::uint64_t tick = base; tick < base + 10'000; tick += 1'000)
      belowLongBusy.Evaluate(tick + 500, true);
  }
  assert(belowLongBusy.Evaluate(1'700'000, true) == ActivitySampler::Trigger::None);
  assert(!belowLongBusy.segment_consumed());  // 125 active buckets must stay below 126.
  assert(RunLongBusyRecentBoundary(18) == ActivitySampler::Trigger::LongBusy);
  assert(RunLongBusyRecentBoundary(17) == ActivitySampler::Trigger::None);

  const std::uint64_t afterHighMs = 10'000 + 30 * 10'000 + 1'000;
  for (std::uint64_t tick = afterHighMs; tick <= afterHighMs + 300'000; tick += 1'000)
    high.Evaluate(tick, true);
  assert(!high.segment_consumed());

  ActivitySampler rest;
  rest.Evaluate(1'000, true);
  for (std::uint64_t tick = 2'000; tick <= 302'000; tick += 1'000)
    rest.Evaluate(tick, true);
  assert(!rest.segment_consumed());

  ActivitySampler sparseNotRest;
  sparseNotRest.Evaluate(1'000, true);
  sparseNotRest.RestoreSegmentConsumed(true);
  const std::uint64_t sparseEvents[] = {1'000, 51'000, 101'000, 151'000, 201'000, 251'000};
  std::size_t sparseIndex = 0;
  for (std::uint64_t tick = 1'000; tick <= 300'000; tick += 1'000) {
    if (sparseIndex < std::size(sparseEvents) && tick == sparseEvents[sparseIndex]) {
      sparseNotRest.Observe(ActivitySampler::Event::Click, tick);
      ++sparseIndex;
    }
    sparseNotRest.Evaluate(tick, true);
  }
  assert(sparseIndex == std::size(sparseEvents));
  assert(sparseNotRest.segment_consumed());  // Six sparse events cannot satisfy the ≤5-event rest rule.

  ActivitySampler exactRest;
  exactRest.Evaluate(1'000, true);
  AddClicks(exactRest, 2'000);
  exactRest.RestoreSegmentConsumed(true);
  for (std::uint64_t tick = 3'000; tick < 302'200; tick += 1'000)
    exactRest.Evaluate(tick, true);
  assert(exactRest.segment_consumed());  // One millisecond before five idle minutes remains locked.
  assert(exactRest.Evaluate(302'200, true) == ActivitySampler::Trigger::None);
  assert(!exactRest.segment_consumed());  // Five full idle minutes clear the segment lock.

  ActivitySampler listenerLoss;
  listenerLoss.Evaluate(1'000, true);
  listenerLoss.RestoreSegmentConsumed(true);
  listenerLoss.Observe(ActivitySampler::Event::Click, 2'000);
  assert(listenerLoss.Evaluate(3'000, false) == ActivitySampler::Trigger::None);
  assert(listenerLoss.segment_consumed());  // Missing events cannot turn listener failure into a new segment.

  ActivitySampler lifecycle;
  lifecycle.RestoreSegmentConsumed(true);
  lifecycle.BeginSuspend(10'000);
  lifecycle.Observe(ActivitySampler::Event::Click, 20'000);
  assert(lifecycle.Evaluate(300'000, true) == ActivitySampler::Trigger::None);
  assert(!lifecycle.ResumeFromSuspend(310'000, true, true, 299'999));
  assert(lifecycle.segment_consumed());  // Paired but short sleep clears the window only.
  lifecycle.BeginSuspend(400'000);
  assert(!lifecycle.ResumeFromSuspend(1'000'000, false, true, 600'000));
  assert(lifecycle.segment_consumed());  // A wake without its suspend pair is not a rest.
  lifecycle.BeginSuspend(1'100'000);
  assert(lifecycle.ResumeFromSuspend(1'700'000, true, true, 300'000));
  assert(!lifecycle.segment_consumed());  // Exactly five trusted inactive minutes unlock.

  std::uint64_t estimatedSleepMs = 0;
  assert(EstimateSleepDurationMs(650'000, 50'000'000, true, &estimatedSleepMs));
  assert(estimatedSleepMs == 645'000);
  assert(!EstimateSleepDurationMs(4'000, 50'000'000, true, &estimatedSleepMs));
  assert(!EstimateSleepDurationMs(650'000, 50'000'000, false, &estimatedSleepMs));
  assert(!EstimateSleepDurationMs(650'000, 50'000'000, true, nullptr));

  ActivitySampler gap;
  gap.Observe(ActivitySampler::Event::Click, 2'000);
  gap.Evaluate(3'000, true);
  assert(gap.Evaluate(34'000, true) == ActivitySampler::Trigger::None);
  return 0;
}
