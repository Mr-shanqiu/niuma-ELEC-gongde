#import "appearance_pack.h"
#import <ImageIO/ImageIO.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const NMErrorDomain = @"cn.niuma.merit.appearance-pack";
static const unsigned long long NMMaxArchiveBytes = 50ull * 1024ull * 1024ull;
static const unsigned long long NMMaxBatchBytes = 100ull * 1024ull * 1024ull;
static const NSUInteger NMMaxBatchCount = 10;
static const unsigned long long NMMaxManifestBytes = 64ull * 1024ull;
static const size_t NMMaxImageDimension = 2048;
static const double NMArtworkTop = 170.0;
static const double NMFeedbackY = 174.0;
static const unsigned char NMPublicKey[] = {
  0x04, 0x2a, 0xc5, 0xfc, 0x45, 0x26, 0x01, 0xd3, 0x9c, 0xc4, 0xe2,
  0x9e, 0xcf, 0xf9, 0xb6, 0x16, 0x95, 0xe3, 0x1c, 0x78, 0x67, 0x27,
  0x41, 0x1a, 0x01, 0x26, 0xd3, 0xd7, 0xb5, 0x35, 0x2a, 0x6d, 0xbd,
  0x49, 0xb8, 0xa6, 0xf7, 0x6c, 0x7a, 0xe2, 0x83, 0x60, 0xf1, 0x80,
  0xaf, 0x21, 0xb8, 0x17, 0xa2, 0x2c, 0x9e, 0x05, 0x1d, 0xf6, 0x17,
  0xd9, 0xdc, 0xc1, 0xb3, 0xb8, 0x99, 0x87, 0x62, 0x22, 0xb7
};

// Keep the previous key for packs issued before the production signer changed.
static const unsigned char NMCurrentPublicKey[] = {
  0x04, 0x24, 0x52, 0xb3, 0xdb, 0xef, 0xcf, 0x06, 0x4c, 0x4c, 0xf2,
  0x02, 0x22, 0x96, 0xd3, 0x6b, 0x22, 0x99, 0xac, 0x61, 0x2e, 0x42,
  0xeb, 0x26, 0x7c, 0x55, 0x49, 0x42, 0xdf, 0xc5, 0x79, 0xb2, 0x69,
  0x21, 0xff, 0xf4, 0x90, 0x10, 0xdc, 0x6f, 0xd0, 0xff, 0xde, 0xa4,
  0xdf, 0x2a, 0x51, 0x7d, 0x72, 0xd1, 0x7a, 0x3b, 0xa8, 0x31, 0x7c,
  0xdd, 0x0a, 0xfc, 0xe2, 0xbd, 0x03, 0xae, 0xf2, 0x72, 0x7c
};

static NSError *NMError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:NMErrorDomain code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL NMRun(NSString *launchPath, NSArray<NSString *> *arguments,
                  NSData **stdoutData, NSError **error) {
  NSTask *task = [[NSTask alloc] init];
  NSPipe *out = [NSPipe pipe];
  NSPipe *err = [NSPipe pipe];
  task.launchPath = launchPath;
  task.arguments = arguments;
  task.standardOutput = out;
  task.standardError = err;
  @try {
    [task launch];
    [task waitUntilExit];
  } @catch (NSException *exception) {
    if (error) *error = NMError(1, exception.reason ?: @"无法运行系统解压工具");
    return NO;
  }
  NSData *output = [[out fileHandleForReading] readDataToEndOfFile];
  NSData *failure = [[err fileHandleForReading] readDataToEndOfFile];
  if (task.terminationStatus != 0) {
    NSString *detail = [[NSString alloc] initWithData:failure encoding:NSUTF8StringEncoding];
    if (error) *error = NMError(2, detail.length ? detail : @"形象包解压失败");
    return NO;
  }
  if (stdoutData) *stdoutData = output;
  return YES;
}

static BOOL NMIsSafeArchiveName(NSString *name) {
  if (!name.length || [name hasPrefix:@"."] || [name containsString:@"/"] ||
      [name containsString:@"\\"] || [name containsString:@".."] ||
      [name containsString:@":"]) return NO;
  if ([name isEqualToString:@"manifest.json"]) return YES;
  return [[name.pathExtension lowercaseString] isEqualToString:@"png"];
}

static BOOL NMIsSafeBatchName(NSString *name) {
  if (name.length < 10 || name.length > 180 || [name hasPrefix:@"."] ||
      [name containsString:@".."] ||
      ![[name.pathExtension lowercaseString] isEqualToString:@"nmgpack"]) return NO;
  static NSCharacterSet *forbidden;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    forbidden = [[NSCharacterSet characterSetWithCharactersInString:
        @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"] invertedSet];
  });
  return [name rangeOfCharacterFromSet:forbidden].location == NSNotFound;
}

