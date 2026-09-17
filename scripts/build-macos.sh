#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/dist"}
APP_DIR="$OUTPUT_DIR/牛马电子功德.app"
BUILD_DIR="$OUTPUT_DIR/.build-mac"
VERSION=$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")
mkdir -p "$BUILD_DIR"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" \
  "$APP_DIR/Contents/Resources/en.lproj" \
  "$APP_DIR/Contents/Resources/zh-Hans.lproj" \
  "$APP_DIR/Contents/Resources/zh-Hant.lproj"
cp "$ROOT_DIR/assets/woodfish.png" "$APP_DIR/Contents/Resources/woodfish.png"
cp "$ROOT_DIR/assets/mallet.png" "$APP_DIR/Contents/Resources/mallet.png"
cp "$ROOT_DIR/assets/appicon.icns" "$APP_DIR/Contents/Resources/appicon.icns"
cp "$ROOT_DIR/src/macos/en.lproj/InfoPlist.strings" \
  "$APP_DIR/Contents/Resources/en.lproj/InfoPlist.strings"
cp "$ROOT_DIR/src/macos/zh-Hans.lproj/InfoPlist.strings" \
  "$APP_DIR/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
cp "$ROOT_DIR/src/macos/zh-Hant.lproj/InfoPlist.strings" \
  "$APP_DIR/Contents/Resources/zh-Hant.lproj/InfoPlist.strings"

ARCHS="arm64 x86_64"
for ARCH in $ARCHS; do
  xcrun clang++ \
  -std=c++17 \
  -O2 \
  -fobjc-arc \
  -mmacosx-version-min=10.15 \
  -arch "$ARCH" \
  -I "$ROOT_DIR/src" \
  "$ROOT_DIR/src/macos/app.mm" \
    -framework AppKit \
    -framework ApplicationServices \
    -framework Security \
  -o "$BUILD_DIR/niuma-merit-$ARCH"
done

lipo -create "$BUILD_DIR/niuma-merit-arm64" "$BUILD_DIR/niuma-merit-x86_64" \
  -output "$APP_DIR/Contents/MacOS/niuma-merit"

lipo -info "$APP_DIR/Contents/MacOS/niuma-merit"

sed \
  -e 's#${MACOSX_BUNDLE_EXECUTABLE_NAME}#niuma-merit#g' \
  -e "s#@PROJECT_VERSION@#$VERSION#g" \
  "$ROOT_DIR/src/macos/Info.plist.in" > "$APP_DIR/Contents/Info.plist"

SIGNING_IDENTITY="${NIUMA_CODESIGN_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | \
    awk '/"Apple Development:/{print $2; exit}')"
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  if [[ "${NIUMA_ALLOW_ADHOC_SIGNING:-0}" == "1" ]]; then
    SIGNING_IDENTITY="-"
    echo "WARNING: using explicitly requested ad-hoc signing" >&2
  else
    echo "No stable macOS code-signing identity found." >&2
    echo "Set NIUMA_CODESIGN_IDENTITY, or explicitly set NIUMA_ALLOW_ADHOC_SIGNING=1 for disposable builds." >&2
    exit 1
  fi
fi

codesign --force --deep --sign "$SIGNING_IDENTITY" --options runtime --timestamp=none \
  "$APP_DIR"

codesign --display --entitlements - "$APP_DIR"
echo "SIGNING_IDENTITY=$SIGNING_IDENTITY"
codesign --display --requirements - "$APP_DIR" 2>&1 | sed 's/^/CODE_REQUIREMENT=/'

ZIP_PATH="$OUTPUT_DIR/niuma-merit-macos-$VERSION.zip"
rm -f "$ZIP_PATH"
cd "$OUTPUT_DIR"
zip -9 -r "niuma-merit-macos-$VERSION.zip" "牛马电子功德.app" >/dev/null
cd "$ROOT_DIR"
echo "APP=$APP_DIR"
echo "ZIP=$ZIP_PATH"
echo "BINARY_BYTES=$(stat -f%z "$APP_DIR/Contents/MacOS/niuma-merit")"
echo "APP_KB=$(du -sk "$APP_DIR" | awk '{print $1}')"
echo "ZIP_BYTES=$(stat -f%z "$ZIP_PATH")"
echo "DONE"

# Paid appearance packs are signed and delivered only by the server. The base
# build must never emit an unsigned copy that bypasses the purchase flow.
NM_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NM_BASE_ZIP="$ZIP_PATH"
if [[ ! -f "$NM_BASE_ZIP" ]]; then
  echo "No base application ZIP found" >&2
  exit 1
fi
NM_BASE_BYTES="$(stat -f%z "$NM_BASE_ZIP")"
echo "BASE_APP_ZIP_BYTES=$NM_BASE_BYTES"
if (( NM_BASE_BYTES > 10485760 )); then
  echo "Base application ZIP exceeds the 10MB limit" >&2
  exit 1
fi
