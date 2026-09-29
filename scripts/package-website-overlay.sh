#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist/gongde-deploy"
BASE=${1:?usage: package-website-overlay.sh BASE_ARCHIVE}
case "$BASE" in
  "$OUT"/gongde-site-*.tar.gz) ;;
  *) echo "Base must be a local gongde-site archive" >&2; exit 64 ;;
esac
test -f "$BASE" && test -f "$BASE.sha256"
EXPECTED=$(awk 'NR == 1 { print $1 }' "$BASE.sha256")
ACTUAL=$(shasum -a 256 "$BASE" | awk '{ print $1 }')
test "$EXPECTED" = "$ACTUAL"

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/gongde-overlay.XXXXXX")
cleanup() { find "$STAGE" -xdev -depth -delete 2>/dev/null || true; }
trap cleanup EXIT INT TERM
tar -xzf "$BASE" -C "$STAGE"
if find "$STAGE" -type l | grep -q .; then
  echo "Base contains a symbolic link" >&2
  exit 65
fi

for name in index.html app.js styles.css install.html; do
  test -f "$STAGE/$name" && test -f "$ROOT/website/$name"
  cp "$ROOT/website/$name" "$STAGE/$name"
done

TREE_SHA=$(
  cd "$STAGE"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | awk '{ print $1 }'
)
ARCHIVE="$OUT/gongde-site-$TREE_SHA.tar.gz"
if test -e "$ARCHIVE"; then
  echo "Archive already exists; refusing to overwrite an immutable release" >&2
  exit 65
fi
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ARCHIVE" .
(cd "$OUT" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
SIZE=$(stat -f '%z' "$ARCHIVE")
if test "$SIZE" -gt 20971520; then
  echo "Archive exceeds the 20MiB static deployment limit" >&2
  exit 65
fi

printf 'BASE_ARCHIVE=%s\n' "$BASE"
printf 'OVERLAY_FILES=index.html,app.js,styles.css,install.html\n'
printf 'SITE_ARCHIVE=%s\n' "$ARCHIVE"
printf 'SITE_TREE_SHA256=%s\n' "$TREE_SHA"
printf 'SITE_ARCHIVE_SHA256=%s\n' "$(awk 'NR == 1 { print $1 }' "$ARCHIVE.sha256")"
printf 'SITE_ARCHIVE_BYTES=%s\n' "$SIZE"
