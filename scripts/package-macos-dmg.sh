#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUTPUT_DIR=${1:-"$ROOT_DIR/dist"}
APP_NAME="牛马电子功德.app"
APP_PATH="$OUTPUT_DIR/$APP_NAME"
VERSION=$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")
DMG_PATH="$OUTPUT_DIR/niuma-merit-macos-demo-$VERSION.dmg"
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/niuma-merit-dmg.XXXXXX")

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

"$ROOT_DIR/scripts/build-macos.sh" "$OUTPUT_DIR"

cp -R "$APP_PATH" "$STAGING_DIR/$APP_NAME"
ln -s /Applications "$STAGING_DIR/Applications"

rm -f "$DMG_PATH"
hdiutil create \
  -volname "牛马电子功德" \
  -srcfolder "$STAGING_DIR" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$DMG_PATH"

hdiutil verify "$DMG_PATH"

echo "DMG=$DMG_PATH"
echo "DMG_BYTES=$(stat -f%z "$DMG_PATH")"
echo "DEMO_DMG_DONE"
