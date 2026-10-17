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
  if [[ -n "${observer_pid:-}" ]] && kill -0 "$observer_pid" 2>/dev/null; then
    kill -TERM "$observer_pid" 2>/dev/null || true
    wait "$observer_pid" 2>/dev/null || true
  fi
  if [[ -n "${preview_pid:-}" ]] && kill -0 "$preview_pid" 2>/dev/null; then
    kill -TERM "$preview_pid" 2>/dev/null || true
    wait "$preview_pid" 2>/dev/null || true
  fi
  rm -rf "$acceptance_root"
}
trap cleanup EXIT

"$binary_path" --isolated-acceptance --reminder-ui-preview &
preview_pid=$!
python3 "$(dirname "$0")/check-runtime-network.py" --pid "$preview_pid" \
  --duration 7 --report "${screenshot_path%.png}-network.json" &
observer_pid=$!
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
sleep 6
kill -0 "$preview_pid" 2>/dev/null || { echo "The app exited before auto-dismissal could be checked." >&2; exit 1; }
screencapture -x "${screenshot_path%.png}-dismissed.png"
wait "$observer_pid"
observer_pid=
wait "$preview_pid"
python3 - "$acceptance_root/NiuMaMerit/Reminders/state.dat" <<'PY_CHECK'
import pathlib,re,sys
text=pathlib.Path(sys.argv[1]).read_text()
assert re.search(r"^daily\t[0-9]{4}-[0-9]{2}-[0-9]{2}\t1$", text, re.M), "daily quota changed"
assert re.search(r"^segment\t1$", text, re.M), "segment lock cleared"
assert len(re.findall(r"^id\t", text, re.M)) == 1, "ID history changed"
print("MACOS_REMINDER_UI_LEDGER_PASSED quota=1 history=1")
PY_CHECK
preview_pid=
echo "MACOS_REMINDER_UI_PREVIEW_PASSED"
