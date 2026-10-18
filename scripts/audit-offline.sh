#!/bin/sh
# Static offline & privacy boundary audit.
#
# The previous version depended on `rg`. When `rg` was missing the search
# command failed with exit code 127, but because it was used as an `if`
# condition `set -e` did not abort the script, so it printed
# OFFLINE_AUDIT_PASSED without scanning anything. This version degrades to
# grep, and treats any tool error as an audit failure.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

PATTERN='keyboardEventKeycode|charactersIgnoringModifiers|\[[^]]+[[:space:]]characters\]|CGEventGetIntegerValueField|GetForegroundWindow|GetWindowText|GetAsyncKeyState|GetKeyState|GetKeyboardState|GetCursorPos|GetCaretPos|GetGUIThreadInfo|AXUIElementCopy(AttributeValue|ParameterizedAttributeValue)|AXUIElementCreateSystemWide|->vkCode|\.vkCode|->mouseData|\.mouseData|->pt([.[:space:]]|$)|\.pt([.[:space:]]|$)|NSURLSession|WinHttp|WinInet|WSAStartup|(^|[^A-Za-z])socket[[:space:]]*\(|com\.apple\.security\.network\.(client|server)'

# Collect candidate sources. This script contains the forbidden pattern as a
# literal, so it must never be part of the scan. The two offline audit scripts
# contain forbidden patterns as self-test fixtures. The two Windows GUI
# acceptance harnesses inspect their own controlled test windows and foreground
# state; they are not client input collection. Retain all other client sources,
# build scripts, workflows and CMake in the privacy boundary scan. Low-level
# hook structure types are allowed: production code may inspect injected-event
# flags, while reads of key codes, mouse data, or pointer coordinates remain forbidden.
FILES=$(find "$ROOT_DIR/src" "$ROOT_DIR/scripts" "$ROOT_DIR/.github" \
  -type f ! -name 'audit-offline.sh' \
  ! -name 'audit-macos-offline-binary.sh' \
  ! -path "$ROOT_DIR/scripts/test-windows-installed-community-gui.ps1" \
  ! -path "$ROOT_DIR/scripts/test-windows-paid-community-gui.ps1" | sort)
FILES="$FILES
$ROOT_DIR/CMakeLists.txt"

if command -v rg >/dev/null 2>&1; then
  AUDIT_TOOL="rg"
  match_pattern() { rg -q --pcre2 "$PATTERN"; }
else
  AUDIT_TOOL="grep"
  match_pattern() { grep -qE "$PATTERN"; }
fi

# Guard against a broken or accidentally weakened expression silently passing
# because the current source tree happens to have no matches.
for probe in 'event->vkCode' 'event->pt.x' 'GetAsyncKeyState()' \
    'GetWindowText(window, title)' 'NSURLSession' 'WinHttpOpen()'; do
  if ! printf '%s\n' "$probe" | match_pattern; then
    echo "OFFLINE_AUDIT_RULE_SELF_TEST_FAILED(forbidden_probe=$probe)"
    exit 2
  fi
done
if printf '%s\n' 'KBDLLHOOKSTRUCT event->flags' | match_pattern; then
  echo "OFFLINE_AUDIT_RULE_SELF_TEST_FAILED(allowed_probe_matched)"
  exit 2
fi

if [ "$AUDIT_TOOL" = "rg" ]; then
  set +e
  # shellcheck disable=SC2086
  rg -n --pcre2 "$PATTERN" $FILES
  RESULT=$?
  set -e
else
  set +e
  # shellcheck disable=SC2086
  grep -nE "$PATTERN" $FILES
  RESULT=$?
  set -e
fi

if [ "$RESULT" -eq 0 ]; then
  echo "OFFLINE_AUDIT_FAILED"
  exit 1
fi

# A matching tool exits with 1 when nothing matched. Anything else means the
# tool itself failed, so the audit result would be meaningless.
if [ "$RESULT" -ne 1 ]; then
  echo "OFFLINE_AUDIT_TOOL_ERROR(exit=$RESULT)"
  exit 2
fi

echo "AUDIT_TOOL=$AUDIT_TOOL"
echo "OFFLINE_AUDIT_PASSED"
