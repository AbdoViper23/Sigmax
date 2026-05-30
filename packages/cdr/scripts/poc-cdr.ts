/**
 * PoC #1 — CDR publish→decrypt round-trip.
 *
 * Live (real Aeneid) when these env vars are set:
 *   CDR_KEY, STORY_API_URL, STRATEGY_IP_ID, OPERATOR_LICENSE_TOKEN_ID  (+ optional STORY_RPC_URL, CDR_NETWORK)
 * Otherwise runs the deterministic MockCdr path and tells you what to set to go live.
 */
import { SignalSchema, ARBITRUM_ADDRESSES, type Signal } from "@sigmax/shared";
import { MockCdr, RealCdr, ReadConditionDenied, type CdrPort } from "../src/index.js";

const signal: Signal = SignalSchema.parse({
  signalId: "12345678-1234-1234-1234-1234567890ab",
  strategyId: process.env.STRATEGY_IP_ID ?? "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  chainId: 42161,
  action: "ENTRY",
  token: ARBITRUM_ADDRESSES.weth,
  quoteToken: ARBITRUM_ADDRESSES.usdc,
  sizeBps: 5000,
  takeProfitPrice: "350000000000",
  stopLossPrice: "270000000000",
  issuedAt: Math.floor(Date.parse("2026-05-30T00:00:00Z") / 1000),
  expiresAt: Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000),
});

async function main() {
  const live = process.env.CDR_KEY && process.env.STORY_API_URL && process.env.OPERATOR_LICENSE_TOKEN_ID;
  let cdr: CdrPort;

  if (live) {
    console.log("▶ LIVE CDR on Story Aeneid");
    cdr = new RealCdr({
      privateKey: process.env.CDR_KEY as `0x${string}`,
      rpcUrl: process.env.STORY_RPC_URL,
      apiUrl: process.env.STORY_API_URL!,
      network: process.env.CDR_NETWORK as "mainnet" | "testnet" | undefined,
      ipId: (process.env.STRATEGY_IP_ID as `0x${string}`),
      leader: (process.env.LEADER_ADDRESS ?? process.env.STRATEGY_IP_ID) as `0x${string}`,
      operatorLicenseTokenId: BigInt(process.env.OPERATOR_LICENSE_TOKEN_ID!),
    });
  } else {
    console.log("▶ MOCK CDR (no creds). To run live, set: CDR_KEY, STORY_API_URL, STRATEGY_IP_ID, OPERATOR_LICENSE_TOKEN_ID");
    cdr = new MockCdr({ hasLicense: true });
  }

  const t0 = Date.now();
  const { uuid } = await cdr.publishSignal(signal);
  const recovered = await cdr.accessSignal(uuid);
  const ok = JSON.stringify(recovered) === JSON.stringify(signal);
  console.log(`uuid=${uuid}  round-trip=${ok ? "OK ✅" : "MISMATCH ❌"}  latency=${Date.now() - t0}ms`);
  if (!ok) process.exit(1);

  // Negative: an unlicensed reader must be denied.
  if (!live) {
    const denied = new MockCdr({ hasLicense: false });
    const { uuid: u2 } = await denied.publishSignal(signal);
    try {
      await denied.accessSignal(u2);
      console.error("negative test FAILED: unlicensed read succeeded ❌");
      process.exit(1);
    } catch (e) {
      console.log(`no-license read correctly denied ✅ (${e instanceof ReadConditionDenied ? "ReadConditionDenied" : "error"})`);
    }
  }
  console.log("PoC #1 done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
