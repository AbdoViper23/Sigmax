#!/usr/bin/env bash
# Fallback: build the tee-node `server` binary on the host, into typescript/prebuilt/.
#
# Only needed on networks where proxy.golang.org 403s the large go-ethereum zip, which makes the
# in-image `go mod download` fail with a misleading "Forbidden". Building here reuses the host's
# module cache. Prefer the in-image build when it works — see the caveat below.
#
# ⚠️ REPRODUCIBILITY: the in-image build is what makes the code hash reproducible across machines
# (see REPRODUCIBILITY.md). A host-built binary is only appropriate for SIMULATED_TEE runs, where
# the code hash is the fixed simulated value anyway. Do NOT use this path for a real attested
# (MODE=0) deployment.
#
#   bash scripts/build-node-binary.sh [version]     # default: v0.0.25
set -euo pipefail

VERSION="${1:-v0.0.25}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(dirname "$SCRIPT_DIR")/typescript/prebuilt"
WORK_DIR="${TMPDIR:-/tmp}/tee-node-build-${VERSION}"

command -v go >/dev/null || { echo "go not found in PATH" >&2; exit 1; }

if [[ ! -d "$WORK_DIR/.git" ]]; then
    rm -rf "$WORK_DIR"
    git clone --depth 1 --branch "$VERSION" https://github.com/flare-foundation/tee-node.git "$WORK_DIR"
fi

mkdir -p "$OUT_DIR/assets"
echo "building tee-node $VERSION server (go $(go env GOVERSION))"
(cd "$WORK_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS="-buildvcs=false" \
    go build -trimpath -ldflags="-buildid= -s -w" -o "$OUT_DIR/server" ./cmd/extension)

cp "$WORK_DIR/assets/google_confidential_space_root.crt" "$OUT_DIR/assets/"
echo "wrote $OUT_DIR/server ($(du -h "$OUT_DIR/server" | cut -f1))"
