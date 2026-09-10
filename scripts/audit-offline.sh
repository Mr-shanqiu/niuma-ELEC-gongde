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

PATTERN='keyboardEventKeycode|characters|CGEventGetIntegerValueField|GetForegroundWindow|GetWindowText|MSLLHOOKSTRUCT|KBDLLHOOKSTRUCT|NSURLSession|WinHttp|WinInet|WSAStartup|(^|[^A-Za-z])socket[[:space:]]*\(|com\.apple\.security\.network\.(client|server)'

# Collect candidate sources. This script contains the forbidden pattern as a
# literal, so it must never be part of the scan.
FILES=$(find "$ROOT_DIR/src" "$ROOT_DIR/scripts" "$ROOT_DIR/.github" \
  -type f ! -name 'audit-offline.sh' | sort)
FILES="$FILES
$ROOT_DIR/CMakeLists.txt"

if command -v rg >/dev/null 2>&1; then
  AUDIT_TOOL="rg"
  set +e
  # shellcheck disable=SC2086
  rg -n --pcre2 "$PATTERN" $FILES
  RESULT=$?
  set -e
else
  AUDIT_TOOL="grep"
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
