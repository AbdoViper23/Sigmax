/**
 * SIGNAL/EXECUTE — the confidential core.
 *
 * The leader ECIES-encrypts an ABI-encoded signal to the enclave's public key and publishes the
 * ciphertext on-chain. This handler runs INSIDE the TEE: it decrypts, validates, discovers the
 * strategy's active subscribers, sizes each one, bounds `minOut` by the FTSO price, and returns the
 * ABI-encoded `SwapAuth[]`. The node signs that result; each follower's `CopyVaultFlare` verifies the
 * signature on-chain before swapping.
 *
 * CONFIDENTIALITY: the decrypted signal exists only in this function's locals. Never log the
 * plaintext, the token pair, `takeProfitPrice`, or `stopLossPrice` — the log lines below deliberately
 * carry only counts and the (already public) signal id.
 */

import type { Hex, PublicClient } from "viem";
import { decodeSignal, type Signal } from "./signal.js";
import { processFlareSignal } from "./process-signal.js";
import {
  configFromEnv,
  makeClient,
  readActiveFollowers,
  readDecimals,
  readFtsoPrice,
  invertScaledPrice,
  resetSubscriberCache,
  type SigmaxChainConfig,
} from "./chain.js";
import { decryptViaNode } from "../node.js";
import { hexToBytes, bytesToHex } from "../../base/encoding.js";

/** Injectable seams so the handler is testable without a TEE node or a live chain. */
export interface SigmaxDeps {
  decrypt: (ciphertext: Uint8Array) => Promise<Uint8Array>;
  config: SigmaxChainConfig;
  client: PublicClient;
  now: () => number;
}

let deps: SigmaxDeps | null = null;

/** Lazily build the default deps (env config + Coston2 client + the node's /decrypt port). */
function getDeps(): SigmaxDeps {
  if (deps === null) {
    const config = configFromEnv();
    deps = { decrypt: decryptViaNode, config, client: makeClient(config), now: () => Math.floor(Date.now() / 1000) };
  }
  return deps;
}

/** Override the deps (tests only). Pass `null` to restore the env-derived defaults. */
export function setSigmaxDeps(d: SigmaxDeps | null): void {
  deps = d;
}

/** Counters surfaced via GET /state — safe to expose (no strategy content). */
const stats = { signalsProcessed: 0, signalsRejected: 0, authsIssued: 0 };

export function reportSigmaxState(): unknown {
  return { ...stats };
}

export function resetSigmaxState(): void {
  stats.signalsProcessed = 0;
  stats.signalsRejected = 0;
  stats.authsIssued = 0;
  resetSubscriberCache();
}

/** UUID (16 bytes) left-aligned in a bytes32, matching a Solidity `bytes16 → bytes32` widening. */
export function signalIdToBytes32(signalId: string): Hex {
  return `0x${signalId.replace(/-/g, "")}${"0".repeat(32)}` as Hex;
}

/**
 * ENTRY buys `token` with `quoteToken`; EXIT sells `token` back into `quoteToken`. The FTSO feed
 * quotes token-per-quote (XRP/USD), so the EXIT direction uses it directly and ENTRY inverts it.
 */
function resolveDirection(signal: Signal, price: bigint, priceDecimals: number) {
  const token = signal.token as `0x${string}`;
  const quoteToken = signal.quoteToken as `0x${string}`;
  return signal.action === "ENTRY"
    ? { tokenIn: quoteToken, tokenOut: token, price: invertScaledPrice(price, priceDecimals) }
    : { tokenIn: token, tokenOut: quoteToken, price };
}

/**
 * Handle a SIGNAL/EXECUTE instruction.
 * @param msg Hex-encoded ECIES ciphertext of the ABI-encoded signal.
 * @returns `[resultDataHex, status, error]` — status 1 = success, 0 = error.
 */
export async function handleSignalExecute(msg: string): Promise<[string | null, number, string | null]> {
  const { decrypt, config, client, now } = getDeps();

  if (!msg) return reject("originalMessage is empty");

  let ciphertext: Uint8Array;
  try {
    ciphertext = hexToBytes(msg);
  } catch (e) {
    return reject(`invalid hex in originalMessage: ${e}`);
  }

  let plaintext: Uint8Array;
  try {
    plaintext = await decrypt(ciphertext);
  } catch (e) {
    return reject(`decryption failed: ${e}`);
  }

  // From here on `signal` is CONFIDENTIAL — never log it or any of its fields.
  let signal: Signal;
  try {
    signal = decodeSignal(bytesToHex(plaintext));
  } catch (e) {
    return reject(`invalid signal: ${e}`);
  }

  if (signal.venue !== "flare") return reject(`unsupported venue for this extension`);
  if (BigInt(signal.chainId) !== config.chainId) return reject("signal chainId does not match this chain");

  const nowSecs = now();
  if (signal.expiresAt !== 0 && nowSecs > signal.expiresAt) return reject("signal expired");

  try {
    const { value, decimals } = await readFtsoPrice(client, config);
    const { tokenIn, tokenOut, price } = resolveDirection(signal, value, decimals);
    const { tokenInDecimals, tokenOutDecimals } = await readDecimals(client, tokenIn, tokenOut);
    const followers = await readActiveFollowers(client, config, signal.strategyId, tokenIn);

    // Each vault enforces its own cap on-chain; size against the smallest so nothing reverts.
    const perTradeCap = followers.length
      ? followers.reduce((min, f) => (f.perTradeCap < min ? f.perTradeCap : min), followers[0]!.perTradeCap)
      : 0n;
    const deadline = BigInt(nowSecs + config.deadlineSecs);

    const { auths, resultData } = processFlareSignal({
      signal,
      activeFollowers: followers.map((f) => ({ vault: f.vault, balance: f.balance })),
      tokenIn,
      tokenOut,
      tokenInDecimals,
      tokenOutDecimals,
      router: config.router,
      perTradeCap,
      price,
      priceDecimals: decimals,
      slippageBps: config.slippageBps,
      deadline,
      chainId: config.chainId,
      signalIdBytes32: signalIdToBytes32(signal.signalId),
    });

    stats.signalsProcessed += 1;
    stats.authsIssued += auths.length;
    console.log(`signal ${signal.signalId} processed: ${auths.length} authorization(s) issued`);
    return [resultData, 1, null];
  } catch (e) {
    return reject(`execution failed: ${e}`);
  }
}

function reject(reason: string): [null, number, string] {
  stats.signalsRejected += 1;
  return [null, 0, reason];
}
