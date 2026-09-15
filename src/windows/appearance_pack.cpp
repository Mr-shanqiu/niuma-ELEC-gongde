#include "appearance_pack.h"

#include "miniz.h"

#include <shlobj.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <map>
#include <set>
#include <utility>

namespace niuma {
namespace {

constexpr ULONGLONG kMaximumPackBytes = 50ULL * 1024ULL * 1024ULL;
constexpr size_t kMaximumManifestBytes = 64ULL * 1024ULL;
constexpr size_t kMaximumPngBytes = 32ULL * 1024ULL * 1024ULL;
constexpr size_t kMaximumFiles = 8;
constexpr size_t kMaximumLayers = 6;
constexpr size_t kMaximumKeyframes = 8;

struct JsonValue {
  enum class Kind { Null, Boolean, Number, String, Array, Object };
  Kind kind = Kind::Null;
  bool boolean = false;
  double number = 0.0;
  std::string string;
  std::vector<JsonValue> array;
  std::map<std::string, JsonValue> object;
};

void SetError(std::wstring* error, const wchar_t* text) {
  if (error != nullptr) *error = text;
}

std::wstring Utf8ToWide(const std::string& text) {
  if (text.empty()) return {};
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
      nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), result.data(), length) !=
      length) {
    return {};
  }
  return result;
}

std::string WideToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int length = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
      nullptr, 0, nullptr, nullptr);
  if (length <= 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                          static_cast<int>(text.size()), result.data(), length,
                          nullptr, nullptr) != length) {
    return {};
  }
  return result;
}

class JsonParser {
 public:
  explicit JsonParser(const std::string& input) : input_(input) {}

  bool Parse(JsonValue* output) {
    SkipSpace();
    if (!ParseValue(output)) return false;
    SkipSpace();
    return position_ == input_.size();
  }

 private:
  bool ParseValue(JsonValue* output) {
    if (position_ >= input_.size()) return false;
    const char current = input_[position_];
    if (current == '{') return ParseObject(output);
    if (current == '[') return ParseArray(output);
    if (current == '"') {
      output->kind = JsonValue::Kind::String;
      return ParseString(&output->string);
    }
    if (current == '-' || (current >= '0' && current <= '9')) {
      return ParseNumber(output);
    }
    if (ConsumeLiteral("true")) {
      output->kind = JsonValue::Kind::Boolean;
      output->boolean = true;
      return true;
    }
    if (ConsumeLiteral("false")) {
      output->kind = JsonValue::Kind::Boolean;
      output->boolean = false;
      return true;
    }
    if (ConsumeLiteral("null")) {
      output->kind = JsonValue::Kind::Null;
      return true;
    }
    return false;
  }

  bool ParseObject(JsonValue* output) {
    ++position_;
    output->kind = JsonValue::Kind::Object;
    SkipSpace();
    if (Consume('}')) return true;
    while (position_ < input_.size()) {
      std::string key;
      if (!ParseString(&key) || output->object.count(key) != 0) return false;
      SkipSpace();
      if (!Consume(':')) return false;
      SkipSpace();
      JsonValue value;
      if (!ParseValue(&value)) return false;
      output->object.emplace(std::move(key), std::move(value));
      SkipSpace();
      if (Consume('}')) return true;
      if (!Consume(',')) return false;
      SkipSpace();
    }
    return false;
  }

  bool ParseArray(JsonValue* output) {
    ++position_;
    output->kind = JsonValue::Kind::Array;
    SkipSpace();
    if (Consume(']')) return true;
    while (position_ < input_.size()) {
      JsonValue value;
      if (!ParseValue(&value)) return false;
      output->array.push_back(std::move(value));
      SkipSpace();
      if (Consume(']')) return true;
      if (!Consume(',')) return false;
      SkipSpace();
    }
    return false;
  }

