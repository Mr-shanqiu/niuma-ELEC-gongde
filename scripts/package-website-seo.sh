#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist/gongde-deploy"
BASE=${1:?usage: package-website-seo.sh BASE_ARCHIVE}
case "$BASE" in
  "$OUT"/gongde-site-*.tar.gz) ;;
  *) printf 'Base must be an approved local gongde-site archive\n' >&2; exit 64 ;;
esac
test -f "$BASE" && test -f "$BASE.sha256"
EXPECTED=$(awk 'NR == 1 { print $1 }' "$BASE.sha256")
ACTUAL=$(shasum -a 256 "$BASE" | awk '{ print $1 }')
test "$EXPECTED" = "$ACTUAL"

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/gongde-seo.XXXXXX")
cleanup() { find "$STAGE" -xdev -depth -delete 2>/dev/null || true; }
trap cleanup EXIT INT TERM
tar -xzf "$BASE" -C "$STAGE"
if find "$STAGE" -type l | grep -q .; then
  printf 'Base contains a symbolic link\n' >&2
  exit 65
fi

# Preserve released scripts, previews, payment logic, styles and admin assets.
# Overlay only the explicitly authorized public search/content files.
for name in index.html install.html privacy.html contact.html checkout.html support.html 404.html robots.txt faq.html sitemap.xml; do
  test -f "$ROOT/website/$name" && test ! -L "$ROOT/website/$name"
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
  printf 'Archive already exists; refusing to overwrite an immutable release\n' >&2
  exit 65
fi
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ARCHIVE" .
(cd "$OUT" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
SIZE=$(stat -f '%z' "$ARCHIVE")
if test "$SIZE" -gt 20971520; then
  printf 'Archive exceeds the 20MiB static deployment limit\n' >&2
  exit 65
fi
ARCHIVE_SHA=$(awk 'NR == 1 { print $1 }' "$ARCHIVE.sha256")
{
  printf 'BASE_ARCHIVE=%s\n' "$BASE"
  printf 'OVERLAY_FILES=index.html,install.html,privacy.html,contact.html,checkout.html,support.html,404.html,robots.txt,faq.html,sitemap.xml\n'
  printf 'SITE_ARCHIVE=%s\nSITE_TREE_SHA256=%s\nSITE_ARCHIVE_SHA256=%s\nSITE_ARCHIVE_BYTES=%s\n' "$ARCHIVE" "$TREE_SHA" "$ARCHIVE_SHA" "$SIZE"
} | tee "$ARCHIVE.metadata.txt"
