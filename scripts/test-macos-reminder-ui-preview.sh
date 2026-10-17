#!/usr/bin/env bash
set -euo pipefail

app_path=${1:?Usage: test-macos-reminder-ui-preview.sh APP_PATH SCREENSHOT_PATH}
screenshot_path=${2:?Usage: test-macos-reminder-ui-preview.sh APP_PATH SCREENSHOT_PATH}
binary_path="$app_path/Contents/MacOS/niuma-merit"
[[ -x "$binary_path" ]] || { echo "Missing app executable: $binary_path" >&2; exit 2; }

acceptance_root=$(mktemp -d /private/tmp/niuma-merit-acceptance-XXXXXXXX)
chmod 700 "$acceptance_root"
export NIUMA_ACCEPTANCE_ROOT="$acceptance_root"
export NIUMA_PACK_ROOT="$acceptance_root/AppearancePacks"
cleanup() {
  if [[ -n "${preview_pid:-}" ]] && kill -0 "$preview_pid" 2>/dev/null; then
    kill -TERM "$preview_pid" 2>/dev/null || true
    wait "$preview_pid" 2>/dev/null || true
  fi
  rm -rf "$acceptance_root"
}
trap cleanup EXIT

"$binary_path" --isolated-acceptance --reminder-ui-preview &
preview_pid=$!
sleep 3
kill -0 "$preview_pid" 2>/dev/null || {
  wait "$preview_pid" || true
  echo "The isolated macOS preview exited before the screenshot." >&2
  exit 1
}

screencapture -x "$screenshot_path"
[[ -s "$screenshot_path" ]] || { echo "No macOS UI screenshot was captured." >&2; exit 1; }
dimensions=$(sips -g pixelWidth -g pixelHeight "$screenshot_path")
grep -Eq 'pixelWidth: [1-9][0-9]*' <<<"$dimensions"
grep -Eq 'pixelHeight: [1-9][0-9]*' <<<"$dimensions"
wait "$preview_pid"
preview_pid=
echo "MACOS_REMINDER_UI_PREVIEW_PASSED"