  static void AppendUtf8(unsigned int codePoint, std::string* output) {
    if (codePoint <= 0x7F) {
      output->push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7FF) {
      output->push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
      output->push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else {
      output->push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
      output->push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
      output->push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    }
  }

  bool ParseString(std::string* output) {
    if (!Consume('"')) return false;
    output->clear();
    while (position_ < input_.size()) {
      const unsigned char current =
          static_cast<unsigned char>(input_[position_++]);
      if (current == '"') return true;
      if (current < 0x20) return false;
      if (current != '\\') {
        output->push_back(static_cast<char>(current));
        continue;
      }
      if (position_ >= input_.size()) return false;
      const char escape = input_[position_++];
      switch (escape) {
        case '"': output->push_back('"'); break;
        case '\\': output->push_back('\\'); break;
        case '/': output->push_back('/'); break;
        case 'b': output->push_back('\b'); break;
        case 'f': output->push_back('\f'); break;
        case 'n': output->push_back('\n'); break;
        case 'r': output->push_back('\r'); break;
        case 't': output->push_back('\t'); break;
        case 'u': {
          if (position_ + 4 > input_.size()) return false;
          unsigned int codePoint = 0;
          for (int i = 0; i < 4; ++i) {
            const char digit = input_[position_++];
            codePoint <<= 4;
            if (digit >= '0' && digit <= '9') codePoint += digit - '0';
            else if (digit >= 'a' && digit <= 'f') codePoint += digit - 'a' + 10;
            else if (digit >= 'A' && digit <= 'F') codePoint += digit - 'A' + 10;
            else return false;
          }
          if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return false;
          AppendUtf8(codePoint, output);
          break;
        }
        default: return false;
      }
    }
    return false;
  }

  bool ParseNumber(JsonValue* output) {
    const size_t start = position_;
    if (input_[position_] == '-') ++position_;
    if (position_ >= input_.size()) return false;
    if (input_[position_] == '0') {
      ++position_;
    } else {
      if (!std::isdigit(static_cast<unsigned char>(input_[position_]))) return false;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) {
        ++position_;
      }
    }
    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      if (position_ >= input_.size() ||
          !std::isdigit(static_cast<unsigned char>(input_[position_]))) return false;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
    }
    if (position_ < input_.size() &&
        (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() &&
          (input_[position_] == '+' || input_[position_] == '-')) ++position_;
      if (position_ >= input_.size() ||
          !std::isdigit(static_cast<unsigned char>(input_[position_]))) return false;
      while (position_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
    }
    const std::string token = input_.substr(start, position_ - start);
    char* end = nullptr;
    output->number = std::strtod(token.c_str(), &end);
    output->kind = JsonValue::Kind::Number;
    return end != token.c_str() && *end == '\0' && std::isfinite(output->number);
  }

  bool Consume(char expected) {
    if (position_ < input_.size() && input_[position_] == expected) {
      ++position_;
      return true;
    }
    return false;
  }

  bool ConsumeLiteral(const char* literal) {
    const size_t length = std::strlen(literal);
    if (input_.compare(position_, length, literal) != 0) return false;
    position_ += length;
    return true;
  }

  void SkipSpace() {
    while (position_ < input_.size() &&
           (input_[position_] == ' ' || input_[position_] == '\t' ||
            input_[position_] == '\r' || input_[position_] == '\n')) ++position_;
  }

  const std::string& input_;
  size_t position_ = 0;
};

const JsonValue* Member(const JsonValue& object, const char* key) {
  const auto found = object.object.find(key);
  return found == object.object.end() ? nullptr : &found->second;
}

bool HasExactKeys(const JsonValue& value,
                  std::initializer_list<const char*> keys) {
  if (value.kind != JsonValue::Kind::Object || value.object.size() != keys.size())
    return false;
  for (const char* key : keys) {
    if (value.object.count(key) != 1) return false;
  }
  return true;
}

bool NumberInRange(const JsonValue* value, double minimum, double maximum,
                   double* output) {
  if (value == nullptr || value->kind != JsonValue::Kind::Number ||
      value->number < minimum || value->number > maximum) return false;
  *output = value->number;
  return true;
}

bool StringValue(const JsonValue* value, size_t maximum, std::string* output) {
  if (value == nullptr || value->kind != JsonValue::Kind::String ||
      value->string.empty() || value->string.size() > maximum) return false;
  *output = value->string;
  return true;
}

bool IsSafeId(const std::string& id) {
  if (id.empty() || id.size() > 96 || id.front() == '.' || id.back() == '.')
    return false;
  for (unsigned char character : id) {
    if (!(std::islower(character) || std::isdigit(character) ||
          character == '.' || character == '-')) return false;
  }
  return true;
}

