#pragma once

#include "reminder_policy.h"

#include <charconv>
#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace niuma::reminder {

using CatalogSignatureVerifier = std::function<bool(
    const std::string& key_id, const std::vector<std::uint8_t>& message,
    const std::vector<std::uint8_t>& signature)>;

struct JsonValue {
  enum class Kind { Null, Boolean, Integer, String, Array, Object } kind = Kind::Null;
  bool boolean = false;
  std::int64_t integer = 0;
  std::string string;
  std::vector<JsonValue> array;
  std::map<std::string, JsonValue> object;
};

inline void AppendUtf8(std::uint32_t codepoint, std::string* out) {
  if (codepoint <= 0x7f) out->push_back(static_cast<char>(codepoint));
  else if (codepoint <= 0x7ff) {
    out->push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
    out->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  } else if (codepoint <= 0xffff) {
    out->push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
    out->push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
    out->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  } else {
    out->push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
    out->push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
    out->push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
    out->push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
  }
}

inline bool DecodeUtf8(const std::string& text, std::size_t* cursor,
                       std::uint32_t* codepoint) {
  if (*cursor >= text.size()) return false;
  const auto byte = [&text](std::size_t i) {
    return static_cast<unsigned char>(text[i]);
  };
  const unsigned char first = byte((*cursor)++);
  if (first < 0x80) { *codepoint = first; return true; }
  unsigned need = 0;
  std::uint32_t value = 0;
  if ((first & 0xe0) == 0xc0) { need = 1; value = first & 0x1f; if (value < 2) return false; }
  else if ((first & 0xf0) == 0xe0) { need = 2; value = first & 0x0f; }
  else if ((first & 0xf8) == 0xf0) { need = 3; value = first & 0x07; }
  else return false;
  if (text.size() - *cursor < need) return false;
  for (unsigned i = 0; i < need; ++i) {
    const unsigned char next = byte((*cursor)++);
    if ((next & 0xc0) != 0x80) return false;
    value = (value << 6) | (next & 0x3f);
  }
  if ((need == 2 && value < 0x800) || (need == 3 && value < 0x10000) ||
      value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
  *codepoint = value;
  return true;
}

inline bool ValidUtf8(const std::string& text) {
  std::size_t cursor = 0;
  std::uint32_t codepoint = 0;
  while (cursor < text.size()) if (!DecodeUtf8(text, &cursor, &codepoint)) return false;
  return true;
}

class JsonParser {
 public:
  explicit JsonParser(const std::string& source) : source_(source) {}

  bool Parse(JsonValue* value, std::string* error, unsigned max_depth = 12,
             std::size_t max_bytes = 1024 * 1024) {
    error_ = error;
    max_depth_ = max_depth;
    if (source_.size() > max_bytes || !ValidUtf8(source_)) return Fail("invalid UTF-8 or payload size");
    if (source_.size() >= 3 && static_cast<unsigned char>(source_[0]) == 0xef &&
        static_cast<unsigned char>(source_[1]) == 0xbb &&
        static_cast<unsigned char>(source_[2]) == 0xbf) return Fail("UTF-8 BOM is not allowed");
    SkipSpace();
    if (!ParseValue(value, 0)) return false;
    SkipSpace();
    return cursor_ == source_.size() || Fail("trailing JSON data");
  }

 private:
  bool Fail(const char* reason) {
    if (error_ != nullptr) *error_ = reason;
    return false;
  }

  void SkipSpace() {
    while (cursor_ < source_.size() && (source_[cursor_] == ' ' || source_[cursor_] == '\t' ||
        source_[cursor_] == '\r' || source_[cursor_] == '\n')) ++cursor_;
  }

  bool ParseHex4(std::uint32_t* value) {
    if (source_.size() - cursor_ < 4) return false;
    std::uint32_t result = 0;
    for (unsigned i = 0; i < 4; ++i) {
      const char c = source_[cursor_++];
      result <<= 4;
      if (c >= '0' && c <= '9') result |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') result |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') result |= static_cast<unsigned>(c - 'A' + 10);
      else return false;
    }
    *value = result;
    return true;
  }

  bool ParseString(std::string* value) {
    if (cursor_ >= source_.size() || source_[cursor_++] != '"') return false;
    std::string output;
    while (cursor_ < source_.size()) {
      const unsigned char c = static_cast<unsigned char>(source_[cursor_++]);
      if (c == '"') { *value = std::move(output); return true; }
      if (c < 0x20) return false;
      if (c != '\\') { output.push_back(static_cast<char>(c)); continue; }
      if (cursor_ >= source_.size()) return false;
      const char escaped = source_[cursor_++];
      switch (escaped) {
        case '"': output.push_back('"'); break;
        case '\\': output.push_back('\\'); break;
        case '/': output.push_back('/'); break;
        case 'b': output.push_back('\b'); break;
        case 'f': output.push_back('\f'); break;
        case 'n': output.push_back('\n'); break;
        case 'r': output.push_back('\r'); break;
        case 't': output.push_back('\t'); break;
        case 'u': {
          std::uint32_t high = 0;
          if (!ParseHex4(&high)) return false;
          if (high >= 0xd800 && high <= 0xdbff) {
            if (source_.size() - cursor_ < 6 || source_[cursor_] != '\\' || source_[cursor_ + 1] != 'u') return false;
            cursor_ += 2;
            std::uint32_t low = 0;
            if (!ParseHex4(&low) || low < 0xdc00 || low > 0xdfff) return false;
            AppendUtf8(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00), &output);
          } else {
            if (high >= 0xdc00 && high <= 0xdfff) return false;
            AppendUtf8(high, &output);
          }
          break;
        }
        default: return false;
      }
      if (output.size() > 64 * 1024) return false;
    }
    return false;
  }

  bool ParseValue(JsonValue* value, unsigned depth) {
    if (depth > max_depth_ || ++nodes_ > 200000) return Fail("JSON nesting or node limit exceeded");
    SkipSpace();
    if (cursor_ >= source_.size()) return Fail("unexpected end of JSON");
    const char c = source_[cursor_];
    if (c == 'n' && source_.compare(cursor_, 4, "null") == 0) {
      cursor_ += 4; value->kind = JsonValue::Kind::Null; return true;
    }
    if (c == 't' && source_.compare(cursor_, 4, "true") == 0) {
      cursor_ += 4; value->kind = JsonValue::Kind::Boolean; value->boolean = true; return true;
    }
    if (c == 'f' && source_.compare(cursor_, 5, "false") == 0) {
      cursor_ += 5; value->kind = JsonValue::Kind::Boolean; value->boolean = false; return true;
    }
    if (c == '"') {
      value->kind = JsonValue::Kind::String;
      return ParseString(&value->string) || Fail("invalid JSON string");
    }
    if (c == '[') {
      value->kind = JsonValue::Kind::Array;
      ++cursor_; SkipSpace();
      if (cursor_ < source_.size() && source_[cursor_] == ']') { ++cursor_; return true; }
      while (cursor_ < source_.size()) {
        value->array.emplace_back();
        if (!ParseValue(&value->array.back(), depth + 1)) return false;
        SkipSpace();
        if (cursor_ >= source_.size()) return Fail("unterminated JSON array");
        if (source_[cursor_] == ']') { ++cursor_; return true; }
        if (source_[cursor_++] != ',') return Fail("invalid JSON array separator");
      }
      return Fail("unterminated JSON array");
    }
    if (c == '{') {
      value->kind = JsonValue::Kind::Object;
      ++cursor_; SkipSpace();
      if (cursor_ < source_.size() && source_[cursor_] == '}') { ++cursor_; return true; }
      while (cursor_ < source_.size()) {
        std::string key;
        if (!ParseString(&key)) return Fail("invalid JSON object key");
        SkipSpace();
        if (cursor_ >= source_.size() || source_[cursor_++] != ':') return Fail("missing JSON colon");
        JsonValue child;
        if (!ParseValue(&child, depth + 1)) return false;
        if (!value->object.emplace(std::move(key), std::move(child)).second)
          return Fail("duplicate JSON key");
        SkipSpace();
        if (cursor_ >= source_.size()) return Fail("unterminated JSON object");
        if (source_[cursor_] == '}') { ++cursor_; return true; }
        if (source_[cursor_++] != ',') return Fail("invalid JSON object separator");
        SkipSpace();
      }
      return Fail("unterminated JSON object");
    }
    return ParseInteger(value);
  }

  bool ParseInteger(JsonValue* value) {
    const std::size_t start = cursor_;
    if (source_[cursor_] == '-') ++cursor_;
    if (cursor_ >= source_.size()) return Fail("invalid JSON integer");
    if (source_[cursor_] == '0') {
      ++cursor_;
      if (cursor_ < source_.size() && source_[cursor_] >= '0' && source_[cursor_] <= '9')
        return Fail("leading zero in JSON integer");
    } else {
      if (source_[cursor_] < '1' || source_[cursor_] > '9') return Fail("invalid JSON integer");
      while (cursor_ < source_.size() && source_[cursor_] >= '0' && source_[cursor_] <= '9') ++cursor_;
    }
    if (cursor_ < source_.size() && (source_[cursor_] == '.' || source_[cursor_] == 'e' || source_[cursor_] == 'E'))
      return Fail("non-integer JSON numbers are forbidden");
    const char* begin = source_.data() + start;
    const char* end = source_.data() + cursor_;
    const auto parsed = std::from_chars(begin, end, value->integer);
    if (parsed.ec != std::errc{} || parsed.ptr != end) return Fail("JSON integer overflow");
    value->kind = JsonValue::Kind::Integer;
    return true;
  }

  const std::string& source_;
  std::string* error_ = nullptr;
  std::size_t cursor_ = 0;
  std::size_t nodes_ = 0;
  unsigned max_depth_ = 12;
};

