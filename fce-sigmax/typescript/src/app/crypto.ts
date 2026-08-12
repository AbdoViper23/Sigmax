/** Cryptographic utilities: ECDSA signing and key parsing. */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import * as secp from '@noble/secp256k1';
import { keccak256 } from '../base/crypto.js';

// Configure @noble/secp256k1 to use synchronous HMAC-SHA256.
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => {
  return hmac(sha256, k, secp.etc.concatBytes(...m));
};

/** Pad a byte array to the specified length with leading zeros. */
function padLeft(b: Uint8Array, size: number): Uint8Array {
  if (b.length >= size) {
    return b.slice(b.length - size);
  }
  const result = new Uint8Array(size);
  result.set(b, size - b.length);
  return result;
}

/** Convert a bigint to a Uint8Array (big-endian). */
function bigintToBytes(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(2, '0');
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Sign a PRE-HASHED 32-byte digest with ECDSA on secp256k1.
 * Returns 65 bytes: r (32) || s (32) || v (1).
 *
 * Split out from `signECDSA` because EIP-712 digests (Hyperliquid action signing) are already the
 * final hash — running Keccak over them a second time yields a signature the counterparty rejects.
 */
export function signDigestECDSA(
  privateKey: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  const sig = secp.sign(digest, privateKey);
  const r = padLeft(bigintToBytes(sig.r), 32);
  const s = padLeft(bigintToBytes(sig.s), 32);

  // Recovery ID: sig.recovery is 0 or 1, Ethereum convention adds 27
  const v = (sig.recovery ?? 0) + 27;

  const result = new Uint8Array(65);
  result.set(r, 0);
  result.set(s, 32);
  result[64] = v;

  return result;
}

/**
 * Sign a message with ECDSA on secp256k1.
 * The message is hashed with Keccak-256 before signing.
 * Returns 65 bytes: r (32) || s (32) || v (1).
 */
export function signECDSA(
  privateKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  return signDigestECDSA(privateKey, keccak256(message));
}

/**
 * Ethereum address for a private key: keccak256 of the uncompressed public key (minus its 0x04
 * prefix), last 20 bytes, EIP-55 checksummed.
 *
 * Used to publish the enclave's Hyperliquid agent ADDRESS without exposing the key: a follower must
 * know which address to `approveAgent`, and that address should demonstrably come from the enclave.
 */
export function addressFromPrivateKey(privateKey: Uint8Array): string {
  const pubkey = secp.getPublicKey(privateKey, false).slice(1); // drop the 0x04 uncompressed marker
  const hashed = keccak256(pubkey).slice(-20);
  return toChecksumAddress(hashed);
}

const HEX = '0123456789abcdef';

/** EIP-55 checksum encoding of 20 address bytes. */
function toChecksumAddress(addr: Uint8Array): string {
  let lower = '';
  for (const b of addr) lower += HEX[b >> 4] + HEX[b & 0x0f];

  const hashOfLower = keccak256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    // Each hex nibble of the hash decides the case of the corresponding address nibble.
    const nibble = i % 2 === 0 ? hashOfLower[i >> 1]! >> 4 : hashOfLower[i >> 1]! & 0x0f;
    const ch = lower[i]!;
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/**
 * Validate raw bytes as a secp256k1 private key scalar.
 * Returns the 32-byte key.
 */
export function parsePrivateKey(b: Uint8Array): Uint8Array {
  if (b.length === 0) {
    throw new Error('key bytes are empty');
  }
  if (b.length > 32) {
    throw new Error(`key too long: ${b.length} bytes`);
  }

  // Check it's not zero
  let allZero = true;
  for (const byte of b) {
    if (byte !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new Error('key is zero');
  }

  // Pad to 32 bytes
  const key = padLeft(b, 32);

  // Verify it's a valid secp256k1 private key by trying to get the public key
  try {
    secp.getPublicKey(key);
  } catch {
    throw new Error('key >= curve order');
  }

  return key;
}