bool IsSafeRootPng(const std::string& name) {
  if (name.empty() || name.size() > 128 || name.front() == '.' ||
      name.find('/') != std::string::npos ||
      name.find('\\') != std::string::npos) return false;
  for (unsigned char character : name) {
    if (!(std::isalnum(character) || character == '.' || character == '-' ||
          character == '_')) return false;
  }
  if (name.size() < 5) return false;
  std::string extension = name.substr(name.size() - 4);
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return extension == ".png";
}

bool LoadImage(const void* bytes, size_t size, PackImage* output) {
  if (bytes == nullptr || size == 0 || size > kMaximumPngBytes) return false;
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, size);
  if (memory == nullptr) return false;
  void* destination = GlobalLock(memory);
  if (destination == nullptr) {
    GlobalFree(memory);
    return false;
  }
  CopyMemory(destination, bytes, size);
  GlobalUnlock(memory);
  IStream* stream = nullptr;
  if (FAILED(CreateStreamOnHGlobal(memory, TRUE, &stream))) {
    GlobalFree(memory);
    return false;
  }
  std::unique_ptr<Gdiplus::Image> image(Gdiplus::Image::FromStream(stream));
  if (!image || image->GetLastStatus() != Gdiplus::Ok ||
      image->GetWidth() == 0 || image->GetHeight() == 0 ||
      image->GetWidth() > 2048 || image->GetHeight() > 2048) {
    image.reset();
    stream->Release();
    return false;
  }
  output->stream = stream;
  output->image = std::move(image);
  return true;
}

bool ReadArchiveEntry(mz_zip_archive* archive, const std::string& name,
                      size_t maximum, std::vector<unsigned char>* output) {
  const int index = mz_zip_reader_locate_file(
      archive, name.c_str(), nullptr, MZ_ZIP_FLAG_CASE_SENSITIVE);
  if (index < 0) return false;
  mz_zip_archive_file_stat stat = {};
  if (!mz_zip_reader_file_stat(archive, static_cast<mz_uint>(index), &stat) ||
      stat.m_uncomp_size == 0 || stat.m_uncomp_size > maximum) return false;
  size_t size = 0;
  void* bytes = mz_zip_reader_extract_to_heap(
      archive, static_cast<mz_uint>(index), &size, 0);
  if (bytes == nullptr || size != stat.m_uncomp_size) {
    if (bytes != nullptr) mz_free(bytes);
    return false;
  }
  const auto* begin = static_cast<const unsigned char*>(bytes);
  output->assign(begin, begin + size);
  mz_free(bytes);
  return true;
}

