#pragma once

#include "reminder_catalog_update.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <climits>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#endif

namespace niuma::reminder {

#if defined(_WIN32)
inline bool VerifyCatalogP256(const std::vector<std::uint8_t>& public_xy,
                              const std::vector<std::uint8_t>& message,
                              const std::vector<std::uint8_t>& signature) {
  if (public_xy.size() != 64 || signature.size() != 64 || message.empty() ||
      message.size() > ULONG_MAX) return false;
  BCRYPT_ALG_HANDLE hash_algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0, result_size = 0;
  std::vector<std::uint8_t> object;
  std::array<std::uint8_t, 32> digest{};
  bool okay = BCryptOpenAlgorithmProvider(&hash_algorithm, BCRYPT_SHA256_ALGORITHM,
                                           nullptr, 0) >= 0 &&
      BCryptGetProperty(hash_algorithm, BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
          &result_size, 0) >= 0;
  if (okay) {
    object.resize(object_size);
    okay = BCryptCreateHash(hash_algorithm, &hash, object.data(), object_size,
                            nullptr, 0, 0) >= 0;
  }
  if (okay) okay = BCryptHashData(hash,
      const_cast<PUCHAR>(message.data()), static_cast<ULONG>(message.size()), 0) >= 0;
  if (okay) okay = BCryptFinishHash(hash, digest.data(),
      static_cast<ULONG>(digest.size()), 0) >= 0;
  if (hash) BCryptDestroyHash(hash);
  if (hash_algorithm) BCryptCloseAlgorithmProvider(hash_algorithm, 0);
  if (!okay) return false;

  struct PublicBlob {
    BCRYPT_ECCKEY_BLOB header;
    std::uint8_t xy[64];
  } blob{};
  blob.header.dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
  blob.header.cbKey = 32;
  std::copy(public_xy.begin(), public_xy.end(), blob.xy);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_KEY_HANDLE key = nullptr;
  bool valid = BCryptOpenAlgorithmProvider(&algorithm,
      BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) >= 0;
  if (valid) valid = BCryptImportKeyPair(algorithm, nullptr,
      BCRYPT_ECCPUBLIC_BLOB, &key, reinterpret_cast<PUCHAR>(&blob),
      sizeof(blob), 0) >= 0;
  if (valid) valid = BCryptVerifySignature(key, nullptr, digest.data(),
      static_cast<ULONG>(digest.size()),
      const_cast<PUCHAR>(signature.data()), static_cast<ULONG>(signature.size()), 0) >= 0;
  if (key) BCryptDestroyKey(key);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return valid;
}
#elif defined(__APPLE__)
inline bool AppendDerInteger(const std::uint8_t* bytes, std::size_t size,
                             std::vector<std::uint8_t>* output) {
  while (size > 1 && *bytes == 0) { ++bytes; --size; }
  if (size == 0 || size > 33) return false;
  output->push_back(0x02);
  const bool prefix_zero = (bytes[0] & 0x80) != 0;
  output->push_back(static_cast<std::uint8_t>(size + (prefix_zero ? 1 : 0)));
  if (prefix_zero) output->push_back(0);
  output->insert(output->end(), bytes, bytes + size);
  return true;
}

inline bool VerifyCatalogP256(const std::vector<std::uint8_t>& public_xy,
                              const std::vector<std::uint8_t>& message,
                              const std::vector<std::uint8_t>& signature) {
  if (public_xy.size() != 64 || signature.size() != 64 || message.empty() ||
      message.size() > UINT32_MAX) return false;
  std::vector<std::uint8_t> body;
  if (!AppendDerInteger(signature.data(), 32, &body) ||
      !AppendDerInteger(signature.data() + 32, 32, &body) || body.size() > 127)
    return false;
  std::vector<std::uint8_t> der{0x30, static_cast<std::uint8_t>(body.size())};
  der.insert(der.end(), body.begin(), body.end());
  std::vector<std::uint8_t> point{0x04};
  point.insert(point.end(), public_xy.begin(), public_xy.end());
  CFDataRef key_data = CFDataCreate(kCFAllocatorDefault, point.data(),
                                    static_cast<CFIndex>(point.size()));
  if (!key_data) return false;
  const void* keys[] = {kSecAttrKeyType, kSecAttrKeyClass, kSecAttrKeySizeInBits};
  int key_bits = 256;
  CFNumberRef bits = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &key_bits);
  const void* stable_values[] = {kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClassPublic, bits};
  CFDictionaryRef attributes = CFDictionaryCreate(kCFAllocatorDefault, keys,
      stable_values, 3, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (bits) CFRelease(bits);
  CFErrorRef key_error = nullptr;
  SecKeyRef key = attributes ? SecKeyCreateWithData(key_data, attributes, &key_error) : nullptr;
  CFRelease(key_data);
  if (attributes) CFRelease(attributes);
  if (key_error) CFRelease(key_error);
  if (!key) return false;
  CFDataRef message_data = CFDataCreate(kCFAllocatorDefault, message.data(),
      static_cast<CFIndex>(message.size()));
  CFDataRef signature_data = CFDataCreate(kCFAllocatorDefault, der.data(),
      static_cast<CFIndex>(der.size()));
  bool valid = false;
  if (message_data && signature_data) {
    CFErrorRef verify_error = nullptr;
    valid = SecKeyVerifySignature(key,
        kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
        message_data, signature_data, &verify_error);
    if (verify_error) CFRelease(verify_error);
  }
  if (message_data) CFRelease(message_data);
  if (signature_data) CFRelease(signature_data);
  CFRelease(key);
  return valid;
}
#endif

inline bool CatalogSha256(const std::string& bytes,
                          std::array<std::uint8_t, 32>* digest) {
  if (digest == nullptr) return false;
#if defined(_WIN32)
  if (bytes.size() > ULONG_MAX) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_size = 0, result_size = 0;
  std::vector<std::uint8_t> object;
  bool okay = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                           nullptr, 0) >= 0 &&
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size),
          &result_size, 0) >= 0;
  if (okay) {
    object.resize(object_size);
    okay = BCryptCreateHash(algorithm, &hash, object.data(), object_size,
                            nullptr, 0, 0) >= 0;
  }
  if (okay && !bytes.empty()) okay = BCryptHashData(hash,
      reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),
      static_cast<ULONG>(bytes.size()), 0) >= 0;
  if (okay) okay = BCryptFinishHash(hash, digest->data(),
      static_cast<ULONG>(digest->size()), 0) >= 0;
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  return okay;
#elif defined(__APPLE__)
  if (bytes.size() > UINT32_MAX) return false;
  return CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()),
                   digest->data()) != nullptr;
#else
  (void)bytes;
  return false;
#endif
}

struct CatalogTrustedKey {
  std::string key_id;
  std::vector<std::uint8_t> public_xy;
};

inline CatalogSignatureVerifier MakeCatalogSignatureVerifier(
    std::vector<CatalogTrustedKey> trusted_keys) {
  return [keys = std::move(trusted_keys)](const std::string& key_id,
      const std::vector<std::uint8_t>& message,
      const std::vector<std::uint8_t>& signature) {
    for (const auto& key : keys) {
      if (key.key_id == key_id)
        return VerifyCatalogP256(key.public_xy, message, signature);
    }
    return false;
  };
}

}  // namespace niuma::reminder
