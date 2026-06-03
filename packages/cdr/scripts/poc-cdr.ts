/**
 * PoC #1 — live CDR publish→decrypt round-trip on Story Aeneid.
 *
 * Required env: CDR_KEY, STORY_API_URL, OPERATOR_LICENSE_TOKEN_ID
 *   (+ optional STRATEGY_IP_ID, STORY_RPC_URL, CDR_NETWORK)
 * Run: pnpm --filter @sigmax/cdr exec tsx --env-file=../agent/.env scripts/poc-cdr.ts
 */
import { SignalSchema, ARBITRUM_ADDRESSES, type Signal } from "@sigmax/shared";
import { RealCdr } from "../src/index.js";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(
      `missing required env: ${name} — live CDR needs CDR_KEY, STORY_API_URL, OPERATOR_LICENSE_TOKEN_ID`,
    );
  return v;
}

const signal: Signal = SignalSchema.parse({
  signalId: "12345678-1234-1234-1234-1234567890ab",
  strategyId: process.env.STRATEGY_IP_ID ?? "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 42161,
  action: "ENTRY",
  token: ARBITRUM_ADDRESSES.weth,
  quoteToken: ARBITRUM_ADDRESSES.usdc,
  sizeBps: 500,
  takeProfitPrice: "350000000000",
  stopLossPrice: "270000000000",
  issuedAt: Math.floor(Date.parse("2026-05-30T00:00:00Z") / 1000),
  expiresAt: Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000),
});

async function main() {
  const cdrKey = reqEnv("CDR_KEY");
  const apiUrl = reqEnv("STORY_API_URL");
  const licenseId = reqEnv("OPERATOR_LICENSE_TOKEN_ID");

  console.log("▶ LIVE CDR on Story Aeneid");
  const cdr = new RealCdr({
    privateKey: cdrKey as `0x${string}`,
    rpcUrl: process.env.STORY_RPC_URL,
    apiUrl,
    network: process.env.CDR_NETWORK as "mainnet" | "testnet" | undefined,
    // The vault is read-gated to signal.strategyId; the agent presents the license id(s) it holds.
    getLicenseTokenIds: () => [BigInt(licenseId)],
  });

  const t0 = Date.now();
  const { uuid } = await cdr.publishSignal(signal);
  const recovered = await cdr.accessSignal(uuid);
  const ok = JSON.stringify(recovered) === JSON.stringify(signal);
  console.log(`uuid=${uuid}  round-trip=${ok ? "OK ✅" : "MISMATCH ❌"}  latency=${Date.now() - t0}ms`);
  if (!ok) process.exit(1);
  console.log("PoC #1 done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