bool ParseManifest(const std::string& text, AppearancePack* pack,
                   std::string* previewName, std::wstring* error) {
  JsonValue root;
  JsonParser parser(text);
  if (!parser.Parse(&root) ||
      !HasExactKeys(root, {"schema_version", "id", "version", "name_zh",
                           "name_en", "author", "publisher", "review_id",
                           "canvas_width", "canvas_height", "preview",
                           "plus_y", "layers"})) {
    SetError(error, L"manifest.json 格式不正确或包含未知字段。");
    return false;
  }
  double schema = 0, canvasWidth = 0, canvasHeight = 0, plusY = 0;
  std::string nameZh, nameEn, author, publisher;
  if (!NumberInRange(Member(root, "schema_version"), 1, 1, &schema) ||
      !StringValue(Member(root, "id"), 96, &pack->id) ||
      !IsSafeId(pack->id) ||
      !StringValue(Member(root, "version"), 32, &pack->version) ||
      !StringValue(Member(root, "name_zh"), 128, &nameZh) ||
      !StringValue(Member(root, "name_en"), 128, &nameEn) ||
      !StringValue(Member(root, "author"), 128, &author) ||
      !StringValue(Member(root, "publisher"), 128, &publisher) ||
      !StringValue(Member(root, "review_id"), 128, &pack->reviewId) ||
      !StringValue(Member(root, "preview"), 128, previewName) ||
      !IsSafeRootPng(*previewName) ||
      !NumberInRange(Member(root, "canvas_width"), 240, 240, &canvasWidth) ||
      !NumberInRange(Member(root, "canvas_height"), 250, 250, &canvasHeight) ||
      !NumberInRange(Member(root, "plus_y"), 174, 174, &plusY)) {
    SetError(error, L"形象包元数据不符合 1.0 规范。");
    return false;
  }
  pack->nameZh = Utf8ToWide(nameZh);
  pack->nameEn = Utf8ToWide(nameEn);
  pack->author = Utf8ToWide(author);
  pack->publisher = Utf8ToWide(publisher);
  pack->plusY = static_cast<int>(plusY);
  if (pack->nameZh.empty() || pack->nameEn.empty() || pack->author.empty() ||
      pack->publisher.empty()) {
    SetError(error, L"形象包文字必须是有效 UTF-8。");
    return false;
  }

  const JsonValue* layers = Member(root, "layers");
  if (layers == nullptr || layers->kind != JsonValue::Kind::Array ||
      layers->array.empty() || layers->array.size() > kMaximumLayers) {
    SetError(error, L"形象包必须包含 1 至 6 个图层。");
    return false;
  }
  for (const JsonValue& layerValue : layers->array) {
    if (!HasExactKeys(layerValue, {"image", "frame", "anchor", "keyframes"})) {
      SetError(error, L"图层字段不符合规范。");
      return false;
    }
    PackLayer layer;
    if (!StringValue(Member(layerValue, "image"), 128, &layer.imageName) ||
        !IsSafeRootPng(layer.imageName)) {
      SetError(error, L"图层图片名称不合法。");
      return false;
    }
    const JsonValue* frame = Member(layerValue, "frame");
    const JsonValue* anchor = Member(layerValue, "anchor");
    if (frame == nullptr || frame->kind != JsonValue::Kind::Array ||
        frame->array.size() != 4 || anchor == nullptr ||
        anchor->kind != JsonValue::Kind::Array || anchor->array.size() != 2) {
      SetError(error, L"图层位置或锚点格式不正确。");
      return false;
    }
    double values[6] = {};
    for (size_t index = 0; index < 4; ++index) {
      if (!NumberInRange(&frame->array[index], -480, 480, &values[index])) {
        SetError(error, L"图层位置超出允许范围。");
        return false;
      }
    }
    if (!NumberInRange(&anchor->array[0], 0, 1, &values[4]) ||
        !NumberInRange(&anchor->array[1], 0, 1, &values[5]) ||
        values[2] <= 0 || values[3] <= 0 || values[2] > 480 ||
        values[3] > 480 || values[1] < 0 || values[1] + values[3] > 170) {
      SetError(error, L"图层必须完全位于形象安全区内。");
      return false;
    }
    layer.x = static_cast<float>(values[0]);
    layer.y = static_cast<float>(values[1]);
    layer.width = static_cast<float>(values[2]);
    layer.height = static_cast<float>(values[3]);
    layer.anchorX = static_cast<float>(values[4]);
    layer.anchorY = static_cast<float>(values[5]);

    const JsonValue* keyframes = Member(layerValue, "keyframes");
    if (keyframes == nullptr || keyframes->kind != JsonValue::Kind::Array ||
        keyframes->array.empty() || keyframes->array.size() > kMaximumKeyframes) {
      SetError(error, L"每个图层必须包含 1 至 8 个关键帧。");
      return false;
    }
    float previousT = -1.0f;
    for (const JsonValue& keyframeValue : keyframes->array) {
      if (!HasExactKeys(keyframeValue,
                        {"t", "x", "y", "rotation", "scale", "alpha"})) {
        SetError(error, L"关键帧字段不符合规范。");
        return false;
      }
      double key[6] = {};
      if (!NumberInRange(Member(keyframeValue, "t"), 0, 1, &key[0]) ||
          !NumberInRange(Member(keyframeValue, "x"), -480, 480, &key[1]) ||
          !NumberInRange(Member(keyframeValue, "y"), -480, 480, &key[2]) ||
          !NumberInRange(Member(keyframeValue, "rotation"), -360, 360, &key[3]) ||
          !NumberInRange(Member(keyframeValue, "scale"), 0.1, 4, &key[4]) ||
          !NumberInRange(Member(keyframeValue, "alpha"), 0, 1, &key[5]) ||
          key[0] <= previousT) {
        SetError(error, L"关键帧数值不合法或时间未严格递增。");
        return false;
      }
      PackKeyframe keyframe;
      keyframe.t = static_cast<float>(key[0]);
      keyframe.x = static_cast<float>(key[1]);
      keyframe.y = static_cast<float>(key[2]);
      keyframe.rotation = static_cast<float>(key[3]);
      keyframe.scale = static_cast<float>(key[4]);
      keyframe.alpha = static_cast<float>(key[5]);
      layer.keyframes.push_back(keyframe);
      previousT = keyframe.t;
    }
    if (layer.keyframes.front().t != 0.0f) {
      SetError(error, L"每个图层的第一个关键帧必须从 t=0 开始。");
      return false;
    }
    pack->layers.push_back(std::move(layer));
  }
  return true;
}

