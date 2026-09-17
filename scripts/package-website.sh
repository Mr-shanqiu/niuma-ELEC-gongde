#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SITE_DIR="$ROOT_DIR/website"
OUT_DIR="$ROOT_DIR/dist/gongde-deploy"
DOWNLOAD_DIR="$OUT_DIR/downloads"
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gongde-site.XXXXXX")
SITE_STAGE="$STAGING_DIR/site"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

NODE_BIN=${NODE_BIN:-node}
"$NODE_BIN" "$ROOT_DIR/scripts/generate-website-previews.mjs"

mkdir -p "$SITE_STAGE/assets" "$DOWNLOAD_DIR"

for file in index.html install.html app.js styles.css healthz.txt privacy.html contact.html 404.html robots.txt; do
  cp "$SITE_DIR/$file" "$SITE_STAGE/$file"
done
cp -R "$SITE_DIR/assets/." "$SITE_STAGE/assets/"

if find "$SITE_STAGE" -type l | grep -q .; then
  echo "ERROR: site artifact contains a symbolic link" >&2
  exit 1
fi

if find "$SITE_STAGE" -type f \( -name '.env' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "ERROR: site artifact contains a forbidden secret-like file" >&2
  exit 1
fi

if grep -R -n -E '127\.0\.0\.1|localhost|/Users/|/home/' "$SITE_STAGE"; then
  echo "ERROR: site artifact contains a local or absolute path" >&2
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
tar -C "$SITE_STAGE" -czf "$ARCHIVE_PATH" .
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
node_version=not-applicable-static-site
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

cp "$ROOT_DIR/dist/niuma-merit-macos-0.7.0.dmg" "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.dmg"
cp "$ROOT_DIR/dist/niuma-merit-macos-0.7.0.zip" "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.zip"
cp "$ROOT_DIR/dist/windows-0.7.0-main-35195142968/niuma-merit-windows-0.7.0-Release.zip" "$DOWNLOAD_DIR/niuma-merit-windows-0.7.0.zip"
rm -f "$DOWNLOAD_DIR/chick-pecking-free.nmgpack"

(
  cd "$DOWNLOAD_DIR"
  shasum -a 256 \
    niuma-merit-macos-0.7.0.dmg \
    niuma-merit-macos-0.7.0.zip \
    niuma-merit-windows-0.7.0.zip > SHA256SUMS.txt
)

MAC_DMG_BYTES=$(stat -f '%z' "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.dmg")
MAC_ZIP_BYTES=$(stat -f '%z' "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.zip")
WIN_ZIP_BYTES=$(stat -f '%z' "$DOWNLOAD_DIR/niuma-merit-windows-0.7.0.zip")
MAC_DMG_SHA=$(shasum -a 256 "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.dmg" | awk '{print $1}')
MAC_ZIP_SHA=$(shasum -a 256 "$DOWNLOAD_DIR/niuma-merit-macos-0.7.0.zip" | awk '{print $1}')
WIN_ZIP_SHA=$(shasum -a 256 "$DOWNLOAD_DIR/niuma-merit-windows-0.7.0.zip" | awk '{print $1}')

cat > "$DOWNLOAD_DIR/DOWNLOADS.json" <<EOF
{
  "baseUrl": "https://download.gongde.zqscreen.cn/",
  "generatedAt": "$BUILD_TIME",
  "files": [
    {"name":"niuma-merit-macos-0.7.0.dmg","type":"application/x-apple-diskimage","platform":"macOS","architecture":"universal2-arm64-x86_64","version":"0.7.0","bytes":$MAC_DMG_BYTES,"sha256":"$MAC_DMG_SHA","signature":"unsigned","notarization":"not-notarized","url":"https://download.gongde.zqscreen.cn/niuma-merit-macos-0.7.0.dmg"},
    {"name":"niuma-merit-macos-0.7.0.zip","type":"application/zip","platform":"macOS","architecture":"universal2-arm64-x86_64","version":"0.7.0","bytes":$MAC_ZIP_BYTES,"sha256":"$MAC_ZIP_SHA","signature":"unsigned","notarization":"not-notarized","url":"https://download.gongde.zqscreen.cn/niuma-merit-macos-0.7.0.zip"},
    {"name":"niuma-merit-windows-0.7.0.zip","type":"application/zip","platform":"Windows","architecture":"x86_64","version":"0.7.0","bytes":$WIN_ZIP_BYTES,"sha256":"$WIN_ZIP_SHA","signature":"unsigned","notarization":"not-applicable","url":"https://download.gongde.zqscreen.cn/niuma-merit-windows-0.7.0.zip"}
  ]
}
EOF

echo "SITE_ARCHIVE=$ARCHIVE_PATH"
echo "SITE_SHA256_FILE=$ARCHIVE_PATH.sha256"
echo "SITE_METADATA=$OUT_DIR/gongde-site-$TREE_SHA.metadata.txt"
echo "DOWNLOAD_MANIFEST=$DOWNLOAD_DIR/DOWNLOADS.json"
echo "DOWNLOAD_CHECKSUMS=$DOWNLOAD_DIR/SHA256SUMS.txt"
