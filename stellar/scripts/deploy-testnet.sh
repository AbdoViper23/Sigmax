#!/usr/bin/env bash
# Deploy the Sigmax Tranche 1 contracts to Stellar Testnet.
#
# Builds the contracts, uploads their Wasm, deploys the Signal Registry, the
# Enclave Registry and the vault factory, and writes every address and Wasm
# hash to stellar/deployments/testnet.json. Vaults are deployed later, one per
# follower, through the factory.
#
#   SIGMAX_ADMIN   stellar-cli identity that deploys and administers (default: sigmax-admin,
#                  created and funded with friendbot if it does not exist)
#   SIGMAX_ORACLE  SEP-40 oracle vaults bound min_amount_out with (default: Reflector's
#                  Testnet CEX/DEX feed, which quotes XLM and USDC in USD)
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=testnet
ADMIN=${SIGMAX_ADMIN:-sigmax-admin}
ORACLE=${SIGMAX_ORACLE:-CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63}
OUT=deployments/testnet.json

if ! stellar keys address "$ADMIN" >/dev/null 2>&1; then
  stellar keys generate "$ADMIN" --network "$NETWORK" --fund
fi
ADMIN_ADDR=$(stellar keys address "$ADMIN")
echo "admin: $ADMIN_ADDR"

(cd contracts && stellar contract build >/dev/null)
WASM=contracts/target/wasm32v1-none/release

upload() {
  stellar contract upload --wasm "$WASM/$1.wasm" --source "$ADMIN" --network "$NETWORK" 2>/dev/null
}
deploy() {
  local hash=$1
  shift
  stellar contract deploy --wasm-hash "$hash" --source "$ADMIN" --network "$NETWORK" -- "$@" 2>/dev/null
}

SIGNALS_WASM=$(upload sigmax_signal_registry)
ENCLAVE_WASM=$(upload sigmax_enclave_registry)
VAULT_WASM=$(upload sigmax_vault)
FACTORY_WASM=$(upload sigmax_vault_factory)
echo "wasm uploaded"

SIGNALS=$(deploy "$SIGNALS_WASM" --admin "$ADMIN_ADDR")
echo "signal registry: $SIGNALS"
ENCLAVE=$(deploy "$ENCLAVE_WASM" --admin "$ADMIN_ADDR")
echo "enclave registry: $ENCLAVE"
CONFIG="{\"enclave_registry\":\"$ENCLAVE\",\"signal_registry\":\"$SIGNALS\",\"oracle\":\"$ORACLE\"}"
FACTORY=$(deploy "$FACTORY_WASM" --admin "$ADMIN_ADDR" --vault_wasm "$VAULT_WASM" --config "$CONFIG")
echo "vault factory: $FACTORY"

mkdir -p deployments
cat >"$OUT" <<JSON
{
  "network": "testnet",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "admin": "$ADMIN_ADDR",
  "contracts": {
    "signalRegistry": "$SIGNALS",
    "enclaveRegistry": "$ENCLAVE",
    "vaultFactory": "$FACTORY"
  },
  "wasm": {
    "signalRegistry": "$SIGNALS_WASM",
    "enclaveRegistry": "$ENCLAVE_WASM",
    "vault": "$VAULT_WASM",
    "vaultFactory": "$FACTORY_WASM"
  },
  "oracle": "$ORACLE",
  "assets": {
    "USDC": {
      "token": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "code": "USDC",
      "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "decimals": 7
    },
    "XLM": {
      "token": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "code": "native",
      "decimals": 7
    }
  },
  "venues": [
    {
      "dex": "aquarius",
      "pool": "CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD",
      "tokens": [
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
      ],
      "feeBps": 100
    }
  ]
}
JSON
echo "wrote $OUT"