bool LoadAppearancePackFile(const std::wstring& path,
                            std::unique_ptr<AppearancePack>* output,
                            std::wstring* error) {
  WIN32_FILE_ATTRIBUTE_DATA attributes = {};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) ||
      (attributes.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                                      FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    SetError(error, L"形象包文件无效。");
    return false;
  }
  const ULONGLONG size =
      (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32) |
      attributes.nFileSizeLow;
  if (size == 0 || size > kMaximumPackBytes) {
    SetError(error, L"形象包不能超过 50MB。");
    return false;
  }
  const std::string utf8Path = WideToUtf8(path);
  if (utf8Path.empty()) {
    SetError(error, L"形象包路径无效。");
    return false;
  }
  mz_zip_archive archive = {};
  if (!mz_zip_reader_init_file(&archive, utf8Path.c_str(), 0)) {
    SetError(error, L"形象包不是有效 ZIP 文件。");
    return false;
  }
  struct ArchiveGuard {
    mz_zip_archive* archive;
    ~ArchiveGuard() { mz_zip_reader_end(archive); }
  } guard{&archive};
  if (archive.m_total_files == 0 || archive.m_total_files > kMaximumFiles ||
      !mz_zip_validate_archive(&archive, 0)) {
    SetError(error, L"形象包文件数量或压缩数据不合法。");
    return false;
  }
  std::set<std::string> archiveNames;
  mz_uint64 totalUncompressed = 0;
  for (mz_uint index = 0; index < archive.m_total_files; ++index) {
    mz_zip_archive_file_stat stat = {};
    if (!mz_zip_reader_file_stat(&archive, index, &stat) || stat.m_is_directory) {
      SetError(error, L"形象包不允许目录。");
      return false;
    }
    const std::string name(stat.m_filename);
    const mz_uint32 unixMode = stat.m_external_attr >> 16;
    if (name.empty() || name.front() == '.' ||
        name.find('/') != std::string::npos ||
        name.find('\\') != std::string::npos ||
        (unixMode & 0170000U) == 0120000U ||
        !archiveNames.insert(name).second) {
      SetError(error, L"形象包不允许隐藏文件、子目录或符号链接。");
      return false;
    }
    totalUncompressed += stat.m_uncomp_size;
    if (totalUncompressed > kMaximumPackBytes) {
      SetError(error, L"形象包解压数据超过 50MB。");
      return false;
    }
  }
  std::vector<unsigned char> manifestBytes;
  if (!ReadArchiveEntry(&archive, "manifest.json", kMaximumManifestBytes,
                        &manifestBytes)) {
    SetError(error, L"形象包缺少有效 manifest.json。");
    return false;
  }
  auto pack = std::make_unique<AppearancePack>();
  std::string previewName;
  if (!ParseManifest(
          std::string(reinterpret_cast<const char*>(manifestBytes.data()),
                      manifestBytes.size()),
          pack.get(), &previewName, error)) return false;
  std::set<std::string> declared = {"manifest.json", previewName};
  for (const PackLayer& layer : pack->layers) declared.insert(layer.imageName);
  if (archiveNames != declared) {
    SetError(error, L"形象包包含未声明文件或缺少声明的 PNG。");
    return false;
  }
  std::vector<unsigned char> pngBytes;
  if (!ReadArchiveEntry(&archive, previewName, kMaximumPngBytes, &pngBytes) ||
      !LoadImage(pngBytes.data(), pngBytes.size(), &pack->preview)) {
    SetError(error, L"形象包预览图无效。");
    return false;
  }
  for (PackLayer& layer : pack->layers) {
    pngBytes.clear();
    if (!ReadArchiveEntry(&archive, layer.imageName, kMaximumPngBytes, &pngBytes) ||
        !LoadImage(pngBytes.data(), pngBytes.size(), &layer.image)) {
      SetError(error, L"形象包图层 PNG 无效。");
      return false;
    }
  }
  pack->sourcePath = path;
  *output = std::move(pack);
  return true;
}