static BOOL NMExtractBatchEntry(NSURL *archiveURL, NSString *name, NSURL *destination,
                                NSError **error) {
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm createFileAtPath:destination.path contents:nil attributes:nil]) {
    if (error) *error = NMError(60, @"无法创建批次中的临时形象包");
    return NO;
  }
  NSFileHandle *writer = [NSFileHandle fileHandleForWritingToURL:destination error:error];
  if (!writer) {
    [fm removeItemAtURL:destination error:nil];
    return NO;
  }
  NSTask *task = [[NSTask alloc] init];
  NSPipe *output = [NSPipe pipe];
  task.launchPath = @"/usr/bin/unzip";
  task.arguments = @[@"-p", archiveURL.path, name];
  task.standardOutput = output;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  BOOL launched = NO;
  BOOL complete = YES;
  unsigned long long bytes = 0;
  @try {
    [task launch];
    launched = YES;
    while (YES) {
      NSData *chunk = [[output fileHandleForReading] readDataOfLength:65536];
      if (!chunk.length) break;
      bytes += chunk.length;
      if (bytes > NMMaxArchiveBytes) {
        complete = NO;
        if (error) *error = NMError(61, @"批次中的单个形象包不能超过 50MB");
        break;
      }
      [writer writeData:chunk];
    }
  } @catch (NSException *exception) {
    complete = NO;
    if (error) *error = NMError(62, exception.reason ?: @"形象包解压失败");
  }
  [writer closeFile];
  if (launched) {
    if (!complete && task.isRunning) [task terminate];
    [task waitUntilExit];
  }
  if (!complete || !launched || task.terminationStatus != 0 || bytes == 0) {
    if (complete && error) *error = NMError(63, @"批次中的形象包解压失败");
    [fm removeItemAtURL:destination error:nil];
    return NO;
  }
  return YES;
}

static BOOL NMExactKeys(NSDictionary *dictionary, NSSet<NSString *> *allowed) {
  for (id key in dictionary) {
    if (![key isKindOfClass:[NSString class]] || ![allowed containsObject:key]) return NO;
  }
  return YES;
}

static BOOL NMNumberInRange(id value, double low, double high) {
  if (![value isKindOfClass:[NSNumber class]]) return NO;
  double number = [value doubleValue];
  return isfinite(number) && number >= low && number <= high;
}

static NSData *NMDataFromHex(NSString *hex) {
  if (![hex isKindOfClass:NSString.class] || hex.length % 2 != 0) return nil;
  NSMutableData *data = [NSMutableData dataWithCapacity:hex.length / 2];
  for (NSUInteger index = 0; index < hex.length; index += 2) {
    unsigned int byte = 0;
    NSString *pair = [hex substringWithRange:NSMakeRange(index, 2)];
    NSScanner *scanner = [NSScanner scannerWithString:pair];
    if (![scanner scanHexInt:&byte] || !scanner.isAtEnd) return nil;
    unsigned char value = (unsigned char)byte;
    [data appendBytes:&value length:1];
  }
  return data;
}

static NSData *NMDERSignatureFromRaw(NSData *raw) {
  if (raw.length != 64) return nil;
  NSMutableData *body = [NSMutableData data];
  const unsigned char *bytes = (const unsigned char *)raw.bytes;
  for (NSUInteger part = 0; part < 2; ++part) {
    const unsigned char *integer = bytes + part * 32;
    NSUInteger offset = 0;
    while (offset < 31 && integer[offset] == 0) ++offset;
    BOOL needsZero = (integer[offset] & 0x80) != 0;
    unsigned char tag = 0x02;
    unsigned char length = (unsigned char)(32 - offset + (needsZero ? 1 : 0));
    [body appendBytes:&tag length:1];
    [body appendBytes:&length length:1];
    if (needsZero) {
      unsigned char zero = 0;
      [body appendBytes:&zero length:1];
    }
    [body appendBytes:integer + offset length:32 - offset];
  }
  unsigned char sequence[] = {0x30, (unsigned char)body.length};
  NSMutableData *der = [NSMutableData dataWithBytes:sequence length:2];
  [der appendData:body];
  return der;
}

