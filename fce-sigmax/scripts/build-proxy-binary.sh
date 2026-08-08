#!/usr/bin/env bash
# Build the tee-proxy binary on the host, into proxy/ so the Dockerfile can COPY it.
#
# Why not build inside the image: proxy.golang.org returns 403 for the large go-ethereum zip on some
# networks, so an in-image `go mod download` fails with a misleading "Forbidden". Building here
# reuses the host's module cache, which already holds those modules.
#
#   bash scripts/build-proxy-binary.sh [version]     # default: v0.0.21
set -euo pipefail

VERSION="${1:-v0.0.21}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$(dirname "$SCRIPT_DIR")/proxy"
WORK_DIR="${TMPDIR:-/tmp}/tee-proxy-build-${VERSION}"

command -v go >/dev/null || { echo "go not found in PATH" >&2; exit 1; }

if [[ ! -d "$WORK_DIR/.git" ]]; then
    rm -rf "$WORK_DIR"
    git clone --depth 1 --branch "$VERSION" https://github.com/flare-foundation/tee-proxy.git "$WORK_DIR"
fi

echo "building tee-proxy $VERSION (go $(go env GOVERSION))"
(cd "$WORK_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -a -o main ./cmd/proxy)

cp "$WORK_DIR/main" "$PROXY_DIR/main"
cp "$WORK_DIR/config/config.example.toml" "$PROXY_DIR/config.example.toml"
echo "wrote $PROXY_DIR/main ($(du -h "$PROXY_DIR/main" | cut -f1))"
