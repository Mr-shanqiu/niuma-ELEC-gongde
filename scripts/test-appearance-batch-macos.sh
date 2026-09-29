#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/niuma-batch-test.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT INT TERM
python3 "$ROOT/scripts/appearance-pack.py" build \
  "$ROOT/assets/appearance-packs/woodfish-sample" "$TEMP/woodfish-sample.nmgpack"
python3 "$ROOT/scripts/appearance-pack.py" build \
  "$ROOT/assets/appearance-packs/lucky-cat" "$TEMP/lucky-cat.nmgpack"
(cd "$TEMP" && zip -q two-packs.nmgpacks woodfish-sample.nmgpack lucky-cat.nmgpack)
xcrun clang++ -std=c++17 -O2 -fobjc-arc -mmacosx-version-min=10.15 \
  "$ROOT/scripts/test-appearance-batch.mm" "$ROOT/src/macos/appearance_pack.mm" \
  -framework AppKit -framework ApplicationServices -framework Security \
  -o "$TEMP/test-appearance-batch"
"$TEMP/test-appearance-batch" "$TEMP/two-packs.nmgpacks" "$TEMP/installed"
