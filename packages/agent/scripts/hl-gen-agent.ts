/**
 * Generate a fresh Hyperliquid AGENT keypair (the "API wallet" the follower's master approves).
 *
 * The agent key only ever SIGNS trades — it can never withdraw (the L1 rejects withdrawals signed by
 * an agent key). Keep the private key as a secret env var (HYPERLIQUID_AGENT_PK) for the running
 * agent; the follower approves the printed ADDRESS via scripts/hl-approve.ts.
 *
 * Run:
 *   pnpm --filter @sigmax/agent exec tsx scripts/hl-gen-agent.ts
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

console.log(
  JSON.stringify(
    {
      HL_AGENT_ADDRESS: account.address, // approve THIS (public) via hl-approve.ts
      HYPERLIQUID_AGENT_PK: pk, // SECRET — give to the running agent; never commit / share
    },
    null,
    2,
  ),
);
