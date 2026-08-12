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
  readActiveSubscribers,
  readDecimals,
  readFtsoPrice,
  invertScaledPrice,
  resetSubscriberCache,
  type SigmaxChainConfig,
} from "./chain.js";
import { decryptViaNode } from "../node.js";
import { getStoredKey } from "../keystore.js";
import { httpTransport, type HlTransport } from "./hl/api.js";
import { encodeHlReceipts, executeHyperliquidSignal } from "./hl/execute.js";
import { hexToBytes, bytesToHex } from "../../base/encoding.js";

/** Injectable seams so the handler is testable without a TEE node, a live chain, or a live exchange. */
export interface SigmaxDeps {
  decrypt: (ciphertext: Uint8Array) => Promise<Uint8Array>;
  config: SigmaxChainConfig;
  client: PublicClient;
  now: () => number;
  /** Hyperliquid venue only. Built lazily from config so the Flare path never opens an exchange client. */
  hlTransport?: HlTransport;
  /** Hyperliquid nonce source (milliseconds). Injected so tests are deterministic. */
  hlNonce?: () => number;
  /** The injected agent master secret. Indirected through a getter so a later injection is picked up. */
  getMasterKey?: () => Uint8Array | null;
}

let deps: SigmaxDeps | null = null;

/** Lazily build the default deps (env config + Coston2 client + the node's /decrypt port). */
function getDeps(): SigmaxDeps {
  if (deps === null) {
    const config = configFromEnv();
    deps = {
      decrypt: decryptViaNode,
      config,
      client: makeClient(config),
      now: () => Math.floor(Date.now() / 1000),
      hlNonce: () => Date.now(),
      getMasterKey: getStoredKey,
    };
  }
  return deps;
}

/** The exchange transport, built on first Hyperliquid signal and reused after that. */
let hlTransportCache: HlTransport | null = null;
function hlTransportFor(d: SigmaxDeps): HlTransport {
  if (d.hlTransport) return d.hlTransport;
  if (hlTransportCache === null) hlTransportCache = httpTransport(d.config.hlTestnet);
  return hlTransportCache;
}

/** Override the deps (tests only). Pass `null` to restore the env-derived defaults. */
export function setSigmaxDeps(d: SigmaxDeps | null): void {
  deps = d;
}

/** Counters surfaced via GET /state — safe to expose (no strategy content). */
const stats = {
  signalsProcessed: 0,
  signalsRejected: 0,
  authsIssued: 0,
  hlOrdersFilled: 0,
  duplicatesRejected: 0,
};

/**
 * Signal ids already executed on an OFF-CHAIN venue, in enclave memory.
 *
 * Ported from the legacy pipeline's `PositionStore.isProcessed`, which the Flare path never needed and
 * Hyperliquid genuinely does. The difference is where the guard lives: a Flare authorization is
 * replay-protected by the vault itself (`keccak256(actionId, index) => consumed`), so re-running the
 * same signal costs nothing. Hyperliquid has no such backstop — the enclave sends a real order the
 * moment it decrypts one, so a re-delivered instruction is a second real trade with the follower's
 * money. And re-delivery is not hypothetical: FCC routes each instruction to a random registered
 * machine, and the publish path retries when it lands on a stale one.
 *
 * Deliberately ENTRY-and-EXIT alike, unlike the legacy store which skipped deduping exits so a failed
 * exit could be retried. That trade-off made sense when an exit was an idempotent on-chain swap; here
 * a duplicate exit is an extra market sell.
 *
 * Memory-only and cleared by a restart. Bounded so a long-running enclave cannot grow without limit.
 */
const executedSignalIds = new Set<string>();
const MAX_TRACKED_SIGNALS = 5_000;

function alreadyExecuted(signalId: string): boolean {
  return executedSignalIds.has(signalId);
}

function markExecuted(signalId: string): void {
  if (executedSignalIds.size >= MAX_TRACKED_SIGNALS) {
    // Drop the oldest insertion (Set preserves insertion order) rather than clearing everything —
    // wiping the whole set would make every recent signal replayable at once.
    const oldest = executedSignalIds.values().next().value;
    if (oldest !== undefined) executedSignalIds.delete(oldest);
  }
  executedSignalIds.add(signalId);
}

