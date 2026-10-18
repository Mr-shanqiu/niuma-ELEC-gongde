#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLIENT_APP=${1:?Supply the signed client app}
OUTPUT_DIR=${2:?Supply a new installer output directory}
APP_PATH="$OUTPUT_DIR/安装牛马电子功德.app"
if [ -e "$APP_PATH" ]; then
  echo "Installer output already exists; not overwritten" >&2
  exit 2
fi
codesign --verify --deep --strict "$CLIENT_APP"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources/Payload" "$OUTPUT_DIR/build"
ditto "$CLIENT_APP" "$APP_PATH/Contents/Resources/Payload/牛马电子功德.app"
cp "$ROOT_DIR/assets/appicon.icns" "$APP_PATH/Contents/Resources/appicon.icns"
for ARCH in arm64 x86_64; do
  xcrun clang++ -std=c++17 -O2 -fobjc-arc -mmacosx-version-min=10.15 -arch "$ARCH" \
    "$ROOT_DIR/installer/macos/install.mm" -framework AppKit -framework Security \
    -o "$OUTPUT_DIR/build/installer-$ARCH"
done
lipo -create "$OUTPUT_DIR/build/installer-arm64" "$OUTPUT_DIR/build/installer-x86_64" \
  -output "$APP_PATH/Contents/MacOS/niuma-installer"
python3 - "$APP_PATH" "$CLIENT_APP" <<'PY'
from pathlib import Path
import sys, plistlib
app, client = map(Path, sys.argv[1:])
size = sum(p.stat().st_size for p in client.rglob('*') if p.is_file())
info = {
    'CFBundleIdentifier': 'cn.niuma.merit.installer',
    'CFBundleName': '安装牛马电子功德',
    'CFBundleDisplayName': '安装牛马电子功德 · R6',
    'CFBundleExecutable': 'niuma-installer',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '0.9.4',
    'CFBundleVersion': '094.6',
    'CFBundleIconFile': 'appicon',
    'LSMinimumSystemVersion': '10.15',
    'NSHighResolutionCapable': True,
    'NiuMaInstalledBytes': size,
}
(app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
PY
codesign --verify --deep --strict "$APP_PATH/Contents/Resources/Payload/牛马电子功德.app"
codesign --force --sign "${NIUMA_CODESIGN_IDENTITY:--}" --options runtime --timestamp=none "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
echo "INSTALLER_APP=$APP_PATH"
