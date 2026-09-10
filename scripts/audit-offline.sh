#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PATTERN='keyboardEventKeycode|characters|CGEventGetIntegerValueField|GetForegroundWindow|GetWindowText|MSLLHOOKSTRUCT|KBDLLHOOKSTRUCT|NSURLSession|WinHttp|WinInet|WSAStartup|(^|[^A-Za-z])socket[[:space:]]*\(|com\.apple\.security\.network\.(client|server)'

if rg -n --pcre2 "$PATTERN" \
  "$ROOT_DIR/src" \
  "$ROOT_DIR/CMakeLists.txt"; then
  echo "OFFLINE_AUDIT_FAILED"
  exit 1
fi

echo "OFFLINE_AUDIT_PASSED"
