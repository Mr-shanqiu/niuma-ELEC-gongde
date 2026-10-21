#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SITE_DIR="$ROOT_DIR/website"
OUT_DIR="$ROOT_DIR/dist/gongde-deploy"
DOWNLOAD_DIR="$OUT_DIR/downloads"
VERSION=$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")
SITE_ONLY=false
case "${1:-}" in
  "") ;;
  --site-only) SITE_ONLY=true ;;
  *) echo "Usage: package-website.sh [--site-only]" >&2; exit 64 ;;
esac
mkdir -p "$ROOT_DIR/.local-work/candidates"
STAGING_DIR=$(mktemp -d "$ROOT_DIR/.local-work/candidates/gongde-site.XXXXXX")
SITE_STAGE="$STAGING_DIR/site"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

NODE_BIN=${NODE_BIN:-node}
if [ "$SITE_ONLY" = false ]; then
  "$NODE_BIN" "$ROOT_DIR/scripts/generate-website-previews.mjs"
fi
(cd "$ROOT_DIR/admin-console" && npm run build)

mkdir -p "$SITE_STAGE/assets" "$OUT_DIR"

# Publish every root-level entry point, script and stylesheet. An explicit list
# silently drifts: a file added to website/ but not listed here 404s in
# production, and one missing ES module import takes the whole page down.
for file in "$SITE_DIR"/*.html "$SITE_DIR"/*.js "$SITE_DIR"/*.css \
            "$SITE_DIR"/healthz.txt "$SITE_DIR"/robots.txt "$SITE_DIR"/sitemap.xml; do
  test -f "$file" || continue
  cp "$file" "$SITE_STAGE/"
done
cp -R "$SITE_DIR/assets/." "$SITE_STAGE/assets/"
cp -R "$ROOT_DIR/admin-console/dist" "$SITE_STAGE/admin"

"$NODE_BIN" "$ROOT_DIR/scripts/version-website-assets.mjs" "$SITE_STAGE" "${GONGDE_PREVIOUS_SITE_ARCHIVE:-}"
"$NODE_BIN" "$ROOT_DIR/scripts/verify-website-references.mjs" "$SITE_STAGE"

if find "$SITE_STAGE" -type l | grep -q .; then
  echo "ERROR: site artifact contains a symbolic link" >&2
  exit 1
fi

if find "$SITE_STAGE" -type f \( -name '.env' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "ERROR: site artifact contains a forbidden secret-like file" >&2
  exit 1
fi

if find "$SITE_STAGE" -type f ! -path "$SITE_STAGE/admin/assets/*" -exec grep -n -E '127\.0\.0\.1|localhost|/Users/|/home/' {} +; then
  echo "ERROR: site artifact contains a local or absolute path" >&2
  exit 1
fi
if grep -R -n -E '127\.0\.0\.1|localhost|/Users/|/home/' "$ROOT_DIR/admin-console/src" "$ROOT_DIR/admin-console/index.html"; then
  echo "ERROR: admin source contains a local or absolute path" >&2
  exit 1
fi

TREE_SHA=$(
  cd "$SITE_STAGE"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | awk '{print $1}'
)

ARCHIVE_NAME="gongde-site-$TREE_SHA.tar.gz"
ARCHIVE_PATH="$OUT_DIR/$ARCHIVE_NAME"
COPYFILE_DISABLE=1 tar -C "$SITE_STAGE" -czf "$ARCHIVE_PATH" .
(cd "$OUT_DIR" && shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256")

SOURCE_FULL_SHA=${SOURCE_FULL_SHA:-unavailable}
SOURCE_TREE_SHA=${SOURCE_TREE_SHA:-unavailable}
BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
FILE_COUNT=$(find "$SITE_STAGE" -type f | wc -l | tr -d ' ')
TOTAL_BYTES=$(find "$SITE_STAGE" -type f -exec stat -f '%z' {} \; | awk '{sum += $1} END {print sum + 0}')

cat > "$OUT_DIR/gongde-site-$TREE_SHA.metadata.txt" <<EOF
artifact=$ARCHIVE_NAME
artifact_tree_sha256=$TREE_SHA
source_full_sha=$SOURCE_FULL_SHA
source_tree_sha=$SOURCE_TREE_SHA
build_command=./scripts/package-website.sh
node_version=$($NODE_BIN --version)
build_time_utc=$BUILD_TIME
file_count=$FILE_COUNT
uncompressed_total_bytes=$TOTAL_BYTES
domain=gongde.zqscreen.cn
container_port=8080
cpu_limit=0.10
memory_limit=64MiB
read_only_filesystem_compatible=yes
spa_fallback_paths=none
EOF

echo "SITE_ARCHIVE=$ARCHIVE_PATH"
echo "SITE_SHA256_FILE=$ARCHIVE_PATH.sha256"
echo "SITE_METADATA=$OUT_DIR/gongde-site-$TREE_SHA.metadata.txt"
if [ "$SITE_ONLY" = true ]; then
  exit 0
fi
rm -rf "$DOWNLOAD_DIR"
mkdir -p "$DOWNLOAD_DIR"

MAC_DMG="niuma-merit-macos-$VERSION.dmg"
WIN_SETUP="niuma-merit-windows-$VERSION-setup.exe"

cp "$ROOT_DIR/dist/$MAC_DMG" "$DOWNLOAD_DIR/$MAC_DMG"
cp "$ROOT_DIR/dist/$WIN_SETUP" "$DOWNLOAD_DIR/$WIN_SETUP"

(
  cd "$DOWNLOAD_DIR"
  shasum -a 256 \
    "$MAC_DMG" \
    "$WIN_SETUP" > SHA256SUMS.txt
)

MAC_DMG_BYTES=$(stat -f '%z' "$DOWNLOAD_DIR/$MAC_DMG")
WIN_SETUP_BYTES=$(stat -f '%z' "$DOWNLOAD_DIR/$WIN_SETUP")
MAC_DMG_SHA=$(shasum -a 256 "$DOWNLOAD_DIR/$MAC_DMG" | awk '{print $1}')
WIN_SETUP_SHA=$(shasum -a 256 "$DOWNLOAD_DIR/$WIN_SETUP" | awk '{print $1}')

cat > "$DOWNLOAD_DIR/DOWNLOADS.json" <<EOF
{
  "baseUrl": "https://download.gongde.zqscreen.cn/",
  "generatedAt": "$BUILD_TIME",
  "files": [
    {"name":"$MAC_DMG","type":"application/x-apple-diskimage","platform":"macOS","architecture":"universal2-arm64-x86_64","version":"$VERSION","bytes":$MAC_DMG_BYTES,"sha256":"$MAC_DMG_SHA","signature":"unsigned","notarization":"not-notarized","url":"https://download.gongde.zqscreen.cn/$MAC_DMG"},
    {"name":"$WIN_SETUP","type":"application/vnd.microsoft.portable-executable","platform":"Windows","architecture":"x86_64","version":"$VERSION","bytes":$WIN_SETUP_BYTES,"sha256":"$WIN_SETUP_SHA","signature":"unsigned","notarization":"not-applicable","url":"https://download.gongde.zqscreen.cn/$WIN_SETUP"}
  ]
}
EOF

echo "DOWNLOAD_MANIFEST=$DOWNLOAD_DIR/DOWNLOADS.json"
echo "DOWNLOAD_CHECKSUMS=$DOWNLOAD_DIR/SHA256SUMS.txt"
