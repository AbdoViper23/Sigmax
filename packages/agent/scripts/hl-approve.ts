/**
 * Stage-1 demo onboarding — a follower's MASTER wallet approves the platform's HL agent key.
 *
 * On Hyperliquid the non-custodial property comes from the architecture: the follower is their own
 * master account and grants the agent key permission only to TRADE (place/cancel orders). The agent
 * provably cannot withdraw or transfer funds out — that always requires the master signature. This
 * script signs `approveAgent` once (with a `valid_until` TTL) so the running agent can trade for the
 * follower. In Stage 2/3 this moves into the web app (connect wallet + bridge + approve).
 *
 * Run (testnet):
 *   MASTER_PK=0x... HL_AGENT_ADDRESS=0x... [HL_AGENT_NAME=copyvault] [HL_TTL_DAYS=1] \
 *   [HYPERLIQUID_TESTNET=true] pnpm --filter @sigmax/agent exec tsx scripts/hl-approve.ts
 *
 * NB: the master must already be a funded HL account (bridge ≥5 USDC, native USDC, on Arbitrum).
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const masterPk = requiredEnv("MASTER_PK") as Hex;
  const agentAddress = requiredEnv("HL_AGENT_ADDRESS") as Hex;
  const baseName = process.env.HL_AGENT_NAME ?? "copyvault";
  const ttlDays = Number(process.env.HL_TTL_DAYS ?? "1");
  const testnet = !["false", "0", ""].includes((process.env.HYPERLIQUID_TESTNET ?? "true").toLowerCase());

  // Encode the expiry into the agent name; Hyperliquid enforces `valid_until` server-side (≤180 days).
  const validUntil = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const agentName = `${baseName} valid_until ${validUntil}`;

  const transport = new HttpTransport({ isTestnet: testnet });
  const client = new ExchangeClient({ transport, wallet: privateKeyToAccount(masterPk) });

  const result = await client.approveAgent({ agentAddress, agentName });
  // Don't print keys; the agent address + result status are non-secret.
  console.log(
    JSON.stringify(
      { network: testnet ? "testnet" : "mainnet", agentAddress, agentName, validUntil, result },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
