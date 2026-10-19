#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
API_BASE=${1:?API base archive required}
SITE_BASE=${2:?Site base archive required}
case "$API_BASE" in "$ROOT"/dist/gongde-api-deploy/gongde-api-*.tar.gz) ;; *) exit 64 ;; esac
case "$SITE_BASE" in "$ROOT"/dist/gongde-deploy/gongde-site-*.tar.gz) ;; *) exit 64 ;; esac
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/gongde-pricing.XXXXXX")
trap 'find "$STAGE" -xdev -depth -delete 2>/dev/null || true' EXIT
for BASE in "$API_BASE" "$SITE_BASE"; do
  test -f "$BASE.sha256"
  test "$(shasum -a 256 "$BASE" | awk '{print $1}')" = "$(awk 'NR==1{print $1}' "$BASE.sha256")"
done
mkdir "$STAGE/api" "$STAGE/site"
tar -xzf "$API_BASE" -C "$STAGE/api"
tar -xzf "$SITE_BASE" -C "$STAGE/site"
for FILE in domain/types.ts domain/catalog.ts domain/order-service.ts server.ts delivery/private-package-store.ts; do
  cp "$ROOT/services/gongde-payments/src/$FILE" "$STAGE/api/gongde-payments/src/$FILE"
done
for FILE in index.html app.js checkout.html checkout.js install.html faq.html privacy.html; do
  cp "$ROOT/website/$FILE" "$STAGE/site/$FILE"
done
test -f "$ROOT/website/admin/index.html"
find "$STAGE/site/admin" -xdev -depth -delete
cp -R "$ROOT/website/admin" "$STAGE/site/admin"
if find "$STAGE" -type l | grep -q .; then echo 'Refusing symlinks' >&2; exit 65; fi
if find "$STAGE" -type f \( -name '.env' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then echo 'Refusing secret-like files' >&2; exit 65; fi
API_TEMP="$STAGE/api.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGE/api" -czf "$API_TEMP" gongde-payments
API_SHA=$(shasum -a 256 "$API_TEMP" | awk '{print $1}')
API_OUT="$ROOT/dist/gongde-api-deploy/gongde-api-$API_SHA.tar.gz"
test ! -e "$API_OUT"
test "$(stat -f '%z' "$API_TEMP")" -le 16777216
mv "$API_TEMP" "$API_OUT"
printf '%s  %s\n' "$API_SHA" "$(basename "$API_OUT")" > "$API_OUT.sha256"
TREE_SHA=$(cd "$STAGE/site"; find . -type f -print | LC_ALL=C sort | while IFS= read -r FILE; do shasum -a 256 "$FILE"; done | shasum -a 256 | awk '{print $1}')
SITE_OUT="$ROOT/dist/gongde-deploy/gongde-site-$TREE_SHA.tar.gz"
test ! -e "$SITE_OUT"
COPYFILE_DISABLE=1 tar -C "$STAGE/site" -czf "$SITE_OUT" .
test "$(stat -f '%z' "$SITE_OUT")" -le 20971520
SITE_SHA=$(shasum -a 256 "$SITE_OUT" | awk '{print $1}')
printf '%s  %s\n' "$SITE_SHA" "$(basename "$SITE_OUT")" > "$SITE_OUT.sha256"
printf 'API_ARCHIVE=%s\nAPI_SHA256=%s\nSITE_ARCHIVE=%s\nSITE_SHA256=%s\nSITE_TREE_SHA256=%s\n' "$API_OUT" "$API_SHA" "$SITE_OUT" "$SITE_SHA" "$TREE_SHA"
printf 'api_base=%s\nsite_base=%s\nchanges=pricing source whitelist and freshly built admin only\n' "$API_BASE" "$SITE_BASE" > "$SITE_OUT.metadata.txt"
