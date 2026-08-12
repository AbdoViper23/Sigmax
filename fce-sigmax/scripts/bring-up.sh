#!/usr/bin/env bash
#
# bring-up.sh — get from "nothing running" to "ready to trade", waiting out the shared-DB limit.
#
# WHY THIS EXISTS. `ext-proxy` connects to the hackathon indexer database using the shared credential
# `hackathon_user_57`, which has a 100-connection cap across every team using it. When that cap is full
# the proxy panics on startup:
#
#   Error 1226 (42000): User 'hackathon_user_57' has exceeded the 'max_user_connections'
#   resource (current value: 100)
#
# That is not a fault in this repo and no code change fixes it — the connections free up when other
# teams' stacks go idle. So rather than making someone retry by hand, this script waits for the proxy,
# then completes every remaining step in the right order and stops at the first thing that genuinely
# needs a human.
#
# ORDER MATTERS, and the reasons are not obvious:
#   1. ngrok BEFORE registration — the URL is written on-chain, so it must already resolve.
#   2. Registration AFTER the proxy is healthy — `post-build.sh` reads the enclave's identity through it.
#   3. Pause the stale machine — each dispatch picks ONE machine at random from those registered, so a
#      dead one left active causes intermittent, silent routing failures.
#   4. Rotate `teeAddress` LAST — a restart minted a new identity, and vaults verify against the old one
#      until told otherwise.
#
# Usage:
#   bash scripts/bring-up.sh              # wait up to 60 min for the proxy, then continue
#   WAIT_MINUTES=5 bash scripts/bring-up.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$PROJECT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
bad()  { echo -e "${RED}✗${NC} $*"; }
dim()  { echo -e "${DIM}  $*${NC}"; }
step() { echo -e "\n${GREEN}▸${NC} $*"; }

WAIT_MINUTES="${WAIT_MINUTES:-60}"
NGROK_DOMAIN="${NGROK_DOMAIN:-superurgently-creamless-paityn.ngrok-free.dev}"
PROXY_URL="https://${NGROK_DOMAIN}"
COMPOSE=(docker compose -f "$PROJECT_DIR/docker-compose.yaml" -f "$PROJECT_DIR/docker-compose.coston2.yaml")

# `post-build.sh` needs a Go toolchain. Prefer one on PATH, else the local install.
if ! command -v go >/dev/null 2>&1 && [[ -x "$HOME/.local/share/go/bin/go" ]]; then
    export PATH="$HOME/.local/share/go/bin:$PATH"
fi

cd "$PROJECT_DIR"

# ---------------------------------------------------------------- 1. tunnel
step "1/6  ngrok tunnel on the reserved domain"
if pgrep -f "ngrok http 6674" >/dev/null 2>&1; then
    ok "already running"
else
    nohup ngrok http 6674 --domain="$NGROK_DOMAIN" --log=/tmp/ngrok.log >/dev/null 2>&1 &
    sleep 6
    pgrep -f "ngrok http 6674" >/dev/null 2>&1 && ok "started" || { bad "ngrok failed — see /tmp/ngrok.log"; exit 1; }
fi
dim "$PROXY_URL  → localhost:6674"

# ---------------------------------------------------------------- 2. containers
step "2/6  enclave + redis"
"${COMPOSE[@]}" up -d extension-tee redis >/dev/null 2>&1
sleep 4
docker ps --format '{{.Names}}' | grep -q extension-tee && ok "extension-tee up" || { bad "extension-tee failed"; exit 1; }

# ---------------------------------------------------------------- 3. the proxy, and the waiting
step "3/6  ext-proxy (this is the step that waits on the shared indexer DB)"
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
attempt=0
until curl -sf --max-time 8 "http://localhost:6674/info" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    "${COMPOSE[@]}" up -d ext-proxy >/dev/null 2>&1
    sleep 15

    if curl -sf --max-time 8 "http://localhost:6674/info" >/dev/null 2>&1; then break; fi

    if "${COMPOSE[@]}" logs --tail=200 ext-proxy 2>&1 | grep -q "max_user_connections"; then
        reason="shared indexer DB is at its 100-connection cap"
    else
        reason="see: docker compose logs ext-proxy"
    fi

    if (( $(date +%s) > deadline )); then
        bad "ext-proxy still down after ${WAIT_MINUTES} min — ${reason}"
        dim "Nothing here is broken in this repo. Either wait for connections to free up and re-run,"
        dim "or ask the FCC team for credentials that are not shared across every team."
        exit 1
    fi
    warn "attempt ${attempt}: ${reason} — retrying in 30s"
    sleep 30
done
ok "ext-proxy is answering /info"

# ---------------------------------------------------------------- 4. register this identity
step "4/6  register the TEE machine (a restart always mints a new identity)"
if ! bash "$PROJECT_DIR/scripts/post-build.sh"; then
    bad "registration failed — fix that before continuing; the steps below depend on it"
    exit 1
fi
ok "registered"

# ---------------------------------------------------------------- 5. retire stale machines
step "5/6  pause any stale machine"
dim "Each dispatch picks ONE machine at random from those registered for the extension, so a dead"
dim "registration left active makes roughly every other signal vanish with no error."
warn "There is no scripted pause in the scaffold — do this by hand and verify with:"
dim "  pnpm --filter @sigmax/agent resync     # lists every machine and flags the stale ones"

# ---------------------------------------------------------------- 6. point the contracts at it
step "6/6  rotate teeAddress on the factory and your vault"
( cd "$REPO_DIR" && APPLY=1 pnpm --filter @sigmax/agent resync ) || warn "resync reported problems — read its output"

cat <<EOF

$(echo -e "${GREEN}Ready.${NC}") Two processes still have to be running for a trade to happen:

  pnpm --filter @sigmax/agent keeper     # Flare venue: relays the signed authorization. Without it a
                                         # published signal produces no trade and no error anywhere.
  pnpm --filter web dev                  # the app

For the Hyperliquid venue, additionally:

  pnpm --filter @sigmax/agent exec tsx scripts/hl-inject-key.ts
  # and set SIGMAX_HL_PER_TRADE_CAP — it defaults to 0, which disables the venue by design

Then prove the whole path end to end:

  pnpm --filter @sigmax/agent exec tsx scripts/flare-e2e-demo.ts
EOF
