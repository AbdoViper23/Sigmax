/**
 * Inject the Hyperliquid agent MASTER key into the enclave (Coston2).
 *
 * The enclave cannot trade on Hyperliquid until it holds a signing secret, and that secret must reach
 * it without ever existing in the clear outside it. This script ECIES-encrypts the master key to the
 * enclave's published public key and sends it as a `KEY/UPDATE` instruction, exactly like a signal:
 * the ciphertext goes on-chain, and only the TEE can open it.
 *
 * From that one master secret the enclave derives a DISTINCT agent key per follower (see
 * `fce-sigmax/typescript/src/app/sigmax/hl/agent-key.ts`). Hyperliquid tracks nonces per signer
 * address and keeps only the 100 highest, so a shared agent address would put every follower into one
 * window and start dropping orders under fan-out.
 *
 * ── two things to know before running ────────────────────────────────────────────────────────────
 *
 * 1. **The key lives in enclave memory only, and a restart clears it.** Re-run this script after any
 *    restart. Because derivation is deterministic, the same master secret reproduces every follower's
 *    agent address — a restart never forces followers to re-approve.
 *
 * 2. **`updateKey` routes to ONE random registered machine.** If several machines are registered for
 *    the extension, the others still have no key and will reject Hyperliquid signals. Run this until
 *    every live machine reports `hasKey`, or deregister the stale ones. This is the same routing
 *    caveat the e2e demo documents for signals.
 *
 * Env:
 *   DEPLOYMENT_PRIVATE_KEY    wallet that pays the instruction fee
 *   FLARE_INSTRUCTION_SENDER  config/extension.env INSTRUCTION_SENDER
 *   EXT_PROXY_URL             public proxy URL (to fetch the enclave key and confirm the result)
 *   HL_MASTER_KEY             the secret to inject; omit to generate a fresh one (printed ONCE)
 *   FEE_WEI                   per-instruction fee override
 *
 *   pnpm --filter @sigmax/agent exec tsx scripts/hl-inject-key.ts
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ProxyEnclaveKeySource, eciesEncrypt, normalizePublicKey, bytesToHex } from "@sigmax/enclave-crypto";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** Matches fce-sign's DefaultFee; the same value the signal path pays. */
const INSTRUCTION_FEE_WEI = BigInt(process.env.FEE_WEI ?? "1000000000000");

const SENDER_ABI = parseAbi(["function updateKey(bytes _encryptedKey) payable"]);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error("HL_MASTER_KEY must be 32 bytes of hex");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(env("DEPLOYMENT_PRIVATE_KEY") as Hex);
  const sender = env("FLARE_INSTRUCTION_SENDER") as Address;
  const proxyUrl = env("EXT_PROXY_URL").replace(/\/$/, "");

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  // Generate when not supplied. Printed exactly once — losing it means every follower must re-approve
  // a new set of agent addresses, so it belongs in the same place as any other production secret.
  const provided = process.env.HL_MASTER_KEY;
  const masterKeyHex = provided ?? generatePrivateKey();
  const masterKey = hexToBytes(masterKeyHex);

  if (!provided) {
    console.log("generated a new master key — STORE THIS, it is not recoverable:");
    console.log(`  HL_MASTER_KEY=${masterKeyHex}\n`);
  }

  console.log(`sender     ${sender}`);
  console.log(`proxy      ${proxyUrl}`);
  console.log(`payer      ${account.address}`);

  // Encrypt to the enclave's own key, fetched from the proxy. If this fetch fails we abort rather
  // than fall back to anything weaker — an unencrypted key on-chain is unrecoverable.
  const enclavePubkey = normalizePublicKey(await new ProxyEnclaveKeySource(proxyUrl).fetchPublicKey());
  const ciphertext = bytesToHex(eciesEncrypt(enclavePubkey, masterKey));
  console.log(`ciphertext ${(ciphertext.length - 2) / 2} bytes`);

  const hash = await walletClient.writeContract({
    address: sender,
    abi: SENDER_ABI,
    functionName: "updateKey",
    args: [ciphertext],
    value: INSTRUCTION_FEE_WEI,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`updateKey  ${hash} (${receipt.status})`);

  // Confirm the enclave actually stored it. `hlAgentMasterPubkey` is what a follower's wallet uses to
  // derive — and independently verify — the agent address it is about to approve.
  console.log("\nwaiting for the enclave to report the key…");
  for (let attempt = 1; attempt <= 30; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const res = await fetch(`${proxyUrl}/state`);
      if (!res.ok) continue;
      const state = (await res.json()) as { state?: { hasKey?: boolean; hlAgentMasterPubkey?: string } };
      if (state.state?.hasKey) {
        console.log(`✓ enclave holds the key`);
        console.log(`  hlAgentMasterPubkey ${state.state.hlAgentMasterPubkey}`);
        console.log("\nFollowers approve a per-follower agent address derived from that public key.");
        return;
      }
    } catch {
      // proxy not ready yet — keep polling
    }
  }
  throw new Error("enclave never reported the key — check which machine the instruction was routed to");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