export function reportSigmaxState(): unknown {
  return { ...stats };
}

export function resetSigmaxState(): void {
  stats.signalsProcessed = 0;
  stats.signalsRejected = 0;
  stats.authsIssued = 0;
  stats.hlOrdersFilled = 0;
  stats.duplicatesRejected = 0;
  executedSignalIds.clear();
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

  if (signal.venue !== "flare" && signal.venue !== "hyperliquid") {
    return reject("unsupported venue for this extension");
  }

  const nowSecs = now();
  if (signal.expiresAt !== 0 && nowSecs > signal.expiresAt) return reject("signal expired");

  // Hyperliquid settles off-chain, so `chainId` addresses the CONTROL plane (where subscriptions and
  // the signal commitment live), which is this chain either way. Only the Flare venue additionally
  // requires it to match, because there it also names the settlement chain.
  if (signal.venue === "hyperliquid") {
    return handleHyperliquidSignal(signal, getDeps());
  }

  if (BigInt(signal.chainId) !== config.chainId) return reject("signal chainId does not match this chain");

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

/**
 * The Hyperliquid venue: decrypt has already happened, so from here the signal is confidential.
 *
 * Unlike the Flare path there is no authorization to hand to a keeper — Hyperliquid has nothing
 * on-chain to verify a TEE signature against, so the enclave places the order itself with the
 * follower's own derived agent key. `resultData` is therefore a RECEIPT of what happened, not a
 * permission to do it.
 */
async function handleHyperliquidSignal(
  signal: Signal,
  d: SigmaxDeps,
): Promise<[string | null, number, string | null]> {
  const masterKey = d.getMasterKey?.() ?? null;
  if (masterKey === null) {
    return reject("hyperliquid venue has no agent key — inject one via KEY/UPDATE");
  }
  if (d.config.hlPerTradeCapUnits <= 0n) {
    // Refusing beats trading unbounded: on this venue the config value is the only cap that exists.
    return reject("hyperliquid per-trade cap is not configured");
  }
  // Replay guard. Unlike a Flare authorization — which each vault refuses to consume twice — an order
  // sent to Hyperliquid is final the moment it fills, so this check is the only thing standing between
  // a re-delivered instruction and a second real trade.
  if (alreadyExecuted(signal.signalId)) {
    stats.duplicatesRejected += 1;
    return reject("signal already executed");
  }

  // Marked BEFORE any order is placed, not after. A crash mid-fan-out then leaves some followers
  // traded and some not, and a retry will not pick up the stragglers — but the alternative is a retry
  // re-trading everyone who already filled. A missed trade is a lost opportunity; a duplicate trade
  // spends the follower's money twice, so the guard errs in the direction that cannot lose funds.
  markExecuted(signal.signalId);

  try {
    const subscribers = await readActiveSubscribers(d.client, d.config, signal.strategyId);

    const { receipts, filled, skipped } = await executeHyperliquidSignal({
      signal,
      subscribers,
      transport: hlTransportFor(d),
      masterKey,
      isTestnet: d.config.hlTestnet,
      slippageBps: d.config.slippageBps,
      perTradeCapUnits: d.config.hlPerTradeCapUnits,
      nonce: d.hlNonce ?? (() => Date.now()),
    });

    stats.signalsProcessed += 1;
    stats.hlOrdersFilled += filled;
    // Counts and the (already public) signal id only — never the market, size, or thresholds.
    console.log(`signal ${signal.signalId} processed on hyperliquid: ${filled} filled, ${skipped} skipped`);
    return [encodeHlReceipts(receipts), 1, null];
  } catch {
    // The underlying error can quote the price or size back at us; those belong to the strategy.
    return reject("hyperliquid execution failed");
  }
}

function reject(reason: string): [null, number, string] {
  stats.signalsRejected += 1;
  return [null, 0, reason];
}
