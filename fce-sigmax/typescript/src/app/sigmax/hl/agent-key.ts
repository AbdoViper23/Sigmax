/**
 * Per-follower Hyperliquid agent keys, derived inside the enclave from one injected master secret.
 *
 * WHY NOT ONE SHARED AGENT KEY (the legacy agent does this, and it is a latent bug):
 *
 *  1. **Nonces are tracked per signer address, not per account.** Hyperliquid keeps only "the 100
 *     highest nonces" per agent address, and separate accounts signed by the same API wallet share
 *     that one tracker. Fanning a signal out to N followers through a single agent address puts every
 *     follower into one 100-slot window, so under load actions start getting dropped — silently, and
 *     worst for whichever follower is unlucky.
 *  2. Hyperliquid's own docs **strongly** advise against reusing API wallet addresses at all, because
 *     a deregistered agent's nonce set may be pruned and previously signed actions replayed.
 *
 * So each follower gets their own agent address. Injecting N secrets would not scale, so we derive:
 * BIP32-style non-hardened derivation from one injected master key.
 *
 *     tweak      = HMAC-SHA256(masterPubCompressed, "sigmax/hl-agent/v1" ‖ follower) mod n
 *     childPriv  = (masterPriv + tweak) mod n         ← only the enclave can compute this
 *     childPub   = masterPub + tweak·G                ← ANYONE can compute this
 *
 * The asymmetry is the point. The enclave publishes only its master PUBLIC key, and a follower's
 * wallet computes the agent address it is about to approve **itself**, from that public key and its
 * own address. It never has to trust an address handed to it by a server — it verifies the derivation.
 *
 * Determinism matters operationally too: same master secret + same follower ⇒ same address forever, so
 * an enclave restart (which clears the injected key) needs only re-injection, never re-approval by
 * every follower.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import * as secp from "@noble/secp256k1";
import { keccak256 } from "../../../base/crypto.js";

/** Domain separation, so this derivation can never collide with another use of the same master key. */
const DERIVATION_DOMAIN = "sigmax/hl-agent/v1";

const textEncoder = new TextEncoder();

function scalarFromBytes(b: Uint8Array): bigint {
  return secp.etc.mod(secp.etc.bytesToNumberBE(b), secp.CURVE.n);
}

/**
 * The public tweak for a follower. Both sides compute this identically; only the master private key
 * turns it into a signing key.
 *
 * `counter` exists for the (astronomically unlikely) case that a tweak produces an invalid child key;
 * the caller retries with the next value rather than producing a key that cannot sign.
 */
function deriveTweak(masterPubCompressed: Uint8Array, follower: string, counter = 0): bigint {
  const label = `${DERIVATION_DOMAIN}:${follower.toLowerCase()}:${counter}`;
  return scalarFromBytes(hmac(sha256, masterPubCompressed, textEncoder.encode(label)));
}

/** The compressed (33-byte) public key of the injected master secret. Safe to publish. */
export function masterPublicKey(masterPrivateKey: Uint8Array): Uint8Array {
  return secp.getPublicKey(masterPrivateKey, true);
}

/**
 * The agent PRIVATE key for one follower. Enclave-only — this is the value that can place their
 * orders (and, by Hyperliquid's design, can never withdraw their funds).
 */
export function deriveAgentPrivateKey(masterPrivateKey: Uint8Array, follower: string): Uint8Array {
  const masterPub = masterPublicKey(masterPrivateKey);
  const masterScalar = secp.etc.bytesToNumberBE(masterPrivateKey);

  for (let counter = 0; counter < 8; counter++) {
    const child = secp.etc.mod(masterScalar + deriveTweak(masterPub, follower, counter), secp.CURVE.n);
    if (child !== 0n) return secp.etc.numberToBytesBE(child); // already left-padded to the 32-byte field size
  }
  throw new Error("hyperliquid: agent key derivation failed"); // unreachable in practice
}

/**
 * The agent PUBLIC key for one follower, computed from the master public key alone — no secret needed.
 * This is what lets a follower's wallet independently verify the address it is approving.
 */
export function deriveAgentPublicKey(masterPubCompressed: Uint8Array, follower: string): Uint8Array {
  const masterPoint = secp.ProjectivePoint.fromHex(masterPubCompressed);

  for (let counter = 0; counter < 8; counter++) {
    const tweak = deriveTweak(masterPubCompressed, follower, counter);
    if (tweak === 0n) continue;
    const child = masterPoint.add(secp.ProjectivePoint.BASE.multiply(tweak));
    // Mirror the private-side rejection so both sides skip the same counters.
    if (!child.equals(secp.ProjectivePoint.ZERO)) return child.toRawBytes(true);
  }
  throw new Error("hyperliquid: agent key derivation failed"); // unreachable in practice
}

const HEX = "0123456789abcdef";

/** EIP-55 checksummed address for an (uncompressed or compressed) secp256k1 public key. */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  const uncompressed =
    publicKey.length === 65 ? publicKey : secp.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  const hashed = keccak256(uncompressed.slice(1)).slice(-20); // drop the 0x04 marker, keep low 20 bytes

  let lower = "";
  for (const b of hashed) lower += HEX[b >> 4] + HEX[b & 0x0f];

  const hashOfLower = keccak256(textEncoder.encode(lower));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const nibble = i % 2 === 0 ? hashOfLower[i >> 1]! >> 4 : hashOfLower[i >> 1]! & 0x0f;
    const ch = lower[i]!;
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** The address a follower must `approveAgent`, derived from the enclave's published master public key. */
export function deriveAgentAddress(masterPubCompressed: Uint8Array, follower: string): string {
  return addressFromPublicKey(deriveAgentPublicKey(masterPubCompressed, follower));
}