inline const JsonValue* JsonField(const JsonValue& object, const char* name) {
  if (object.kind != JsonValue::Kind::Object) return nullptr;
  const auto found = object.object.find(name);
  return found == object.object.end() ? nullptr : &found->second;
}

inline bool JsonExactFields(const JsonValue& object,
                            std::initializer_list<const char*> names) {
  if (object.kind != JsonValue::Kind::Object || object.object.size() != names.size()) return false;
  for (const char* name : names) if (object.object.find(name) == object.object.end()) return false;
  return true;
}

inline bool JsonString(const JsonValue* value, std::string* output) {
  if (value == nullptr || value->kind != JsonValue::Kind::String) return false;
  *output = value->string;
  return true;
}

inline bool JsonInteger(const JsonValue* value, std::int64_t* output) {
  if (value == nullptr || value->kind != JsonValue::Kind::Integer) return false;
  *output = value->integer;
  return true;
}

inline bool ValidCatalogText(const std::string& text, std::size_t min_chars,
                             std::size_t max_chars) {
  std::size_t cursor = 0, count = 0;
  std::uint32_t cp = 0;
  while (cursor < text.size()) {
    if (!DecodeUtf8(text, &cursor, &cp)) return false;
    if (cp == 0 || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) ||
        (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return false;
    ++count;
  }
  return count >= min_chars && count <= max_chars;
}

inline bool ValidCatalogId(const std::string& id) {
  if (id.empty() || id.size() > 64) return false;
  for (const unsigned char c : id)
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return false;
  return true;
}

struct OwnedCatalogItem {
  std::string id, language, category, tone, text, festival_id, regions;
  CatalogItem row{};
};

struct OwnedCalendar {
  std::string id, language, type, dates;
  Calendar row{};
};

struct ValidatedCatalog {
  std::uint32_t content_version = 0;
  std::string calendar_version;
  int calendar_year_start = 0;
  int calendar_year_end = 0;
  std::vector<std::unique_ptr<OwnedCatalogItem>> owned_items;
  std::vector<CatalogItem> items;
  std::vector<std::unique_ptr<OwnedCalendar>> owned_calendars;
  std::vector<Calendar> calendars;

  CatalogView view() const {
    return {items.data(), items.size(), calendars.data(), calendars.size(), content_version};
  }
};

struct CatalogEnvelope {
  std::string key_id;
  std::string payload;
  std::vector<std::uint8_t> signature;
};

inline bool DecodeBase64(const std::string& encoded, std::vector<std::uint8_t>* output) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (output == nullptr || encoded.empty() || encoded.size() % 4 != 0 ||
      encoded.size() > 2 * 1024 * 1024) return false;
  std::vector<std::uint8_t> decoded;
  decoded.reserve(encoded.size() / 4 * 3);
  for (std::size_t i = 0; i < encoded.size(); i += 4) {
    std::uint32_t accumulator = 0;
    unsigned padding = 0;
    for (unsigned j = 0; j < 4; ++j) {
      const char c = encoded[i + j];
      if (c == '=') {
        if (i + 4 != encoded.size() || j < 2) return false;
        ++padding;
        accumulator <<= 6;
      } else {
        if (padding != 0) return false;
        const char* found = std::strchr(alphabet, c);
        if (found == nullptr) return false;
        accumulator = (accumulator << 6) | static_cast<std::uint32_t>(found - alphabet);
      }
    }
    if (padding > 2 || (padding == 1 && (accumulator & 0xff) != 0) ||
        (padding == 2 && (accumulator & 0xffff) != 0)) return false;
    decoded.push_back(static_cast<std::uint8_t>((accumulator >> 16) & 0xff));
    if (padding < 2) decoded.push_back(static_cast<std::uint8_t>((accumulator >> 8) & 0xff));
    if (padding == 0) decoded.push_back(static_cast<std::uint8_t>(accumulator & 0xff));
  }
  *output = std::move(decoded);
  return true;
}

