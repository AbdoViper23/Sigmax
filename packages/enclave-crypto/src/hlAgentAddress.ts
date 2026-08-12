/**
 * Derive the Hyperliquid agent address a follower must approve — from PUBLIC data only.
 *
 * This is the browser half of the derivation the enclave performs privately
 * (`fce-sigmax/typescript/src/app/sigmax/hl/agent-key.ts`). The enclave holds one master secret and
 * derives a distinct agent key per follower; it publishes only the master PUBLIC key. Because the
 * derivation is non-hardened, anyone can compute the matching child *public* key:
 *
 *     tweak     = HMAC-SHA256(masterPub, "sigmax/hl-agent/v1:<follower>:<counter>") mod n
 *     childPub  = masterPub + tweak·G        ← this file
 *     childPriv = (masterPriv + tweak) mod n ← enclave only
 *
 * WHY THAT MATTERS: a follower is about to grant an address permission to trade on their account. If
 * the app simply displayed an address returned by a server, approving it would be an act of trust. Here
 * the wallet recomputes the address from the enclave's published key and the follower's own address, so
 * approving it is an act of verification.
 *
 * VENDORED PAIR: this must stay byte-compatible with the enclave copy (fce-sigmax is a standalone npm
 * project and cannot import workspace packages, the same constraint that applies to `swap-auth.ts` and
 * `hl/meta.ts`). Both sides' tests pin the SAME hard-coded address vectors — if either drifts, the two
 * suites disagree and the mismatch surfaces immediately rather than as rejected orders in production.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

const DERIVATION_DOMAIN = "sigmax/hl-agent/v1";
const textEncoder = new TextEncoder();

const CURVE_ORDER = secp256k1.CURVE.n;

function bytesToBigInt(b: Uint8Array): bigint {
  let out = 0n;
  for (const byte of b) out = (out << 8n) | BigInt(byte);
  return out;
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/** Accept a compressed (33-byte) or uncompressed (65-byte) key, hex or bytes. */
function toBytes(key: string | Uint8Array): Uint8Array {
  if (typeof key !== "string") return key;
  const clean = key.startsWith("0x") ? key.slice(2) : key;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The public tweak for one follower. Keyed by the master public key so the label alone cannot be
 * replayed against a different enclave, and lower-cased so a checksummed address and a lower-cased one
 * derive the same agent.
 */
function deriveTweak(masterPubCompressed: Uint8Array, follower: string, counter: number): bigint {
  const label = `${DERIVATION_DOMAIN}:${follower.toLowerCase()}:${counter}`;
  return mod(bytesToBigInt(hmac(sha256, masterPubCompressed, textEncoder.encode(label))), CURVE_ORDER);
}

const HEX = "0123456789abcdef";

/** EIP-55 checksummed address for a secp256k1 public key. */
export function addressFromPublicKey(publicKey: string | Uint8Array): string {
  const bytes = toBytes(publicKey);
  const point = secp256k1.ProjectivePoint.fromHex(bytes);
  const uncompressed = point.toRawBytes(false);
  const hashed = keccak_256(uncompressed.slice(1)).slice(-20); // drop the 0x04 marker

  let lower = "";
  for (const b of hashed) lower += `${HEX[b >> 4] ?? "0"}${HEX[b & 0x0f] ?? "0"}`;

  const hashOfLower = keccak_256(textEncoder.encode(lower));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const hashByte = hashOfLower[i >> 1] ?? 0;
    const nibble = i % 2 === 0 ? hashByte >> 4 : hashByte & 0x0f;
    const ch = lower[i] ?? "0";
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** The child public key for one follower, computed from the master public key alone. */
export function deriveHlAgentPublicKey(
  masterPublicKey: string | Uint8Array,
  follower: string,
): Uint8Array {
  const masterBytes = toBytes(masterPublicKey);
  // Normalize to compressed first: the tweak is keyed by the compressed form on both sides, so an
  // uncompressed input would otherwise derive a different — and unusable — agent.
  const masterPoint = secp256k1.ProjectivePoint.fromHex(masterBytes);
  const compressed = masterPoint.toRawBytes(true);

  for (let counter = 0; counter < 8; counter++) {
    const tweak = deriveTweak(compressed, follower, counter);
    if (tweak === 0n) continue;
    const child = masterPoint.add(secp256k1.ProjectivePoint.BASE.multiply(tweak));
    if (!child.equals(secp256k1.ProjectivePoint.ZERO)) return child.toRawBytes(true);
  }
  throw new Error("hyperliquid: agent key derivation failed"); // unreachable in practice
}

/**
 * The address this follower must `approveAgent` on Hyperliquid.
 *
 * @param masterPublicKey The enclave's published master key (`hlAgentMasterPubkey` from `/state`).
 * @param follower The follower's own address.
 */
export function deriveHlAgentAddress(
  masterPublicKey: string | Uint8Array,
  follower: string,
): string {
  return addressFromPublicKey(deriveHlAgentPublicKey(masterPublicKey, follower));
}