PackKeyframe Interpolate(const std::vector<PackKeyframe>& keyframes,
                         float progress) {
  if (progress <= keyframes.front().t) return keyframes.front();
  if (progress >= keyframes.back().t) return keyframes.back();
  for (size_t index = 1; index < keyframes.size(); ++index) {
    if (progress <= keyframes[index].t) {
      const PackKeyframe& left = keyframes[index - 1];
      const PackKeyframe& right = keyframes[index];
      const float amount = (progress - left.t) / (right.t - left.t);
      PackKeyframe result;
      result.t = progress;
      result.x = left.x + (right.x - left.x) * amount;
      result.y = left.y + (right.y - left.y) * amount;
      result.rotation = left.rotation + (right.rotation - left.rotation) * amount;
      result.scale = left.scale + (right.scale - left.scale) * amount;
      result.alpha = left.alpha + (right.alpha - left.alpha) * amount;
      return result;
    }
  }
  return keyframes.back();
}

std::wstring FileNameForId(const std::string& id) {
  return Utf8ToWide(id) + L".nmgpack";
}

}  // namespace

PackImage::~PackImage() {
  image.reset();
  if (stream != nullptr) stream->Release();
}

PackImage::PackImage(PackImage&& other) noexcept
    : stream(other.stream), image(std::move(other.image)) {
  other.stream = nullptr;
}

PackImage& PackImage::operator=(PackImage&& other) noexcept {
  if (this == &other) return *this;
  image.reset();
  if (stream != nullptr) stream->Release();
  stream = other.stream;
  image = std::move(other.image);
  other.stream = nullptr;
  return *this;
}

bool AppearanceCatalog::Reload(const std::wstring& directory,
                               std::wstring* error) {
  packs_.clear();
  CreateDirectoryW(directory.c_str(), nullptr);
  WIN32_FIND_DATAW entry = {};
  HANDLE search = FindFirstFileW((directory + L"\\*.nmgpack").c_str(), &entry);
  if (search == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) return true;
    SetError(error, L"无法读取本地形象包目录。");
    return false;
  }
  do {
    if ((entry.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                                   FILE_ATTRIBUTE_REPARSE_POINT)) != 0) continue;
    std::unique_ptr<AppearancePack> pack;
    std::wstring ignored;
    if (LoadAppearancePackFile(directory + L"\\" + entry.cFileName, &pack,
                               &ignored)) {
      if (Find(pack->id) == nullptr) packs_.push_back(std::move(pack));
    }
  } while (FindNextFileW(search, &entry));
  FindClose(search);
  std::sort(packs_.begin(), packs_.end(),
            [](const auto& left, const auto& right) {
              return left->id < right->id;
            });
  return true;
}

bool AppearanceCatalog::Install(const std::wstring& sourcePath,
                                const std::wstring& directory,
                                std::string* installedId,
                                std::wstring* error) {
  std::unique_ptr<AppearancePack> validated;
  if (!LoadAppearancePackFile(sourcePath, &validated, error)) return false;
  CreateDirectoryW(directory.c_str(), nullptr);
  const std::wstring destination =
      directory + L"\\" + FileNameForId(validated->id);
  const std::wstring temporary = destination + L".incoming";
  DeleteFileW(temporary.c_str());
  if (!CopyFileW(sourcePath.c_str(), temporary.c_str(), FALSE)) {
    SetError(error, L"无法把形象包保存到本机。");
    return false;
  }
  std::unique_ptr<AppearancePack> copied;
  if (!LoadAppearancePackFile(temporary, &copied, error) ||
      copied->id != validated->id ||
      !MoveFileExW(temporary.c_str(), destination.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary.c_str());
    if (error != nullptr && error->empty())
      SetError(error, L"无法原子替换本地形象包。");
    return false;
  }
  *installedId = validated->id;
  return Reload(directory, error);
}

