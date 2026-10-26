#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_ROOT="${NIUMA_MAC_TEST_ROOT:-$ROOT/.local-work/acceptance/macos-smoke}"
PRODUCT_APP="${NIUMA_MAC_TEST_APP:-$ROOT/dist/牛马电子功德.app}"
TEST_APP="$TEST_ROOT/Acceptance.app"
mkdir -p "$TEST_ROOT/zh" "$TEST_ROOT/en"
rm -rf "$TEST_APP"
mkdir -p "$TEST_APP/Contents/MacOS" "$TEST_APP/Contents/Resources"
cp "$PRODUCT_APP/Contents/Resources/"*.png "$TEST_APP/Contents/Resources/"
xcrun clang++ -std=c++17 -O2 -fobjc-arc -mmacosx-version-min=10.15 \
  "$ROOT/scripts/test-macos.mm" -framework QuartzCore -framework AppKit -framework ApplicationServices \
  -framework Security -framework ServiceManagement \
  -o "$TEST_APP/Contents/MacOS/Acceptance"
NIUMA_MAC_ACCEPTANCE_OUTPUT="$TEST_ROOT/zh" NIUMA_UI_LANGUAGE=zh "$TEST_APP/Contents/MacOS/Acceptance"
NIUMA_MAC_ACCEPTANCE_OUTPUT="$TEST_ROOT/en" NIUMA_UI_LANGUAGE=en "$TEST_APP/Contents/MacOS/Acceptance"
"$ROOT/scripts/audit-offline.sh"
