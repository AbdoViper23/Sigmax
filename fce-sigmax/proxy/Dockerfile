# Build of tee-proxy.
#
# TEE_PROXY_VERSION MUST stay aligned with the extension's Go-module pins
# (go/tools/go.mod): tee-proxy v0.0.21. tee-proxy's own go.mod transitively pins
# the matching tee-node and go-flare-common line, so building it pulls the exact
# governance-aware node code the extension-tee image uses — no separate tee-node
# clone or replace directive is needed.
#
# The binary is built on the HOST (see scripts/build-proxy-binary.sh) rather than
# inside this image. Reason: proxy.golang.org returns 403 for the large
# go-ethereum zip on some networks, so an in-image `go mod download` fails with a
# misleading "Forbidden". Building on the host reuses the developer's existing
# module cache, which already has those modules. Set PROXY_PREBUILT_BIN to point
# at the binary; scripts/start-services.sh does this automatically.

ARG TEE_PROXY_VERSION=v0.0.21

FROM alpine:latest

WORKDIR /app

# Produced by scripts/build-proxy-binary.sh (static, CGO_ENABLED=0, linux/amd64).
COPY main .
COPY config.example.toml ./config/config.toml

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

RUN chmod +x /app/main && chown -R appuser:appgroup /app

USER appuser

EXPOSE 6661
EXPOSE 6662

CMD ["./main"]
