#pragma once
#import <Foundation/Foundation.h>
#import <Security/Security.h>

// A translocated bundle is a temporary read-only execution location. Keep
// macOS quarantine and Gatekeeper intact; only resolve durable file references.
static BOOL NMIsTemporaryApplicationURL(NSURL *url) {
  NSString *path = url.URLByStandardizingPath.path;
  return !path.length || [path.pathComponents containsObject:@"AppTranslocation"] ||
      [path hasPrefix:@"/Volumes/"];
}

static BOOL NMApplicationBundlesMatch(NSURL *candidate, NSURL *reference) {
  if (!candidate.isFileURL || !reference.isFileURL) return NO;
  NSNumber *directory = nil, *symlink = nil;
  if (![candidate getResourceValue:&directory forKey:NSURLIsDirectoryKey error:nil] ||
      !directory.boolValue ||
      ![candidate getResourceValue:&symlink forKey:NSURLIsSymbolicLinkKey error:nil] ||
      symlink.boolValue) return NO;
  NSData *info = [NSData dataWithContentsOfURL:
      [reference URLByAppendingPathComponent:@"Contents/Info.plist"]];
  NSData *otherInfo = [NSData dataWithContentsOfURL:
      [candidate URLByAppendingPathComponent:@"Contents/Info.plist"]];
  if (!info.length || ![info isEqualToData:otherInfo]) return NO;
  NSDictionary *plist = [NSPropertyListSerialization propertyListWithData:info
      options:NSPropertyListImmutable format:nil error:nil];
  NSString *executable = [plist isKindOfClass:NSDictionary.class] ? plist[@"CFBundleExecutable"] : nil;
  if (![executable isKindOfClass:NSString.class] || !executable.length ||
      ![executable.lastPathComponent isEqualToString:executable]) return NO;
  NSString *relative = [@"Contents/MacOS" stringByAppendingPathComponent:executable];
  NSData *binary = [NSData dataWithContentsOfURL:[reference URLByAppendingPathComponent:relative]];
  NSData *otherBinary = [NSData dataWithContentsOfURL:[candidate URLByAppendingPathComponent:relative]];
  if (!binary.length || ![binary isEqualToData:otherBinary]) return NO;
  // Matching executable bytes bind both architectures and their sealed resource
  // hashes. Validate the candidate's actual resources, including nested payloads.
  SecStaticCodeRef code = nullptr;
  OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)candidate,
      kSecCSDefaultFlags, &code);
  if (status == errSecSuccess)
    status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckNestedCode, nullptr);
  if (code) CFRelease(code);
  return status == errSecSuccess;
}

static NSURL *NMResolvePersistentApplicationURL(NSURL *running, NSArray<NSURL *> *candidates) {
  NSURL *resolvedRunning = running.URLByResolvingSymlinksInPath.URLByStandardizingPath;
  if (!NMIsTemporaryApplicationURL(resolvedRunning)) return resolvedRunning;
  NSURL *found = nil;
  for (NSURL *url in candidates) {
    NSURL *resolved = url.URLByResolvingSymlinksInPath.URLByStandardizingPath;
    if (NMIsTemporaryApplicationURL(resolved) || !NMApplicationBundlesMatch(url, running)) continue;
    if (found && ![found.path isEqualToString:resolved.path]) return nil;
    found = resolved;
  }
  return found;
}

static NSURL *NMPersistentApplicationURL(NSBundle *bundle, NSArray<NSString *> *arguments) {
  NSUInteger index = [arguments indexOfObject:@"--installed-app-path"];
  if (index != NSNotFound && index + 1 < arguments.count) {
    NSString *path = arguments[index + 1];
    if (path.isAbsolutePath) {
      NSURL *found = NMResolvePersistentApplicationURL(bundle.bundleURL,
          @[[NSURL fileURLWithPath:path isDirectory:YES]]);
      if (found) return found;
    }
  }
  NSString *name = bundle.infoDictionary[@"NiuMaInstallName"];
  if (![name isKindOfClass:NSString.class] || ![name.pathExtension isEqualToString:@"app"] ||
      ![name.lastPathComponent isEqualToString:name] || [name hasPrefix:@"."])
    name = @"牛马电子功德.app";
  return NMResolvePersistentApplicationURL(bundle.bundleURL, @[
      [NSURL fileURLWithPath:[@"/Applications" stringByAppendingPathComponent:name] isDirectory:YES],
      [NSURL fileURLWithPath:[[NSHomeDirectory() stringByAppendingPathComponent:@"Applications"]
          stringByAppendingPathComponent:name] isDirectory:YES]]);
}

static NSURL *NMInstallerDiskImageVolume(NSURL *installer, NSDictionary *diskInfo) {
  // In a translocation mount NSURLVolumeURLKey points at the temporary mount,
  // so identify the original DMG by a unique, signature-validated bundle match.
  // Never select a physical disk, an unrelated version, or an ambiguous copy.
  NSURL *found = nil;
  for (NSDictionary *image in diskInfo[@"images"]) {
    if (![image isKindOfClass:NSDictionary.class] ||
        ![[image[@"image-path"] lowercaseString] hasSuffix:@".dmg"]) continue;
    for (NSDictionary *entity in image[@"system-entities"]) {
      NSString *path = entity[@"mount-point"];
      if (![path isKindOfClass:NSString.class] || ![path hasPrefix:@"/Volumes/"]) continue;
      NSURL *volume = [NSURL fileURLWithPath:path isDirectory:YES];
      NSURL *candidate = [volume URLByAppendingPathComponent:installer.lastPathComponent];
      if (!NMApplicationBundlesMatch(candidate, installer)) continue;
      if (found && ![found.path isEqualToString:volume.path]) return nil;
      found = volume;
    }
  }
  return found;
}

static BOOL NMEjectDiskImageAfterExit(NSURL *volume, pid_t parentPID) {
  if (![volume.path hasPrefix:@"/Volumes/"] || parentPID <= 0) return NO;
  NSTask *helper = [[NSTask alloc] init]; helper.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
  helper.arguments = @[@"-c", @"i=0; while kill -0 \"$2\" 2>/dev/null && [ \"$i\" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; i=0; while [ \"$i\" -lt 5 ]; do /usr/bin/hdiutil detach \"$1\" >/dev/null 2>&1 && exit 0; sleep 1; i=$((i+1)); done; exit 1",
      @"niuma-installer-eject", volume.path, [NSString stringWithFormat:@"%d", parentPID]];
  helper.standardOutput = NSFileHandle.fileHandleWithNullDevice;
  helper.standardError = NSFileHandle.fileHandleWithNullDevice;
  return [helper launchAndReturnError:nil];
}
