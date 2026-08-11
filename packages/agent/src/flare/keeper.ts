/**
 * The Flare keeper — the last hop of the confidential pipeline.
 *
 * The enclave returns a TEE-signed `SwapAuth[]` batch as an FCC `ActionResult`. Each follower's
 * `CopyVaultFlare` verifies that signature on-chain before swapping, so the keeper is a **trustless
 * relayer**: it holds no funds, cannot alter the authorization, and a tampered batch simply reverts.
 * Anyone can run one; we run it so followers don't have to.
 *
 * It deliberately does NOT see plaintext strategy: it consumes only the signed public result.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { decodeSwapAuths } from "./process-signal.js";
import type { SwapAuth } from "./swap-auth.js";

export const COPY_VAULT_FLARE_ABI = [
  {
    type: "function",
    name: "executeSwapWithTeeSig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "auths",
        type: "tuple[]",
        components: [
          { name: "vault", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minOut", type: "uint256" },
          { name: "router", type: "address" },
          { name: "swapData", type: "bytes" },
          { name: "signalId", type: "bytes32" },
          { name: "deadline", type: "uint256" },
          { name: "chainId", type: "uint256" },
        ],
      },
      { name: "index", type: "uint256" },
      { name: "actionId", type: "bytes32" },
      { name: "submissionTag", type: "string" },
      { name: "status", type: "uint8" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "received", type: "uint256" }],
  },
] as const;

/** An FCC ActionResult as polled from the ext-proxy. */
export interface TeeActionResult {
  /** ABI-encoded `SwapAuth[]` — the data the TEE signed. */
  resultData: Hex;
  actionId: Hex;
  submissionTag: string;
  status: number;
  signature: Hex;
}

export interface KeeperClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

/** One vault's relay attempt. `skipped` means we chose not to send (expired / wrong chain / used). */
export interface RelayOutcome {
  vault: `0x${string}`;
  index: number;
  status: "submitted" | "skipped" | "failed";
  txHash?: Hex;
  reason?: string;
}

export interface RelayOptions {
  /** Reject a batch whose chainId doesn't match the connected chain (defence in depth; the vault also checks). */
  chainId: bigint;
  /** Unix seconds; entries past their deadline are skipped rather than sent to certain revert. */
  now?: () => number;
  /** Simulate before sending so a doomed relay costs nothing (default true). */
  simulate?: boolean;
}

export function makeKeeperClients(args: {
  rpcUrl: string;
  account: Account;
  chain?: Parameters<typeof createWalletClient>[0]["chain"];
}): KeeperClients {
  const publicClient = createPublicClient({ transport: http(args.rpcUrl), chain: args.chain });
  const walletClient = createWalletClient({ transport: http(args.rpcUrl), account: args.account, chain: args.chain });
  return { publicClient, walletClient, account: args.account };
}

/**
 * Relay a signed batch: one `executeSwapWithTeeSig` per entry, each sent to that entry's own vault.
 * Entries are independent — one revert never blocks the others.
 */
export async function relayActionResult(
  clients: KeeperClients,
  result: TeeActionResult,
  opts: RelayOptions,
): Promise<RelayOutcome[]> {
  if (result.status !== 1) {
    throw new Error(`refusing to relay a non-success ActionResult (status ${result.status})`);
  }

  const auths = decodeSwapAuths(result.resultData) as SwapAuth[];
  const nowSecs = BigInt((opts.now ?? (() => Math.floor(Date.now() / 1000)))());
  const outcomes: RelayOutcome[] = [];

  for (let index = 0; index < auths.length; index++) {
    const auth = auths[index]!;
    const skip = preflight(auth, nowSecs, opts.chainId);
    if (skip) {
      outcomes.push({ vault: auth.vault, index, status: "skipped", reason: skip });
      continue;
    }
    outcomes.push(await relayOne(clients, result, auths, index, auth, opts.simulate !== false));
  }
  return outcomes;
}

/** Local checks mirroring the vault's own guards, so we never pay gas for a guaranteed revert. */
function preflight(auth: SwapAuth, nowSecs: bigint, chainId: bigint): string | null {
  if (auth.chainId !== chainId) return `auth is for chain ${auth.chainId}, keeper is on ${chainId}`;
  if (auth.deadline < nowSecs) return "authorization expired";
  if (auth.amountIn === 0n) return "zero amountIn";
  return null;
}

async function relayOne(
  { publicClient, walletClient, account }: KeeperClients,
  result: TeeActionResult,
  auths: SwapAuth[],
  index: number,
  auth: SwapAuth,
  simulate: boolean,
): Promise<RelayOutcome> {
  const args = [auths, BigInt(index), result.actionId, result.submissionTag, result.status, result.signature] as const;

  try {
    if (simulate) {
      await publicClient.simulateContract({
        address: auth.vault,
        abi: COPY_VAULT_FLARE_ABI,
        functionName: "executeSwapWithTeeSig",
        args,
        account,
      });
    }
    const txHash = await walletClient.writeContract({
      address: auth.vault,
      abi: COPY_VAULT_FLARE_ABI,
      functionName: "executeSwapWithTeeSig",
      args,
      account,
      chain: walletClient.chain,
    });
    return { vault: auth.vault, index, status: "submitted", txHash };
  } catch (e) {
    // Log the vault and the revert reason only — never the strategy that produced this batch.
    return { vault: auth.vault, index, status: "failed", reason: shortReason(e) };
  }
}

/** Known CopyVaultFlare custom errors, by selector — so a revert names the guard that fired. */
const VAULT_ERRORS: Record<string, string> = {
  "0x168f8aad": "MinOut",
  "0x81ceff30": "SwapFailed",
  "0xc6faa85f": "BadTeeSignature",
  "0xa4875a49": "CapExceeded",
  "0xf84835a0": "TokenNotWhitelisted",
  "0xb76b08ae": "RouterNotWhitelisted",
  "0xa4c91367": "AuthExpired",
  "0xae6a6625": "AuthAlreadyUsed",
  "0xe224e0ca": "WrongVault",
  "0x10dfc033": "WrongChain",
  "0x5c975bda": "BadStatus",
  "0x6c47fd6a": "TeeAddressUnset",
  "0x30cd7471": "NotOwner",
  "0x9e87fac8": "Paused",
};

/**
 * One line naming what actually failed. viem puts the custom-error selector several lines into its
 * message, so taking only the first line reports "reverted" and nothing actionable — which is useless
 * when the whole point is knowing which guard rejected the authorization.
 */
export function describeRevert(msg: string): string {
  const named = Object.entries(VAULT_ERRORS).find(([sel, name]) => msg.includes(sel) || msg.includes(`${name}()`));
  const first = msg.split("\n")[0]!.slice(0, 160);
  return named ? `${named[1]}() — ${first}` : first;
}

function shortReason(e: unknown): string {
  return describeRevert(e instanceof Error ? e.message : String(e));
}
