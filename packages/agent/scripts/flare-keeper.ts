/**
 * The Flare keeper daemon — the missing hop between a signal published from the UI and a swap.
 *
 * WHY THIS EXISTS. The enclave signs a `SwapAuth[]` and hands it back as an FCC `ActionResult`; each
 * follower's vault then verifies that signature on-chain before moving a token. Something has to carry
 * the authorization from the proxy to the vaults, and until now the only thing that ever did was
 * `flare-e2e-demo.ts`. So a leader publishing from the web app produced a correctly signed
 * authorization that nobody delivered, and no trade happened — silently, because every component
 * involved reported success. The demo worked and the product did not.
 *
 * The keeper is deliberately TRUSTLESS. It cannot forge, alter, or replay an authorization: the vault
 * checks the enclave's signature over a payload bound to the vault, chain id, amounts and a deadline,
 * and refuses a reused `(actionId, index)`. Losing this key costs gas money and nothing else, which is
 * why it is safe to run one publicly and why anyone can run their own.
 *
 * Env:
 *   EXT_PROXY_URL             proxy to poll for ActionResults
 *   DEPLOYMENT_PRIVATE_KEY    pays gas; holds no funds and needs no privileges
 *   FLARE_TEE_MANAGER         FCC diamond emitting TeeInstructionsSent (defaults to the known Coston2 one)
 *   FLARE_EXTENSION_ID        our extension id, to ignore other extensions' instructions
 *   POLL_MS                   head-poll interval (default 6000)
 *
 *   pnpm --filter @sigmax/agent exec tsx scripts/flare-keeper.ts
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { relayActionResult, type TeeActionResult } from "../src/flare/keeper.js";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** `TeeInstructionsSent(uint256 extensionId, bytes32 instructionId, uint256 ...)` — all indexed. */
const TEE_INSTRUCTIONS_SENT_TOPIC =
  "0xf770e69a9fc05b7180797556ec4cedb6108ce2c56ffa76c84aa087efeb5e6963";

const TEE_MANAGER = (process.env.FLARE_TEE_MANAGER ??
  "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE") as Address;

/**
 * The public Coston2 RPC caps `eth_getLogs` at 30 blocks. A daemon does not need history — it only
 * needs to not miss anything since its last look — so it walks forward in windows this size.
 */
const LOG_WINDOW = 30n;
const POLL_MS = Number(process.env.POLL_MS ?? "6000");

interface RawResponse {
  result?: { id?: string; submissionTag?: string; status: number; log?: string; data?: string };
  signature?: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

/**
 * One look at the proxy. Returns `null` while the instruction is still being worked (status ≥ 2) or not
 * yet filed (404), and throws only when the enclave has terminally rejected the signal.
 */
async function tryFetchResult(proxyUrl: string, instructionId: Hex): Promise<TeeActionResult | null> {
  const res = await fetch(`${proxyUrl}/action/result/${instructionId}`);
  if (!res.ok) return null; // 404 = not processed yet

  const body = (await res.json()) as RawResponse;
  const r = body.result;
  if (!r) return null;

  // FCC status: 0 = error (terminal), 1 = success, >= 2 = still working.
  if (r.status === 0) throw new Error(`enclave rejected the signal: ${r.log ?? "no reason given"}`);
  if (r.status !== 1) return null;

  return {
    resultData: (r.data ?? "0x") as Hex,
    actionId: r.id as Hex,
    submissionTag: r.submissionTag ?? "",
    status: r.status,
    signature: body.signature as Hex,
  };
}

async function main(): Promise<void> {
  const proxyUrl = env("EXT_PROXY_URL").replace(/\/$/, "");
  const account = privateKeyToAccount(env("DEPLOYMENT_PRIVATE_KEY") as Hex);
  const extensionId = process.env.FLARE_EXTENSION_ID?.toLowerCase();

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  console.log(`keeper     ${account.address}`);
  console.log(`proxy      ${proxyUrl}`);
  console.log(`manager    ${TEE_MANAGER}`);
  console.log(`extension  ${extensionId ?? "(any)"}\n`);

  // Start at the head: a keeper relays live signals, and an authorization old enough to have been
  // missed has passed its deadline anyway, so back-filling would only spend gas on certain reverts.
  let cursor = await publicClient.getBlockNumber();
  console.log(`watching from block ${cursor}\n`);

  // Instructions seen but not yet answered, plus those already handled — so a result is relayed once
  // even though the same instruction stays visible in later polls.
  const pending = new Map<Hex, number>(); // instructionId -> first-seen timestamp (ms)
  const done = new Set<Hex>();

  for (;;) {
    try {
      const head = await publicClient.getBlockNumber();

      // 1. Discover new instructions routed to our extension.
      while (cursor < head) {
        const to = cursor + LOG_WINDOW > head ? head : cursor + LOG_WINDOW;
        const logs = await publicClient.getLogs({
          address: TEE_MANAGER,
          fromBlock: cursor + 1n,
          toBlock: to,
        });
        for (const log of logs) {
          if (log.topics[0]?.toLowerCase() !== TEE_INSTRUCTIONS_SENT_TOPIC) continue;
          // topics: [sig, extensionId, instructionId, ...]
          if (extensionId && log.topics[1]?.toLowerCase() !== extensionId) continue;
          const instructionId = log.topics[2];
          if (!instructionId || done.has(instructionId) || pending.has(instructionId)) continue;
          pending.set(instructionId, Date.now());
          console.log(`[${new Date().toISOString()}] saw instruction ${instructionId}`);
        }
        cursor = to;
      }

      // 2. Poll each pending instruction and relay the moment it succeeds.
      for (const [instructionId, firstSeen] of [...pending]) {
        let result: TeeActionResult | null = null;
        try {
          result = await tryFetchResult(proxyUrl, instructionId);
        } catch (e) {
          // Terminal rejection — stop tracking it. The reason is the enclave's, not a strategy leak.
          console.log(`  ${instructionId} rejected: ${e instanceof Error ? e.message : String(e)}`);
          pending.delete(instructionId);
          done.add(instructionId);
          continue;
        }

        if (!result) {
          // Give up after 10 minutes: an authorization's deadline (600s by default) has expired by
          // then, so continuing to poll would only ever produce a guaranteed-revert relay.
          if (Date.now() - firstSeen > 10 * 60_000) {
            console.log(`  ${instructionId} never completed — dropping`);
            pending.delete(instructionId);
            done.add(instructionId);
          }
          continue;
        }

        pending.delete(instructionId);
        done.add(instructionId);

        // A Hyperliquid signal is executed by the enclave itself and its result is a receipt, not an
        // authorization — there is nothing to relay, and `decodeSwapAuths` would fail on those bytes.
        // Relaying is attempted regardless and per-entry failures are reported, so a receipt simply
        // yields no outcomes rather than crashing the loop.
        try {
          const outcomes = await relayActionResult(
            { publicClient, walletClient, account },
            result,
            { chainId: 114n },
          );
          if (outcomes.length === 0) {
            console.log(`  ${instructionId} → nothing to relay (off-chain venue receipt, or no followers)`);
          }
          for (const o of outcomes) {
            const detail = o.txHash ?? o.reason ?? "";
            console.log(`  ${o.vault} ${o.status}${detail ? `  ${detail}` : ""}`);
          }
        } catch (e) {
          console.log(`  ${instructionId} not relayable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      // A transient RPC or proxy failure must never kill the daemon — the whole point is that it stays
      // up so followers do not have to run one.
      console.error(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
