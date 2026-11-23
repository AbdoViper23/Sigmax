/**
 * Sealed signal format, version 1 (must match `stellar/enclave/src/signal.rs`).
 *
 * The leader serializes the signal to JSON, commits `sha256(bytes)` to the Signal Registry and
 * seals the same bytes to the enclave's registered encryption key. The salt makes the commitment
 * hiding. Only the commitment goes on-chain; the plaintext never leaves the leader's browser except
 * as ciphertext.
 */

import { sha256 } from "@noble/hashes/sha256";
import { StrKey } from "@stellar/stellar-sdk";

import { bytesToHex, eciesEncrypt } from "./ecies.js";

export type SignalKind = "entry" | "close";

export interface SignalInput {
  kind: SignalKind;
  /** Leader account (G...). Must be the account that commits on-chain. */
  leader: string;
  /** Oracle ticker of the traded asset, e.g. `XLM`. */
  base: string;
  /** Oracle ticker of the funding asset, e.g. `USDC`. */
  quote: string;
  /** Entry: share of each vault's quote balance to spend. Close: share of base to sell. 1..=10000. */
  sizeBps: number;
  /** Private take-profit price (acted on from Tranche 2). */
  takeProfit?: string;
  /** Private stop-loss price (acted on from Tranche 2). */
  stopLoss?: string;
  /** Close only: hex commitment of the entry being closed. */
  entryRef?: string;
  /** Unix seconds; defaults to now. */
  ts?: number;
  /** 32 bytes hex; defaults to fresh random bytes. Tests pin it. */
  salt?: string;
}

const TICKER = /^[A-Z0-9]{1,12}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const PRICE = /^\d+(\.\d+)?$/;

function randomHex32(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Throw a readable error if `input` would be rejected by the enclave. */
export function validateSignal(input: SignalInput): void {
  if (input.kind !== "entry" && input.kind !== "close") throw new Error("kind must be entry or close");
  if (!StrKey.isValidEd25519PublicKey(input.leader)) throw new Error("leader must be a G... account");
  if (!TICKER.test(input.base) || !TICKER.test(input.quote) || input.base === input.quote) {
    throw new Error("base and quote must be two different uppercase tickers");
  }
  if (!Number.isInteger(input.sizeBps) || input.sizeBps < 1 || input.sizeBps > 10_000) {
    throw new Error("sizeBps must be an integer from 1 to 10000");
  }
  for (const [name, v] of [
    ["takeProfit", input.takeProfit],
    ["stopLoss", input.stopLoss],
  ] as const) {
    if (v !== undefined && (!PRICE.test(v) || !/[1-9]/.test(v) || v.length > 32)) {
      throw new Error(`${name} must be a positive decimal price`);
    }
  }
  if (input.kind === "close" && !(input.entryRef && HEX32.test(input.entryRef))) {
    throw new Error("a close signal needs entryRef: the entry's 32-byte hex commitment");
  }
  if (input.kind === "entry" && input.entryRef !== undefined) throw new Error("entryRef is for close signals only");
  if (input.salt !== undefined && !HEX32.test(input.salt)) throw new Error("salt must be 32 bytes of lowercase hex");
}

/** The exact JSON the enclave parses. Field order is fixed so the bytes are reproducible. */
export function encodeSignal(input: SignalInput): string {
  validateSignal(input);
  const o: Record<string, string | number> = {
    v: 1,
    kind: input.kind,
    leader: input.leader,
    base: input.base,
    quote: input.quote,
    size_bps: input.sizeBps,
  };
  if (input.takeProfit !== undefined) o.take_profit = input.takeProfit;
  if (input.stopLoss !== undefined) o.stop_loss = input.stopLoss;
  if (input.entryRef !== undefined) o.entry_ref = input.entryRef;
  o.salt = input.salt ?? randomHex32();
  o.ts = input.ts ?? Math.floor(Date.now() / 1000);
  return JSON.stringify(o);
}

export interface PreparedSignal {
  /** sha256 of the plaintext: what the leader commits on-chain. */
  commitment: Uint8Array;
  commitmentHex: string;
  /** ECIES ciphertext for the relay. */
  ciphertextHex: string;
}

/**
 * Serialize, commit and seal a signal in one step. The plaintext is not returned on purpose:
 * callers only ever handle the commitment and the ciphertext.
 */
export function prepareSignal(input: SignalInput, enclaveEncryptionKey: Uint8Array | string): PreparedSignal {
  const plaintext = new TextEncoder().encode(encodeSignal(input));
  const commitment = sha256(plaintext);
  const ciphertext = eciesEncrypt(enclaveEncryptionKey, plaintext);
  plaintext.fill(0);
  return {
    commitment,
    commitmentHex: bytesToHex(commitment).slice(2),
    ciphertextHex: bytesToHex(ciphertext).slice(2),
  };
}
