#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_APP="$ROOT/dist/.build-mac/Acceptance.app"
rm -rf "$TEST_APP"
mkdir -p "$TEST_APP/Contents/MacOS" "$TEST_APP/Contents/Resources"
cp "$ROOT/dist/牛马电子功德.app/Contents/Resources/"*.png "$TEST_APP/Contents/Resources/"
xcrun clang++ -std=c++17 -O2 -fobjc-arc -mmacosx-version-min=10.15 \
  "$ROOT/scripts/test-macos.mm" -framework AppKit -framework ApplicationServices \
  -framework Security \
  -o "$TEST_APP/Contents/MacOS/Acceptance"
NIUMA_UI_LANGUAGE=zh "$TEST_APP/Contents/MacOS/Acceptance"
NIUMA_UI_LANGUAGE=en "$TEST_APP/Contents/MacOS/Acceptance"
"$ROOT/scripts/audit-offline.sh"
