#!/usr/bin/env bash
# Register the enclave's public keys in the Enclave Registry (Testnet, software mode).
#
# Reads the keys from the enclave key file (creating it on first run), then calls
# EnclaveRegistry.set_keys as the admin. Vaults trust the signing key from this
# ledger on; leaders seal signals to the encryption key.
#
#   SIGMAX_ADMIN      stellar-cli identity of the registry admin (default: sigmax-admin)
#   ENCLAVE_KEY_FILE  enclave key file (default: stellar/enclave/.enclave/keys.json)
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN=${SIGMAX_ADMIN:-sigmax-admin}
export ENCLAVE_KEY_FILE=${ENCLAVE_KEY_FILE:-$PWD/enclave/.enclave/keys.json}
REGISTRY=$(python3 -c "import json;print(json.load(open('deployments/testnet.json'))['contracts']['enclaveRegistry'])")

(cd enclave && cargo build --release -q)
KEYS=$(enclave/target/release/sigmax-enclave keys)
SIGNING=$(echo "$KEYS" | python3 -c "import json,sys;print(json.load(sys.stdin)['signing_key'])")
ENCRYPTION=$(echo "$KEYS" | python3 -c "import json,sys;print(json.load(sys.stdin)['encryption_key'])")

stellar contract invoke --id "$REGISTRY" --source "$ADMIN" --network testnet -- \
  set_keys --signing_key "$SIGNING" --encryption_key "$ENCRYPTION" >/dev/null 2>&1
echo "registered enclave signing key $(echo "$KEYS" | python3 -c "import json,sys;print(json.load(sys.stdin)['signing_key_strkey'])") in $REGISTRY"
