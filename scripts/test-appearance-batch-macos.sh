#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
WORK="$ROOT/.local-work/acceptance/perpetual-license"
mkdir -p "$WORK"
TEMP=$(mktemp -d "$WORK/legacy-batch.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT INT TERM
cd "$ROOT"

# Reuse the bounded signature-protocol fixtures, not unsigned platform sources.
# Positive batches carry valid independent P-256 signatures in an isolated test
# trust copy. The unchanged production importer separately checks the frozen real
# historical file and rejects the ephemeral signer. No product anchor is changed.
SERVICE="$ROOT/services/gongde-payments"
mkdir -p "$TEMP/build"
printf '{"type":"module"}\n' > "$TEMP/build/package.json"
ln -s "$SERVICE/node_modules" "$TEMP/build/node_modules"
"$SERVICE/node_modules/.bin/tsc" --target ES2022 --module ESNext \
  --moduleResolution bundler --strict --esModuleInterop --skipLibCheck \
  --types node --typeRoots "$SERVICE/node_modules/@types" \
  --rootDir "$SERVICE/src" --outDir "$TEMP/build" \
  "$SERVICE/src/delivery/pack-signer.ts"
GONGDE_TEST_BUILD_ROOT="$TEMP/build" GONGDE_NATIVE_LICENSE_TEST=1 \
  node --test --test-name-pattern 'macOS native importer and Python tool agree' \
  "$SERVICE/tests/pack-signer-perpetual.test.mjs"