inline bool SafeKeyId(const std::string& key_id) {
  if (key_id.empty() || key_id.size() > 64) return false;
  for (const unsigned char c : key_id)
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) return false;
  return true;
}

inline bool ParseCatalogEnvelope(const std::string& bytes, CatalogEnvelope* envelope,
                                 std::string* error) {
  auto fail = [error](const char* reason) { if (error) *error = reason; return false; };
  if (bytes.empty() || bytes.size() > 2 * 1024 * 1024) return fail("catalog envelope size is invalid");
  JsonValue outer;
  if (!JsonParser(bytes).Parse(&outer, error, 4, 2 * 1024 * 1024)) return false;
  if (!JsonExactFields(outer, {"format", "key_id", "payload_b64", "signature_b64"}))
    return fail("catalog envelope fields are invalid");
  std::string format, key_id, payload_b64, signature_b64;
  if (!JsonString(JsonField(outer, "format"), &format) || format != "nmgtext-envelope-v1" ||
      !JsonString(JsonField(outer, "key_id"), &key_id) || !SafeKeyId(key_id) ||
      !JsonString(JsonField(outer, "payload_b64"), &payload_b64) ||
      !JsonString(JsonField(outer, "signature_b64"), &signature_b64))
    return fail("unsupported envelope or key identifier");
  CatalogEnvelope candidate;
  candidate.key_id = std::move(key_id);
  std::vector<std::uint8_t> payload;
  if (!DecodeBase64(payload_b64, &payload) || payload.empty() || payload.size() > 1024 * 1024)
    return fail("invalid payload encoding or size");
  if (!DecodeBase64(signature_b64, &candidate.signature) || candidate.signature.size() != 64)
    return fail("signature must be 64 raw bytes");
  candidate.payload.assign(reinterpret_cast<const char*>(payload.data()), payload.size());
  if (!ValidUtf8(candidate.payload)) return fail("catalog payload is not UTF-8");
  if (envelope == nullptr) return fail("missing envelope output");
  *envelope = std::move(candidate);
  if (error) error->clear();
  return true;
}

