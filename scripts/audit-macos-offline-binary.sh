#!/bin/sh
# Static dependency and symbol audit for a built macOS client executable.
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <macOS-client-executable>" >&2
  exit 2
fi

BINARY=$1
NETWORK_PATTERN='CFNetwork\.framework|Network\.framework|WebKit\.framework|JavaScriptCore\.framework|libcurl|NSURLSession|NSURLConnection|CFNetwork|WinHttp|WinINet|_socket$|_connect$|_send(to|msg)?$|_recv(from|msg)?$|_getaddrinfo$|_Internet(Open|Connect)|_HttpSendRequest'

# Check the rule itself so a weakened pattern cannot silently pass a clean binary.
for probe in 'CFNetwork.framework' 'NSURLSession' '_socket' '_sendto' 'WinHttpOpen'; do
  if ! printf '%s\n' "$probe" | grep -Eiq "$NETWORK_PATTERN"; then
    echo "MACOS_BINARY_AUDIT_RULE_SELF_TEST_FAILED(forbidden_probe=$probe)" >&2
    exit 2
  fi
done
if printf '%s\n' 'AppKit.framework Security.framework' | grep -Eiq "$NETWORK_PATTERN"; then
  echo "MACOS_BINARY_AUDIT_RULE_SELF_TEST_FAILED(allowed_probe_matched)" >&2
  exit 2
fi

DEPENDENCIES=$(otool -L "$BINARY")
UNDEFINED_SYMBOLS=$(nm -u "$BINARY")
if printf '%s\n%s\n' "$DEPENDENCIES" "$UNDEFINED_SYMBOLS" | grep -Eiq "$NETWORK_PATTERN"; then
  echo "MACOS_BINARY_OFFLINE_AUDIT_FAILED" >&2
  printf '%s\n%s\n' "$DEPENDENCIES" "$UNDEFINED_SYMBOLS" | grep -Ein "$NETWORK_PATTERN" >&2 || true
  exit 1
fi

echo "MACOS_BINARY_OFFLINE_AUDIT_PASSED"
