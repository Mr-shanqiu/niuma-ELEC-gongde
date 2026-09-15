#import "appearance_pack.h"
#import <ImageIO/ImageIO.h>

static NSString *const NMErrorDomain = @"cn.niuma.merit.appearance-pack";
static const unsigned long long NMMaxArchiveBytes = 50ull * 1024ull * 1024ull;
static const unsigned long long NMMaxManifestBytes = 64ull * 1024ull;
static const size_t NMMaxImageDimension = 2048;
static const double NMArtworkTop = 170.0;
static const double NMFeedbackY = 174.0;

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

static NSDictionary *NMFrameAtPhase(NSArray<NSDictionary *> *frames, CGFloat phase) {
  if (!frames.count) return @{};
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
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"x", @"y", @"rotation", @"scale", @"alpha"]) {
    CGFloat a = [left[key] doubleValue], b = [right[key] doubleValue];
    result[key] = @(a + (b - a) * MAX(0, MIN(1, mix)));
  }
  return result;
}

- (void)drawAtPhase:(CGFloat)phase {
  for (NSDictionary *layer in self.layers) {
    NSImage *image = self.images[layer[@"image"]];
    NSArray *rectValues = layer[@"frame"];
    NSArray *anchor = layer[@"anchor"];
    NSDictionary *frame = NMFrameAtPhase(layer[@"keyframes"], MAX(0, MIN(1, phase)));
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
    [transform scaleBy:scale];
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
  NSSet *rootKeys = [NSSet setWithArray:@[@"schema_version", @"id", @"version", @"name_zh", @"name_en",
    @"author", @"publisher", @"review_id", @"canvas_width", @"canvas_height", @"preview", @"plus_y", @"layers"]];
  if (![json isKindOfClass:[NSDictionary class]] || !NMExactKeys(json, rootKeys) || [json[@"schema_version"] integerValue] != 1) {
    if (error) *error = NMError(32, @"manifest.json 格式或版本不受支持");
    return nil;
  }
  NSString *identifier = json[@"id"], *version = json[@"version"];
  NSCharacterSet *badID = [[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz0123456789.-"] invertedSet];
  if (![identifier isKindOfClass:[NSString class]] || identifier.length < 3 || identifier.length > 80 ||
      [identifier rangeOfCharacterFromSet:badID].location != NSNotFound ||
      ![version isKindOfClass:[NSString class]] || version.length > 32 ||
      ![json[@"name_zh"] isKindOfClass:[NSString class]] || ![json[@"name_en"] isKindOfClass:[NSString class]] ||
      ![json[@"author"] isKindOfClass:[NSString class]] || ![json[@"publisher"] isKindOfClass:[NSString class]] ||
      ![json[@"review_id"] isKindOfClass:[NSString class]] ||
      !NMNumberInRange(json[@"canvas_width"], 240, 240) || !NMNumberInRange(json[@"canvas_height"], 250, 250) ||
      !NMNumberInRange(json[@"plus_y"], NMFeedbackY, NMFeedbackY)) {
    if (error) *error = NMError(33, @"形象包基础字段无效");
    return nil;
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
  double previousT;
  for (NSDictionary *layer in layers) {
    if (![layer isKindOfClass:[NSDictionary class]] || !NMExactKeys(layer, layerKeys)) goto invalidLayers;
    NSString *imageName = layer[@"image"];
    NSArray *rect = layer[@"frame"], *anchor = layer[@"anchor"], *frames = layer[@"keyframes"];
    if (![imageName isKindOfClass:[NSString class]] || !NMIsSafeArchiveName(imageName) ||
        ![rect isKindOfClass:[NSArray class]] || rect.count != 4 ||
        ![anchor isKindOfClass:[NSArray class]] || anchor.count != 2 ||
        ![frames isKindOfClass:[NSArray class]] || frames.count < 1 || frames.count > 8) goto invalidLayers;
    if (!NMNumberInRange(rect[0], -240, 480) || !NMNumberInRange(rect[1], -250, 500) ||
        !NMNumberInRange(rect[2], 1, 480) || !NMNumberInRange(rect[3], 1, 500) ||
        [rect[1] doubleValue] + [rect[3] doubleValue] > NMArtworkTop ||
        !NMNumberInRange(anchor[0], 0, 1) || !NMNumberInRange(anchor[1], 0, 1)) goto invalidLayers;
    previousT = -1;
    for (NSDictionary *frame in frames) {
      if (![frame isKindOfClass:[NSDictionary class]] || !NMExactKeys(frame, frameKeys) || frame.count != 6 ||
          !NMNumberInRange(frame[@"t"], 0, 1) || [frame[@"t"] doubleValue] < previousT ||
          !NMNumberInRange(frame[@"x"], -480, 480) || !NMNumberInRange(frame[@"y"], -500, 500) ||
          !NMNumberInRange(frame[@"rotation"], -180, 180) || !NMNumberInRange(frame[@"scale"], 0.1, 4) ||
          !NMNumberInRange(frame[@"alpha"], 0, 1)) goto invalidLayers;
      previousT = [frame[@"t"] doubleValue];
    }
    [expected addObject:imageName];
  }
  if (![actual isEqualToSet:expected]) {
    if (error) *error = NMError(35, @"形象包文件必须与 manifest 声明完全一致");
    return nil;
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
  NSFileManager *fm = [NSFileManager defaultManager];
  NSURL *root = [self packsDirectoryURL];
  if (![fm createDirectoryAtURL:root withIntermediateDirectories:YES attributes:nil error:error]) return @[];
  NSArray<NSURL *> *directories = [fm contentsOfDirectoryAtURL:root includingPropertiesForKeys:@[NSURLIsDirectoryKey]
                                                        options:NSDirectoryEnumerationSkipsHiddenFiles error:error];
  NSMutableArray *packs = [NSMutableArray array];
  for (NSURL *directory in directories) {
    NSNumber *isDirectory = nil;
    [directory getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil];
    if (!isDirectory.boolValue || ![directory.pathExtension isEqualToString:@"nmgpackdata"]) continue;
    NMAppearancePack *pack = [self validatePackDirectory:directory error:nil];
    if (pack) [packs addObject:pack];
  }
  [packs sortUsingComparator:^NSComparisonResult(NMAppearancePack *a, NMAppearancePack *b) {
    return [[a localizedName] localizedCaseInsensitiveCompare:[b localizedName]];
  }];
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
  NMAppearancePack *pack = [self validatePackDirectory:stage error:error];
  if (!pack) {
    [fm removeItemAtURL:stage error:nil];
    return nil;
  }
  NSURL *destination = [root URLByAppendingPathComponent:[pack.identifier stringByAppendingPathExtension:@"nmgpackdata"] isDirectory:YES];
  NSURL *backup = [root URLByAppendingPathComponent:[NSString stringWithFormat:@".backup-%@", NSUUID.UUID.UUIDString] isDirectory:YES];
  BOOL hadOld = [fm fileExistsAtPath:destination.path];
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
