#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SOURCE_DIR="$ROOT_DIR/services/gongde-payments"
OUT_DIR="$ROOT_DIR/dist/gongde-api-deploy"
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gongde-api.XXXXXX")
PACKAGE_DIR="$STAGING_DIR/gongde-payments"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$PACKAGE_DIR" "$OUT_DIR"
cp "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/tsconfig.json" "$PACKAGE_DIR/"
cp -R "$SOURCE_DIR/src" "$SOURCE_DIR/scripts" "$SOURCE_DIR/migrations" "$PACKAGE_DIR/"

if find "$PACKAGE_DIR" -type l | grep -q .; then
  echo "ERROR: API artifact contains a symbolic link" >&2
  exit 1
fi

if find "$PACKAGE_DIR" -type f \( -name '.env' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "ERROR: API artifact contains a forbidden secret-like file" >&2
  exit 1
fi

if grep -R -n -E '/Users/|/home/' "$PACKAGE_DIR"; then
  echo "ERROR: API artifact contains a local absolute path" >&2
  exit 1
fi

TEMP_ARCHIVE="$OUT_DIR/.gongde-api-package.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGING_DIR" -czf "$TEMP_ARCHIVE" gongde-payments
ARCHIVE_SHA=$(shasum -a 256 "$TEMP_ARCHIVE" | awk '{print $1}')
ARCHIVE_PATH="$OUT_DIR/gongde-api-$ARCHIVE_SHA.tar.gz"
mv "$TEMP_ARCHIVE" "$ARCHIVE_PATH"
printf '%s  %s\n' "$ARCHIVE_SHA" "$(basename "$ARCHIVE_PATH")" > "$ARCHIVE_PATH.sha256"

echo "API_ARCHIVE=$ARCHIVE_PATH"
echo "API_SHA256=$ARCHIVE_SHA"
