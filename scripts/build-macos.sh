#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/dist"}
APP_DIR="$OUTPUT_DIR/牛马电子功德.app"
BUILD_DIR="$OUTPUT_DIR/.build-mac"
VERSION=$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")
mkdir -p "$BUILD_DIR"

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$ROOT_DIR/assets/woodfish.png" "$APP_DIR/Contents/Resources/woodfish.png"
cp "$ROOT_DIR/assets/mallet.png" "$APP_DIR/Contents/Resources/mallet.png"

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
  -o "$BUILD_DIR/niuma-merit-$ARCH"
done

lipo -create "$BUILD_DIR/niuma-merit-arm64" "$BUILD_DIR/niuma-merit-x86_64" \
  -output "$APP_DIR/Contents/MacOS/niuma-merit"

lipo -info "$APP_DIR/Contents/MacOS/niuma-merit"

sed \
  -e 's#${MACOSX_BUNDLE_EXECUTABLE_NAME}#niuma-merit#g' \
  -e "s#@PROJECT_VERSION@#$VERSION#g" \
  "$ROOT_DIR/src/macos/Info.plist.in" > "$APP_DIR/Contents/Info.plist"

codesign --force --deep --sign - --options runtime \
  "$APP_DIR"

codesign --display --entitlements - "$APP_DIR"

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
