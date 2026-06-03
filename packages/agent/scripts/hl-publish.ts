/**
 * Publish a trade signal to the running agent (acts as the leader). Posts to the agent's
 * `/signals/publish` endpoint; the agent encrypts (real CDR) or stores in-memory (mock CDR) and then
 * auto-executes for every active follower on the configured venue (Hyperliquid spot here).
 *
 * Prices are HUMAN USD and scaled to PRICE_SCALE (1e8) here, matching the web UI's encoding.
 * `HL_MAX_ENTRY=0` (default) = MARKET; a non-zero value = LIMIT entry at that price (fill-or-skip).
 *
 * Run:
 *   AGENT_API_URL=http://localhost:8787 STRATEGY_IP_ID=0x… \
 *   HL_TOKEN=0x…(maps to an HL coin via HYPERLIQUID_TOKENS) HL_QUOTE=0x…(USDC) \
 *   HL_ACTION=ENTRY HL_SIZE_BPS=500 HL_MAX_ENTRY=0 HL_TP=0 HL_SL=0 HL_EXPIRES_HOURS=24 \
 *   pnpm --filter @sigmax/agent exec tsx scripts/hl-publish.ts
 */
import { randomUUID } from "node:crypto";
import { parseUnits } from "viem";
import { PRICE_SCALE, SignalSchema, type Signal } from "@sigmax/shared";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${name}`);
  return v;
}

/** Human USD price → integer string scaled by 10^PRICE_SCALE (the on-chain signal encoding). */
function scalePrice(human: string): string {
  if (!human || human === "0") return "0";
  return parseUnits(human as `${number}`, PRICE_SCALE).toString();
}

async function main(): Promise<void> {
  const apiUrl = env("AGENT_API_URL", "http://localhost:8787").replace(/\/$/, "");
  const action = env("HL_ACTION", "ENTRY");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresHours = Number(env("HL_EXPIRES_HOURS", "24"));

  const signal: Signal = SignalSchema.parse({
    version: 1,
    signalId: randomUUID(),
    strategyId: env("STRATEGY_IP_ID"),
    chainId: Number(env("HL_CHAIN_ID", "998")), // cosmetic on HL; the venue field drives routing
    venue: env("HL_VENUE", "hyperliquid"),
    action,
    token: env("HL_TOKEN", "HYPE"), // HL: spot coin SYMBOL (e.g. HYPE); arbitrum: an EVM address
    quoteToken: env("HL_QUOTE", "USDC"), // HL: "USDC"; arbitrum: the USDC address
    sizeBps: Number(env("HL_SIZE_BPS", "500")),
    maxEntryPrice: scalePrice(env("HL_MAX_ENTRY", "0")), // 0 = market, else limit cap
    takeProfitPrice: scalePrice(env("HL_TP", "0")),
    stopLossPrice: scalePrice(env("HL_SL", "0")),
    issuedAt,
    expiresAt: action === "EXIT" ? 0 : issuedAt + Math.round(expiresHours * 3600),
  });

  const res = await fetch(`${apiUrl}/signals/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signal),
  });
  const body = await res.json().catch(() => ({}));
  // Don't print TP/SL back — only the non-secret routing fields + server response.
  console.log(
    JSON.stringify(
      { posted: { signalId: signal.signalId, action, token: signal.token, sizeBps: signal.sizeBps, limit: env("HL_MAX_ENTRY", "0") }, status: res.status, response: body },
      null,
      2,
    ),
  );
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
