#!/bin/sh
# Compiles the extension's decryption (targets/notification-service/PushCrypto.swift)
# with a macOS test and checks it against the control plane's push vector.
set -e
cd "$(dirname "$0")/.."
out="${TMPDIR:-/tmp}/astrodock-push-crypto-test"
xcrun swiftc -parse-as-library -O \
  test/PushCryptoTest.swift targets/notification-service/PushCrypto.swift \
  -o "$out"
"$out" test/push-vector.json