static NSString *NMContentHash(NSURL *directoryURL, NSSet<NSString *> *names,
                               NSError **error) {
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  NSArray<NSString *> *sorted = [[names allObjects]
      sortedArrayUsingSelector:@selector(compare:)];
  for (NSString *name in sorted) {
    if ([name isEqualToString:@"manifest.json"]) continue;
    NSData *data = [NSData dataWithContentsOfURL:[directoryURL URLByAppendingPathComponent:name]
                                        options:0 error:error];
    if (!data) return nil;
    NSData *nameData = [name dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char zero = 0;
    uint64_t length = CFSwapInt64HostToBig((uint64_t)data.length);
    CC_SHA256_Update(&context, nameData.bytes, (CC_LONG)nameData.length);
    CC_SHA256_Update(&context, &zero, 1);
    CC_SHA256_Update(&context, &length, sizeof(length));
    CC_SHA256_Update(&context, data.bytes, (CC_LONG)data.length);
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  NSMutableString *hex = [NSMutableString stringWithCapacity:64];
  for (unsigned char byte : digest) [hex appendFormat:@"%02x", byte];
  return hex;
}

static BOOL NMVerifyLicense(NSString *message, NSString *signatureHex) {
  NSData *rawSignature = NMDataFromHex(signatureHex);
  NSData *derSignature = NMDERSignatureFromRaw(rawSignature);
  if (!derSignature) return NO;
  NSDictionary *attributes = @{
    (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeECSECPrimeRandom,
    (__bridge id)kSecAttrKeyClass: (__bridge id)kSecAttrKeyClassPublic,
    (__bridge id)kSecAttrKeySizeInBits: @256
  };
  NSData *messageData = [message dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(messageData.bytes, (CC_LONG)messageData.length, digest);
  NSData *digestData = [NSData dataWithBytes:digest length:sizeof(digest)];
  const unsigned char *trustedKeys[] = {NMPublicKey, NMCurrentPublicKey};
  for (const unsigned char *publicKey : trustedKeys) {
    NSData *keyData = [NSData dataWithBytes:publicKey length:sizeof(NMPublicKey)];
    SecKeyRef key = SecKeyCreateWithData((__bridge CFDataRef)keyData,
                                         (__bridge CFDictionaryRef)attributes, NULL);
    if (!key) continue;
    BOOL valid = SecKeyVerifySignature(key,
        kSecKeyAlgorithmECDSASignatureDigestX962SHA256,
        (__bridge CFDataRef)digestData, (__bridge CFDataRef)derSignature, NULL);
    CFRelease(key);
    if (valid) return YES;
  }
  return NO;
}

static NSImage *NMLoadPNG(NSURL *url, NSError **error) {
  CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
  if (!source || CGImageSourceGetCount(source) != 1) {
    if (source) CFRelease(source);
    if (error) *error = NMError(20, @"PNG 文件无效");
    return nil;
  }
  CFStringRef type = CGImageSourceGetType(source);
  NSDictionary *properties = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex(source, 0, NULL);
  size_t width = [properties[(NSString *)kCGImagePropertyPixelWidth] unsignedLongValue];
  size_t height = [properties[(NSString *)kCGImagePropertyPixelHeight] unsignedLongValue];
  BOOL valid = type && CFEqual(type, CFSTR("public.png")) && width > 0 && height > 0 &&
               width <= NMMaxImageDimension && height <= NMMaxImageDimension;
  CFRelease(source);
  if (!valid) {
    if (error) *error = NMError(21, @"PNG 尺寸必须在 1 到 2048 像素之间");
    return nil;
  }
  NSImage *image = [[NSImage alloc] initWithContentsOfURL:url];
  if (!image && error) *error = NMError(22, @"无法读取 PNG 文件");
  return image;
}

@implementation NMAppearancePack
- (NSString *)localizedName {
  return [[NSLocale preferredLanguages].firstObject hasPrefix:@"zh"] ? self.nameZH : self.nameEN;
}

static NSDictionary *NMFrameAtPhase(NSArray<NSDictionary *> *frames, CGFloat phase, BOOL smooth) {
  if (!frames.count) return @{};
  if (phase <= [frames.firstObject[@"t"] doubleValue]) return frames.firstObject;
  if (phase >= [frames.lastObject[@"t"] doubleValue]) return frames.lastObject;
  NSDictionary *left = frames.firstObject;
  NSDictionary *right = frames.lastObject;
  for (NSUInteger i = 1; i < frames.count; ++i) {
    NSDictionary *candidate = frames[i];
    if ([candidate[@"t"] doubleValue] >= phase) {
      right = candidate;
      left = frames[i - 1];
      break;
    }
  }
  CGFloat lt = [left[@"t"] doubleValue], rt = [right[@"t"] doubleValue];
  CGFloat mix = rt > lt ? (phase - lt) / (rt - lt) : 0;
  mix = MAX(0, MIN(1, mix));
  if (smooth) mix = mix * mix * (3 - 2 * mix);
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"x", @"y", @"rotation", @"scale", @"scale_y", @"alpha"]) {
    NSNumber *fallback = [key isEqualToString:@"scale_y"] ? @1 : @0;
    CGFloat a = [(left[key] ?: fallback) doubleValue], b = [(right[key] ?: fallback) doubleValue];
    result[key] = @(a + (b - a) * MAX(0, MIN(1, mix)));
  }
  return result;
}

- (void)drawAtPhase:(CGFloat)phase {
  for (NSDictionary *layer in self.layers) {
    NSImage *image = self.images[layer[@"image"]];
    NSArray *rectValues = layer[@"frame"];
    NSArray *anchor = layer[@"anchor"];
    NSDictionary *frame = NMFrameAtPhase(layer[@"keyframes"], MAX(0, MIN(1, phase)),
                                         [layer[@"interpolation"] isEqualToString:@"smoothstep"]);
    NSRect rect = NSMakeRect([rectValues[0] doubleValue], [rectValues[1] doubleValue],
                             [rectValues[2] doubleValue], [rectValues[3] doubleValue]);
    CGFloat anchorX = NSMinX(rect) + NSWidth(rect) * [anchor[0] doubleValue];
    CGFloat anchorY = NSMinY(rect) + NSHeight(rect) * [anchor[1] doubleValue];
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform translateXBy:anchorX + [frame[@"x"] doubleValue]
                        yBy:anchorY + [frame[@"y"] doubleValue]];
    [transform rotateByDegrees:[frame[@"rotation"] doubleValue]];
    CGFloat scale = [frame[@"scale"] doubleValue];
    [transform scaleXBy:scale yBy:scale * [(frame[@"scale_y"] ?: @1) doubleValue]];
    [transform translateXBy:-anchorX yBy:-anchorY];
    [transform concat];
    [image drawInRect:rect fromRect:NSZeroRect operation:NSCompositingOperationSourceOver
             fraction:[frame[@"alpha"] doubleValue] respectFlipped:NO hints:nil];
    [NSGraphicsContext restoreGraphicsState];
  }
}
@end

@implementation NMAppearancePackStore
+ (NSURL *)packsDirectoryURL {
  NSString *override = NSProcessInfo.processInfo.environment[@"NIUMA_PACK_ROOT"];
  if (override.length) return [NSURL fileURLWithPath:override isDirectory:YES];
  NSURL *support = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
  return [[support URLByAppendingPathComponent:@"NiuMaMerit" isDirectory:YES]
          URLByAppendingPathComponent:@"AppearancePacks" isDirectory:YES];
}

+ (NMAppearancePack *)validatePackDirectory:(NSURL *)directoryURL error:(NSError **)error {
  return [self validatePackDirectory:directoryURL enforceImportDeadline:NO error:error];
}

+ (NMAppearancePack *)validatePackDirectory:(NSURL *)directoryURL
                      enforceImportDeadline:(BOOL)enforceImportDeadline
                                      error:(NSError **)error {
  (void)enforceImportDeadline; // Retained for private call-site compatibility only.
  NSFileManager *fm = [NSFileManager defaultManager];
  NSArray<NSURL *> *files = [fm contentsOfDirectoryAtURL:directoryURL
                              includingPropertiesForKeys:@[NSURLIsRegularFileKey, NSURLIsSymbolicLinkKey]
                                                 options:0 error:error];
  if (!files) return nil;
  NSMutableSet<NSString *> *actual = [NSMutableSet set];
  for (NSURL *file in files) {
    NSNumber *regular = nil, *symbolic = nil;
    [file getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
    [file getResourceValue:&symbolic forKey:NSURLIsSymbolicLinkKey error:nil];
    if (!regular.boolValue || symbolic.boolValue || !NMIsSafeArchiveName(file.lastPathComponent)) {
      if (error) *error = NMError(30, @"形象包包含不允许的文件");
      return nil;
    }
    [actual addObject:file.lastPathComponent];
  }
  NSURL *manifestURL = [directoryURL URLByAppendingPathComponent:@"manifest.json"];
  NSNumber *manifestSize = nil;
  [manifestURL getResourceValue:&manifestSize forKey:NSURLFileSizeKey error:nil];
  if (!manifestSize || manifestSize.unsignedLongLongValue > NMMaxManifestBytes) {
    if (error) *error = NMError(31, @"manifest.json 缺失或超过 64KB");
    return nil;
  }
  NSData *data = [NSData dataWithContentsOfURL:manifestURL options:0 error:error];
  NSDictionary *json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:error] : nil;
  if (![json isKindOfClass:[NSDictionary class]]) {
    if (error) *error = NMError(32, @"manifest.json 格式或版本不受支持");
    return nil;
  }
  NSInteger schemaVersion = [json[@"schema_version"] integerValue];
  NSSet *rootKeysV1 = [NSSet setWithArray:@[@"schema_version", @"id", @"version", @"name_zh", @"name_en",
    @"author", @"publisher", @"review_id", @"canvas_width", @"canvas_height", @"preview", @"plus_y", @"layers"]];
  NSMutableSet *rootKeysV2 = [rootKeysV1 mutableCopy];
  [rootKeysV2 addObject:@"license"];
  BOOL validRoot = (schemaVersion == 1 && NMExactKeys(json, rootKeysV1)) ||
       (schemaVersion == 2 && NMExactKeys(json, rootKeysV2)) ||
       (schemaVersion == 3 && NMExactKeys(json, json[@"license"] ? rootKeysV2 : rootKeysV1));
  if (!validRoot) {
    if (error) *error = NMError(32, @"manifest.json 格式或版本不受支持");
    return nil;
  }
  NSString *identifier = json[@"id"], *version = json[@"version"];
  NSCharacterSet *badID = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789.-"] invertedSet];
  if (![identifier isKindOfClass:[NSString class]] || identifier.length < 3 || identifier.length > 80 ||
      [identifier rangeOfCharacterFromSet:badID].location != NSNotFound ||
      ![version isKindOfClass:[NSString class]] || version.length > 32 ||
      [version rangeOfCharacterFromSet:NSCharacterSet.newlineCharacterSet].location != NSNotFound ||
      ![json[@"name_zh"] isKindOfClass:[NSString class]] || ![json[@"name_en"] isKindOfClass:[NSString class]] ||
      ![json[@"author"] isKindOfClass:[NSString class]] || ![json[@"publisher"] isKindOfClass:[NSString class]] ||
      ![json[@"review_id"] isKindOfClass:[NSString class]] ||
      !NMNumberInRange(json[@"canvas_width"], 240, 240) || !NMNumberInRange(json[@"canvas_height"], 250, 250) ||
      !NMNumberInRange(json[@"plus_y"], NMFeedbackY, NMFeedbackY)) {
    if (error) *error = NMError(33, @"形象包基础字段无效");
    return nil;
  }
  // Preserve the real issuers of existing official packs, not synthetic test labels.
  NSString *publisher = json[@"publisher"];
  if (([identifier hasPrefix:@"official."] || [identifier hasPrefix:@"zqscreen."] ||
       [identifier hasPrefix:@"creator."]) && !json[@"license"]) {
    if (error) *error = NMError(37, @"平台形象包必须包含有效的签名授权");
    return nil;
  }
  if (([identifier hasPrefix:@"official."] && ![publisher isEqualToString:@"NiuMa Merit"]) ||
      ([identifier hasPrefix:@"zqscreen."] && ![publisher isEqualToString:@"zqscreen"])) {
    if (error) *error = NMError(33, @"非官方形象包不能使用官方标识，请使用自己的形象包标识");
    return nil;
  }
  // The platform namespace is reserved for reviewed community deliveries.
  // Ordinary non-platform DIY packages retain their existing import contract.
  if ([identifier hasPrefix:@"creator."]) {
    NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:
        @"^creator\\.[a-f0-9]{32}\\.[a-z0-9-]{1,32}$" options:0 error:NULL];
    NSString *reviewID = json[@"review_id"];
    NSCharacterSet *nonHex = [[NSCharacterSet characterSetWithCharactersInString:
        @"0123456789abcdef"] invertedSet];
    if (![json[@"publisher"] isEqualToString:@"community"] ||
        [pattern numberOfMatchesInString:identifier options:0
                                  range:NSMakeRange(0, identifier.length)] != 1 ||
        reviewID.length != 32 ||
        [reviewID rangeOfCharacterFromSet:nonHex].location != NSNotFound) {
      if (error) *error = NMError(33, @"社区形象包标识或审核信息无效，请从官网重新下载");
      return nil;
    }
  }
  NSString *previewName = json[@"preview"];
  NSArray *layers = json[@"layers"];
  if (![previewName isKindOfClass:[NSString class]] || !NMIsSafeArchiveName(previewName) ||
      ![layers isKindOfClass:[NSArray class]] || layers.count < 1 || layers.count > 6) {
    if (error) *error = NMError(34, @"形象包预览或图层数量无效");
    return nil;
  }
  NSMutableSet<NSString *> *expected = [NSMutableSet setWithObjects:@"manifest.json", previewName, nil];
  NSMutableDictionary<NSString *, NSImage *> *images = [NSMutableDictionary dictionary];
  NSSet *layerKeys = [NSSet setWithArray:@[@"image", @"frame", @"anchor", @"keyframes"]];
  NSSet *frameKeys = [NSSet setWithArray:@[@"t", @"x", @"y", @"rotation", @"scale", @"alpha"]];
  if (schemaVersion == 3) {
    layerKeys = [layerKeys setByAddingObject:@"interpolation"];
    frameKeys = [frameKeys setByAddingObject:@"scale_y"];
  }
  double previousT;
  for (NSDictionary *layer in layers) {
    if (![layer isKindOfClass:[NSDictionary class]] || !NMExactKeys(layer, layerKeys)) goto invalidLayers;
    if (schemaVersion == 3 && ![@[@"linear", @"smoothstep"] containsObject:layer[@"interpolation"]]) goto invalidLayers;
    NSString *imageName = layer[@"image"];
    NSArray *rect = layer[@"frame"], *anchor = layer[@"anchor"], *frames = layer[@"keyframes"];
    if (![imageName isKindOfClass:[NSString class]] || !NMIsSafeArchiveName(imageName) ||
        ![rect isKindOfClass:[NSArray class]] || rect.count != 4 ||
        ![anchor isKindOfClass:[NSArray class]] || anchor.count != 2 ||
        ![frames isKindOfClass:[NSArray class]] || frames.count < 1 || frames.count > 8) goto invalidLayers;
    if (!NMNumberInRange(rect[0], -240, 480) || !NMNumberInRange(rect[1], -250, 500) ||
        !NMNumberInRange(rect[2], 1, 480) || !NMNumberInRange(rect[3], 1, 500) ||
        (schemaVersion != 3 && [rect[1] doubleValue] + [rect[3] doubleValue] > NMArtworkTop) ||
        !NMNumberInRange(anchor[0], 0, 1) || !NMNumberInRange(anchor[1], 0, 1)) goto invalidLayers;
    previousT = -1;
    for (NSDictionary *frame in frames) {
      if (![frame isKindOfClass:[NSDictionary class]] || !NMExactKeys(frame, frameKeys) ||
          !NMNumberInRange(frame[@"t"], 0, 1) || [frame[@"t"] doubleValue] < previousT ||
          !NMNumberInRange(frame[@"x"], -480, 480) || !NMNumberInRange(frame[@"y"], -500, 500) ||
          !NMNumberInRange(frame[@"rotation"], -180, 180) || !NMNumberInRange(frame[@"scale"], 0.1, 4) ||
          !NMNumberInRange(frame[@"alpha"], 0, 1) ||
          (schemaVersion == 3 && !NMNumberInRange(frame[@"scale_y"], 0.1, 4))) goto invalidLayers;
      previousT = [frame[@"t"] doubleValue];
    }
    [expected addObject:imageName];
  }
  if (![actual isEqualToSet:expected]) {
    if (error) *error = NMError(35, @"形象包文件必须与 manifest 声明完全一致");
    return nil;
  }
  if (schemaVersion == 2 || (schemaVersion == 3 && json[@"license"])) {
    id licenseValue = json[@"license"];
    if (![licenseValue isKindOfClass:NSDictionary.class]) {
      if (error) *error = NMError(37, @"限时导入凭证格式无效");
      return nil;
    }
    NSDictionary *license = licenseValue;
    NSString *mode = license[@"mode"];
    BOOL perpetual = [mode isKindOfClass:NSString.class] && [mode isEqualToString:@"perpetual"];
    BOOL timed = [mode isKindOfClass:NSString.class] && [mode isEqualToString:@"timed"];
    NSSet *licenseKeys = [NSSet setWithArray:@[@"mode", @"issued_at",
      @"download_id", @"content_sha256", @"signature"]];
    if (timed) licenseKeys = [licenseKeys setByAddingObject:@"import_before"];
    NSNumber *issuedValue = license[@"issued_at"];
    NSNumber *deadlineValue = license[@"import_before"];
    NSString *downloadID = license[@"download_id"];
    NSString *contentHash = license[@"content_sha256"];
    NSString *signature = license[@"signature"];
    NSCharacterSet *badToken = [[NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet];
    NSCharacterSet *badHex = [[NSCharacterSet characterSetWithCharactersInString:
        @"0123456789abcdef"] invertedSet];
    if ((!timed && !perpetual) || license.count != licenseKeys.count || !NMExactKeys(license, licenseKeys) ||
        !NMNumberInRange(issuedValue, 1577836800, 4102444800) ||
        floor(issuedValue.doubleValue) != issuedValue.doubleValue ||
        (timed && (!NMNumberInRange(deadlineValue, 1577836800, 4102444800) ||
          floor(deadlineValue.doubleValue) != deadlineValue.doubleValue ||
          deadlineValue.doubleValue <= issuedValue.doubleValue ||
          deadlineValue.doubleValue - issuedValue.doubleValue > 86400)) ||
        ![downloadID isKindOfClass:NSString.class] || downloadID.length < 16 || downloadID.length > 128 ||
        [downloadID rangeOfCharacterFromSet:badToken].location != NSNotFound ||
        ![contentHash isKindOfClass:NSString.class] || contentHash.length != 64 ||
        [contentHash rangeOfCharacterFromSet:badHex].location != NSNotFound ||
        ![signature isKindOfClass:NSString.class] || signature.length != 128 ||
        [signature rangeOfCharacterFromSet:badHex].location != NSNotFound) {
      if (error) *error = NMError(37, @"形象包授权凭证格式无效");
      return nil;
    }
    NSString *actualHash = NMContentHash(directoryURL, expected, error);
    if (!actualHash || ![actualHash isEqualToString:contentHash]) {
      if (error && !*error) *error = NMError(38, @"形象包内容与授权凭证不匹配");
      return nil;
    }
    long long issued = issuedValue.longLongValue;
    NSString *message = perpetual
        ? [NSString stringWithFormat:@"NIUMA-PACK-LICENSE-V2\nperpetual\n%@\n%@\n%lld\n%@\n%@",
            identifier, version, issued, downloadID, contentHash]
        : [NSString stringWithFormat:@"NIUMA-PACK-LICENSE-V1\n%@\n%@\n%lld\n%lld\n%@\n%@",
            identifier, version, issued, deadlineValue.longLongValue, downloadID, contentHash];
    if (!NMVerifyLicense(message, signature)) {
      if (error) *error = NMError(39, @"形象包授权签名无效");
      return nil;
    }
  }
  for (NSString *name in expected) {
    if ([name isEqualToString:@"manifest.json"]) continue;
    NSImage *image = NMLoadPNG([directoryURL URLByAppendingPathComponent:name], error);
    if (!image) return nil;
    images[name] = image;
  }
  {
    NMAppearancePack *pack = [[NMAppearancePack alloc] init];
    pack.identifier = identifier;
    pack.version = version;
    pack.nameZH = json[@"name_zh"];
    pack.nameEN = json[@"name_en"];
    pack.author = json[@"author"];
    pack.publisher = json[@"publisher"];
    pack.reviewID = json[@"review_id"];
    pack.directoryURL = directoryURL;
    pack.previewImage = images[previewName];
    pack.layers = layers;
    pack.images = images;
    pack.plusY = [json[@"plus_y"] doubleValue];
    return pack;
  }
invalidLayers:
  if (error) *error = NMError(36, @"形象包图层或关键帧字段无效");
  return nil;
}

+ (NSArray<NMAppearancePack *> *)loadInstalledPacks:(NSError **)error {
  if (error) *error = nil;
  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *root = [self packsDirectoryURL];
  if (![fm createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:error]) return @[];
  NSArray<NSURL *> *directories = [fm contentsOfDirectoryAtURL:root includingPropertiesForKeys:@[NSURLIsDirectoryKey]
                                                        options:NSDirectoryEnumerationSkipsHiddenFiles error:error];
  if (!directories) return @[];
  NSMutableArray *packs = [NSMutableArray array];
  NSMutableArray<NSString *> *failures = [NSMutableArray array];
  NSError *firstFailure = nil;
  for (NSURL *directory in directories) {
    NSNumber *isDirectory = nil;
    [directory getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil];
    if (!isDirectory.boolValue || ![directory.pathExtension isEqualToString:@"nmgpackdata"]) continue;
    NSError *packError = nil;
    // Installed and newly imported packs remain usable independently of the clock.
    // This still verifies their manifest, images, content hash, and license signature.
    NMAppearancePack *pack = [self validatePackDirectory:directory
                                enforceImportDeadline:NO error:&packError];
    if (pack) {
      [packs addObject:pack];
    } else {
      if (!firstFailure) firstFailure = packError;
      [failures addObject:[NSString stringWithFormat:@"%@：%@",
          directory.lastPathComponent.stringByDeletingPathExtension,
          packError.localizedDescription ?: @"无法读取形象包"]];
    }
  }
  [packs sortUsingComparator:^NSComparisonResult(NMAppearancePack *a, NMAppearancePack *b) {
    return [[a localizedName] localizedCaseInsensitiveCompare:[b localizedName]];
  }];
  if (failures.count && error) {
    NSMutableDictionary *info = [@{
      NSLocalizedDescriptionKey: [NSString stringWithFormat:
          @"以下本地形象未能加载，原文件仍保留，请勿重复付款：\n%@",
          [failures componentsJoinedByString:@"\n"]]
    } mutableCopy];
    if (firstFailure) info[NSUnderlyingErrorKey] = firstFailure;
    *error = [NSError errorWithDomain:@"cn.niuma.merit.appearance-load"
                                code:1 userInfo:info];
  }
  return packs;
}

+ (NMAppearancePack *)installArchiveAtURL:(NSURL *)archiveURL error:(NSError **)error {
  NSNumber *size = nil, *regular = nil, *symbolic = nil;
  [archiveURL getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
  [archiveURL getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
  [archiveURL getResourceValue:&symbolic forKey:NSURLIsSymbolicLinkKey error:nil];
  if (!regular.boolValue || symbolic.boolValue || size.unsignedLongLongValue > NMMaxArchiveBytes ||
      ![[archiveURL.pathExtension lowercaseString] isEqualToString:@"nmgpack"]) {
    if (error) *error = NMError(40, @"请选择不超过 50MB 的 .nmgpack 文件");
    return nil;
  }
  NSData *listingData = nil;
  if (!NMRun(@"/usr/bin/unzip", @[@"-Z1", archiveURL.path], &listingData, error)) return nil;
  NSString *listing = [[NSString alloc] initWithData:listingData encoding:NSUTF8StringEncoding];
  NSArray<NSString *> *lines = [listing componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
  NSMutableSet *names = [NSMutableSet set];
  for (NSString *line in lines) {
    if (!line.length) continue;
    if (!NMIsSafeArchiveName(line) || [names containsObject:line]) {
      if (error) *error = NMError(41, @"形象包包含目录、重复文件或危险路径");
      return nil;
    }
    [names addObject:line];
  }
  if (![names containsObject:@"manifest.json"] || names.count < 2 || names.count > 8) {
    if (error) *error = NMError(42, @"形象包文件数量或 manifest 无效");
    return nil;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *root = [self packsDirectoryURL];
  if (![fm createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:error]) return nil;
  NSURL *stage = [root URLByAppendingPathComponent:[NSString stringWithFormat:@".import-%@", NSUUID.UUID.UUIDString] isDirectory:YES];
  if (![fm createDirectoryAtURL:stage withIntermediateDirectories:NO attributes:nil error:error]) return nil;
  if (!NMRun(@"/usr/bin/ditto", @[@"-x", @"-k", @"--noqtn", archiveURL.path, stage.path], nil, error)) {
    [fm removeItemAtURL:stage error:nil];
    return nil;
  }
  NMAppearancePack *pack = [self validatePackDirectory:stage enforceImportDeadline:YES error:error];
  if (!pack) {
    [fm removeItemAtURL:stage error:nil];
    return nil;
  }
  NSURL *destination = [root URLByAppendingPathComponent:[pack.identifier stringByAppendingPathExtension:@"nmgpackdata"] isDirectory:YES];
  NSURL *backup = [root URLByAppendingPathComponent:[NSString stringWithFormat:@".backup-%@", NSUUID.UUID.UUIDString] isDirectory:YES];
  BOOL hadOld = [fm fileExistsAtPath:destination.path];
  if (hadOld) {
    NMAppearancePack *existing = [self validatePackDirectory:destination error:nil];
    if (!existing || ![existing.publisher isEqualToString:pack.publisher]) {
      if (error) *error = NMError(43, @"同名形象包的来源不一致或原包无法校验，不能覆盖原有形象包");
      [fm removeItemAtURL:stage error:nil];
      return nil;
    }
  }
  if (hadOld && ![fm moveItemAtURL:destination toURL:backup error:error]) {
    [fm removeItemAtURL:stage error:nil];
    return nil;
  }
  if (![fm moveItemAtURL:stage toURL:destination error:error]) {
    if (hadOld) [fm moveItemAtURL:backup toURL:destination error:nil];
    return nil;
  }
  if (hadOld) [fm removeItemAtURL:backup error:nil];
  return [self validatePackDirectory:destination error:error];
}

+ (NSArray<NMAppearancePack *> *)installBatchArchiveAtURL:(NSURL *)archiveURL error:(NSError **)error {
  NSNumber *size = nil, *regular = nil, *symbolic = nil;
  [archiveURL getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
  [archiveURL getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
  [archiveURL getResourceValue:&symbolic forKey:NSURLIsSymbolicLinkKey error:nil];
  if (!regular.boolValue || symbolic.boolValue || size.unsignedLongLongValue == 0 ||
      size.unsignedLongLongValue > NMMaxBatchBytes ||
      ![[archiveURL.pathExtension lowercaseString] isEqualToString:@"nmgpacks"]) {
    if (error) *error = NMError(64, @"请选择不超过 100MB 的 .nmgpacks 批次文件");
    return nil;
  }
  NSData *listingData = nil;
  if (!NMRun(@"/usr/bin/unzip", @[@"-Z1", archiveURL.path], &listingData, error)) return nil;
  NSString *listing = [[NSString alloc] initWithData:listingData encoding:NSUTF8StringEncoding];
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (NSString *name in [listing componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
    if (!name.length) continue;
    if (!NMIsSafeBatchName(name) || [seen containsObject:name.lowercaseString]) {
      if (error) *error = NMError(65, @"批次包含重复文件或危险路径");
      return nil;
    }
    [names addObject:name];
    [seen addObject:name.lowercaseString];
  }
  if (names.count < 2 || names.count > NMMaxBatchCount) {
    if (error) *error = NMError(66, @"批次必须包含 2 至 10 个独立形象包");
    return nil;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *root = [self packsDirectoryURL];
  if (![fm createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:error]) return nil;
  NSURL *stage = [root URLByAppendingPathComponent:
      [NSString stringWithFormat:@".batch-%@", NSUUID.UUID.UUIDString] isDirectory:YES];
  if (![fm createDirectoryAtURL:stage withIntermediateDirectories:NO attributes:nil error:error]) return nil;
  NSMutableArray<NSURL *> *extracted = [NSMutableArray array];
  unsigned long long totalBytes = 0;
  for (NSString *name in names) {
    NSURL *file = [stage URLByAppendingPathComponent:name];
    if (!NMExtractBatchEntry(archiveURL, name, file, error)) {
      [fm removeItemAtURL:stage error:nil];
      return nil;
    }
    NSNumber *fileSize = nil, *fileRegular = nil, *fileSymbolic = nil;
    [file getResourceValue:&fileSize forKey:NSURLFileSizeKey error:nil];
    [file getResourceValue:&fileRegular forKey:NSURLIsRegularFileKey error:nil];
    [file getResourceValue:&fileSymbolic forKey:NSURLIsSymbolicLinkKey error:nil];
    totalBytes += fileSize.unsignedLongLongValue;
    if (!fileRegular.boolValue || fileSymbolic.boolValue || totalBytes > NMMaxBatchBytes) {
      if (error) *error = NMError(67, @"批次解压数据超过 100MB");
      [fm removeItemAtURL:stage error:nil];
      return nil;
    }
    [extracted addObject:file];
  }
  NSMutableArray<NMAppearancePack *> *installed = [NSMutableArray array];
  for (NSURL *file in extracted) {
    NSError *packError = nil;
    NMAppearancePack *pack = [self installArchiveAtURL:file error:&packError];
    if (!pack) {
      if (error) *error = NMError(68, [NSString stringWithFormat:
          @"已导入 %lu 个形象，其余未完成：%@", (unsigned long)installed.count,
          packError.localizedDescription ?: @"形象包无效"]);
      [fm removeItemAtURL:stage error:nil];
      return nil;
    }
    [installed addObject:pack];
  }
  [fm removeItemAtURL:stage error:nil];
  return installed;
}

+ (BOOL)removePack:(NMAppearancePack *)pack error:(NSError **)error {
  NSURL *root = [self packsDirectoryURL].URLByStandardizingPath;
  NSURL *target = pack.directoryURL.URLByStandardizingPath;
  if (![[target URLByDeletingLastPathComponent].path isEqualToString:root.path] ||
      ![target.pathExtension isEqualToString:@"nmgpackdata"]) {
    if (error) *error = NMError(50, @"拒绝删除形象包目录之外的文件");
    return NO;
  }
  return [[NSFileManager defaultManager] removeItemAtURL:target error:error];
}
@end