inline std::vector<std::uint8_t> CatalogSignatureMessage(const std::string& payload) {
  static constexpr char domain[] = "NMG-TEXT-v1";
  std::vector<std::uint8_t> message;
  message.reserve(sizeof(domain) + payload.size());
  message.insert(message.end(), domain, domain + sizeof(domain));  // includes the required NUL
  message.insert(message.end(), payload.begin(), payload.end());
  return message;
}

inline bool ValidateCatalogPayload(const std::string& payload,
                                   std::shared_ptr<ValidatedCatalog>* output,
                                   std::string* error) {
  auto fail = [error](const char* reason) { if (error) *error = reason; return false; };
  JsonValue root;
  if (!JsonParser(payload).Parse(&root, error, 12)) return false;
  if (!JsonExactFields(root, {"schema_version", "catalog_id", "content_version",
      "calendar_version", "calendar_year_start", "calendar_year_end", "languages",
      "items", "calendars"})) return fail("catalog root fields are invalid");
  std::int64_t number = 0;
  if (!JsonInteger(JsonField(root, "schema_version"), &number) || number != 2)
    return fail("unsupported catalog schema");
  std::string text;
  if (!JsonString(JsonField(root, "catalog_id"), &text) || text != "official.multilingual")
    return fail("unknown catalog identifier");
  auto catalog = std::make_shared<ValidatedCatalog>();
  if (!JsonInteger(JsonField(root, "content_version"), &number) || number < 1 || number > UINT32_MAX)
    return fail("invalid catalog version");
  catalog->content_version = static_cast<std::uint32_t>(number);
  if (!JsonString(JsonField(root, "calendar_version"), &catalog->calendar_version) ||
      catalog->calendar_version.empty() || catalog->calendar_version.size() > 64)
    return fail("invalid calendar version");
  if (!JsonInteger(JsonField(root, "calendar_year_start"), &number) || number < 1900 || number > 9999)
    return fail("invalid calendar start year");
  catalog->calendar_year_start = static_cast<int>(number);
  if (!JsonInteger(JsonField(root, "calendar_year_end"), &number) ||
      number < catalog->calendar_year_start || number > 9999 ||
      number - catalog->calendar_year_start > 100)
    return fail("invalid calendar end year");
  catalog->calendar_year_end = static_cast<int>(number);

  const JsonValue* languages = JsonField(root, "languages");
  if (languages == nullptr || languages->kind != JsonValue::Kind::Array || languages->array.size() != 2 ||
      languages->array[0].kind != JsonValue::Kind::String || languages->array[1].kind != JsonValue::Kind::String ||
      languages->array[0].string != "zh-CN" || languages->array[1].string != "en")
    return fail("catalog must include the supported Chinese and English languages");

  const JsonValue* calendar_values = JsonField(root, "calendars");
  if (calendar_values == nullptr || calendar_values->kind != JsonValue::Kind::Array ||
      calendar_values->array.empty() || calendar_values->array.size() > 128)
    return fail("invalid calendar list");
  std::set<std::string> calendar_ids;
  for (const JsonValue& value : calendar_values->array) {
    std::string id, language, type;
    const JsonValue* type_value = JsonField(value, "type");
    if (!JsonString(JsonField(value, "id"), &id) || !JsonString(JsonField(value, "language"), &language) ||
        !JsonString(type_value, &type) || id.empty() || id.size() > 64 ||
        (language != "zh-CN" && language != "en") || !calendar_ids.insert(id).second)
      return fail("invalid or duplicate calendar");
    auto owned = std::make_unique<OwnedCalendar>();
    owned->id = id; owned->language = language; owned->type = type;
    int month = 0, day = 0;
    if (type == "annual_gregorian") {
      if (!JsonExactFields(value, {"id", "language", "type", "month", "day"}))
        return fail("invalid annual calendar fields");
      std::int64_t m = 0, d = 0;
      if (!JsonInteger(JsonField(value, "month"), &m) || !JsonInteger(JsonField(value, "day"), &d) ||
          m < 1 || m > 12 || d < 1 || d > 31) return fail("invalid annual calendar date");
      month = static_cast<int>(m); day = static_cast<int>(d);
      Calendar candidate{id.c_str(), language.c_str(), type.c_str(), month, day, ""};
      std::int64_t anchor = 0;
      if (!CalendarDate(candidate, catalog->calendar_year_start, &anchor))
        return fail("invalid annual Gregorian date");
    } else if (type == "date_table") {
      if (!JsonExactFields(value, {"id", "language", "type", "dates"}))
        return fail("invalid date table fields");
      const JsonValue* dates = JsonField(value, "dates");
      if (dates == nullptr || dates->kind != JsonValue::Kind::Object ||
          dates->object.size() != static_cast<std::size_t>(catalog->calendar_year_end -
              catalog->calendar_year_start + 1)) return fail("date table year coverage is incomplete");
      for (int year = catalog->calendar_year_start; year <= catalog->calendar_year_end; ++year) {
        const std::string key = std::to_string(year);
        const JsonValue* date_value = JsonField(*dates, key.c_str());
        std::string iso;
        int parsed_year = 0, parsed_month = 0, parsed_day = 0;
        if (!JsonString(date_value, &iso) || !ParseIsoDate(iso.c_str(), &parsed_year,
                &parsed_month, &parsed_day) || parsed_year != year)
          return fail("date table contains an invalid year or date");
        if (!owned->dates.empty()) owned->dates.push_back(';');
        owned->dates += key + "=" + iso;
      }
    } else return fail("unsupported calendar type");
    owned->row = {owned->id.c_str(), owned->language.c_str(), owned->type.c_str(),
                  month, day, owned->dates.c_str()};
    catalog->calendars.push_back(owned->row);
    catalog->owned_calendars.push_back(std::move(owned));
  }

  const JsonValue* items = JsonField(root, "items");
  if (items == nullptr || items->kind != JsonValue::Kind::Array || items->array.empty() ||
      items->array.size() > 3000) return fail("invalid item list size");
  std::set<std::string> item_ids;
  std::size_t language_counts[2] = {};
  for (const JsonValue& value : items->array) {
    if (!JsonExactFields(value, {"id", "language", "category", "tone", "text", "triggers",
        "requires_overtime", "local_time", "festival_id", "before_days", "after_days", "regions"}))
      return fail("item fields are invalid");
    auto owned = std::make_unique<OwnedCatalogItem>();
    if (!JsonString(JsonField(value, "id"), &owned->id) || !JsonString(JsonField(value, "language"), &owned->language) ||
        !JsonString(JsonField(value, "category"), &owned->category) || !JsonString(JsonField(value, "tone"), &owned->tone) ||
        !JsonString(JsonField(value, "text"), &owned->text) || !ValidCatalogId(owned->id) ||
        !item_ids.insert(owned->id).second) return fail("invalid or duplicate item ID/text fields");
    if (owned->language == "zh-CN") ++language_counts[0];
    else if (owned->language == "en") ++language_counts[1];
    else return fail("unsupported item language");
    const std::size_t text_limit = owned->language == "zh-CN" ? 80 : 160;
    if (!ValidCatalogText(owned->text, 4, text_limit)) return fail("item text is invalid or outside length limits");
    if ((owned->category != "ordinary" && owned->category != "festival") ||
        (owned->tone != "humor" && owned->tone != "warm")) return fail("invalid item category or tone");
    const JsonValue* overtime = JsonField(value, "requires_overtime");
    if (overtime == nullptr || overtime->kind != JsonValue::Kind::Boolean) return fail("invalid overtime condition");
    std::int64_t before = 0, after = 0;
    if (!JsonInteger(JsonField(value, "before_days"), &before) ||
        !JsonInteger(JsonField(value, "after_days"), &after) || before < 0 || before > 7 || after < 0 || after > 7)
      return fail("invalid festival date offsets");
    const JsonValue* triggers = JsonField(value, "triggers");
    unsigned trigger_mask = 0;
    if (triggers == nullptr || triggers->kind != JsonValue::Kind::Array ||
        triggers->array.empty() || triggers->array.size() > 2) return fail("invalid trigger list");
    for (const JsonValue& trigger : triggers->array) {
      if (trigger.kind != JsonValue::Kind::String) return fail("invalid trigger value");
      if (trigger.string == "long_busy") {
        if ((trigger_mask & 1) != 0) return fail("duplicate trigger");
        trigger_mask |= 1;
      } else if (trigger.string == "high_intensity") {
        if ((trigger_mask & 2) != 0) return fail("duplicate trigger");
        trigger_mask |= 2;
      } else return fail("unknown trigger");
    }
    const JsonValue* time = JsonField(value, "local_time");
    if (time == nullptr || !JsonExactFields(*time, {"start_minute", "end_minute"})) return fail("invalid local time");
    std::int64_t start = 0, end = 0;
    if (!JsonInteger(JsonField(*time, "start_minute"), &start) ||
        !JsonInteger(JsonField(*time, "end_minute"), &end) || start < 0 || start >= end || end > 1440)
      return fail("invalid local time range");
    const JsonValue* festival = JsonField(value, "festival_id");
    if (owned->category == "ordinary") {
      if (festival == nullptr || festival->kind != JsonValue::Kind::Null || before != 0 || after != 0)
        return fail("ordinary items cannot carry festival conditions");
    } else {
      if (!JsonString(festival, &owned->festival_id) || !calendar_ids.count(owned->festival_id))
        return fail("festival item points to a missing calendar");
      const auto calendar = std::find_if(catalog->calendars.begin(), catalog->calendars.end(),
          [&owned](const Calendar& entry) { return std::strcmp(entry.id, owned->festival_id.c_str()) == 0; });
      if (calendar == catalog->calendars.end() || std::strcmp(calendar->language, owned->language.c_str()) != 0)
        return fail("festival item language does not match calendar language");
    }
    const JsonValue* regions = JsonField(value, "regions");
    if (regions == nullptr || regions->kind != JsonValue::Kind::Array || regions->array.empty())
      return fail("invalid region list");
    std::set<std::string> region_set;
    for (const JsonValue& region : regions->array) {
      if (region.kind != JsonValue::Kind::String || !region_set.insert(region.string).second)
        return fail("invalid or duplicate region");
      if (region.string != "*" && (region.string.size() != 2 || region.string[0] < 'A' ||
          region.string[0] > 'Z' || region.string[1] < 'A' || region.string[1] > 'Z'))
        return fail("region codes must be uppercase ISO-2 strings");
      if (!owned->regions.empty()) owned->regions.push_back('|');
      owned->regions += region.string;
    }
    if (region_set.count("*") && region_set.size() != 1) return fail("region wildcard cannot be combined");
    owned->row = {owned->id.c_str(), owned->language.c_str(), owned->category.c_str(),
        owned->tone.c_str(), owned->text.c_str(), trigger_mask, overtime->boolean,
        static_cast<int>(start), static_cast<int>(end), owned->festival_id.c_str(),
        static_cast<int>(before), static_cast<int>(after), owned->regions.c_str()};
    catalog->items.push_back(owned->row);
    catalog->owned_items.push_back(std::move(owned));
  }
  if (language_counts[0] == 0 || language_counts[1] == 0) return fail("catalog is missing a supported language");
  if (output == nullptr) return fail("missing catalog output");
  *output = std::move(catalog);
  if (error) error->clear();
  return true;
}

}  // namespace niuma::reminder