bool AppearanceCatalog::Delete(const std::string& id, std::wstring* error) {
  AppearancePack* pack = Find(id);
  if (pack == nullptr) return true;
  const std::wstring path = pack->sourcePath;
  if (!DeleteFileW(path.c_str())) {
    SetError(error, L"无法删除所选形象包。");
    return false;
  }
  packs_.erase(
      std::remove_if(packs_.begin(), packs_.end(),
                     [&](const auto& candidate) { return candidate->id == id; }),
      packs_.end());
  return true;
}

AppearancePack* AppearanceCatalog::Find(const std::string& id) const {
  for (const auto& pack : packs_) {
    if (pack->id == id) return pack.get();
  }
  return nullptr;
}

bool IsAppearancePackPath(const std::wstring& path) {
  if (path.size() < 8) return false;
  std::wstring extension = path.substr(path.size() - 8);
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](wchar_t character) { return std::towlower(character); });
  return extension == L".nmgpack";
}

bool RegisterAppearancePackAssociation(const std::wstring& executable,
                                       std::wstring* error) {
  const wchar_t* extensionKey = L"Software\\Classes\\.nmgpack";
  const wchar_t* classKey = L"Software\\Classes\\NiuMaMerit.AppearancePack";
  const wchar_t* commandKey =
      L"Software\\Classes\\NiuMaMerit.AppearancePack\\shell\\open\\command";
  HKEY key = nullptr;
  auto writeDefault = [&](const wchar_t* path, const std::wstring& value) {
    if (RegCreateKeyExW(HKEY_CURRENT_USER, path, 0, nullptr, 0, KEY_SET_VALUE,
                        nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
    const LSTATUS status = RegSetValueExW(
        key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
        static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key);
    key = nullptr;
    return status == ERROR_SUCCESS;
  };
  const std::wstring command = L"\"" + executable + L"\" \"%1\"";
  if (!writeDefault(extensionKey, L"NiuMaMerit.AppearancePack") ||
      !writeDefault(classKey, L"NiuMa Merit Appearance Pack") ||
      !writeDefault(commandKey, command)) {
    if (key != nullptr) RegCloseKey(key);
    SetError(error, L"无法注册形象包文件类型。");
    return false;
  }
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  return true;
}

void DrawAppearancePack(Gdiplus::Graphics& graphics,
                        const AppearancePack& pack,
                        float progress) {
  const Gdiplus::GraphicsState clipState = graphics.Save();
  graphics.SetClip(Gdiplus::RectF(0.0f, 80.0f, 240.0f, 170.0f));
  for (const PackLayer& layer : pack.layers) {
    const PackKeyframe keyframe = Interpolate(
        layer.keyframes, std::clamp(progress, 0.0f, 1.0f));
    const float top = 250.0f - layer.y - layer.height;
    const float anchorX = layer.x + layer.width * layer.anchorX;
    const float anchorY = top + layer.height * (1.0f - layer.anchorY);
    const Gdiplus::GraphicsState state = graphics.Save();
    graphics.TranslateTransform(anchorX + keyframe.x, anchorY - keyframe.y);
    graphics.RotateTransform(-keyframe.rotation);
    graphics.ScaleTransform(keyframe.scale, keyframe.scale);
    graphics.TranslateTransform(-anchorX, -anchorY);
    Gdiplus::ImageAttributes attributes;
    Gdiplus::ColorMatrix matrix = {
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, keyframe.alpha, 0,
        0, 0, 0, 0, 1};
    attributes.SetColorMatrix(&matrix);
    const Gdiplus::RectF destination(layer.x, top, layer.width, layer.height);
    graphics.DrawImage(layer.image.image.get(), destination, 0, 0,
                       static_cast<Gdiplus::REAL>(layer.image.image->GetWidth()),
                       static_cast<Gdiplus::REAL>(layer.image.image->GetHeight()),
                       Gdiplus::UnitPixel, &attributes);
    graphics.Restore(state);
  }
  graphics.Restore(clipState);
}

}  // namespace niuma
