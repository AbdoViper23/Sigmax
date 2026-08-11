/**
 * go-ethereum-compatible ECIES (`ECIES_AES128_SHA256` over secp256k1) — the exact scheme the FCC
 * tee-node's `/decrypt` endpoint expects (`ecies.Encrypt(pub, msg, nil, nil)` in Go).
 *
 * Implemented on `@noble/*` so it runs unchanged in the browser: the leader's plaintext signal is
 * encrypted CLIENT-SIDE to the enclave's public key and only ciphertext ever leaves the machine.
 * `eciesjs` is deliberately NOT used — it is AES-256-GCM/HKDF, which the Go node cannot decrypt.
 *
 * Wire format (matches geth byte-for-byte):
 *   ephemeralPubKey (65, uncompressed) ‖ iv (16) ‖ ciphertext (AES-128-CTR) ‖ mac (32, HMAC-SHA-256)
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { ctr } from "@noble/ciphers/aes";

const KEY_LEN = 16; // AES-128
const BLOCK_SIZE = 16; // AES block / IV size
const PUB_LEN = 65; // uncompressed secp256k1 point
const MAC_LEN = 32; // HMAC-SHA-256

/**
 * NIST SP 800-56 Concatenation KDF (geth's `concatKDF`): repeatedly hash
 * `counter_be32 ‖ z ‖ s1` until `kdLen` bytes are produced.
 */
export function concatKDF(z: Uint8Array, s1: Uint8Array, kdLen: number): Uint8Array {
  const out = new Uint8Array(kdLen);
  let written = 0;
  for (let counter = 1; written < kdLen; counter++) {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, counter, false); // big-endian
    const block = sha256(concatBytes(prefix, z, s1));
    const take = Math.min(block.length, kdLen - written);
    out.set(block.subarray(0, take), written);
    written += take;
  }
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd-length hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): `0x${string}` {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Normalize a TEE public key to the 65-byte uncompressed form. Accepts hex (with or without `0x`),
 * compressed (33 bytes), uncompressed (65), or the bare 64-byte X‖Y the node sometimes reports.
 */
export function normalizePublicKey(pub: string | Uint8Array): Uint8Array {
  let bytes = typeof pub === "string" ? hexToBytes(pub) : pub;
  if (bytes.length === 64) bytes = concatBytes(new Uint8Array([0x04]), bytes);
  if (bytes.length === 33) bytes = secp256k1.ProjectivePoint.fromHex(bytes).toRawBytes(false);
  if (bytes.length !== PUB_LEN || bytes[0] !== 0x04) {
    throw new Error(`unsupported public key encoding (${bytes.length} bytes)`);
  }
  secp256k1.ProjectivePoint.fromHex(bytes).assertValidity(); // reject off-curve keys
  return bytes;
}

/** Derive the (Ke, Km) pair from an ECDH shared X coordinate, exactly as geth does. */
function deriveKeys(sharedX: Uint8Array): { ke: Uint8Array; km: Uint8Array } {
  const k = concatKDF(sharedX, new Uint8Array(0), KEY_LEN * 2);
  return { ke: k.subarray(0, KEY_LEN), km: sha256(k.subarray(KEY_LEN)) };
}

/**
 * Encrypt `message` to the enclave's public key.
 * @param ephemeral Test-only injection point for the ephemeral key + IV; production uses CSPRNG.
 */
export function eciesEncrypt(
  publicKey: string | Uint8Array,
  message: Uint8Array,
  ephemeral?: { privateKey: Uint8Array; iv: Uint8Array },
): Uint8Array {
  const pub = normalizePublicKey(publicKey);
  const ephPriv = ephemeral?.privateKey ?? secp256k1.utils.randomPrivateKey();
  const iv = ephemeral?.iv ?? crypto.getRandomValues(new Uint8Array(BLOCK_SIZE));
  if (iv.length !== BLOCK_SIZE) throw new Error("iv must be 16 bytes");

  // ECDH shared secret is the X coordinate only (geth's GenerateShared).
  const sharedX = secp256k1.getSharedSecret(ephPriv, pub, true).subarray(1);
  const { ke, km } = deriveKeys(sharedX);

  const ciphertext = ctr(ke, iv).encrypt(message);
  const em = concatBytes(iv, ciphertext);
  const mac = hmac(sha256, km, em); // s2 is empty
  const ephPub = secp256k1.getPublicKey(ephPriv, false);

  return concatBytes(ephPub, em, mac);
}

/** Decrypt with the enclave private key — used by tests and tooling, never in the browser. */
export function eciesDecrypt(privateKey: Uint8Array, ct: Uint8Array): Uint8Array {
  if (ct.length < PUB_LEN + BLOCK_SIZE + MAC_LEN) throw new Error("ciphertext too short");
  const ephPub = ct.subarray(0, PUB_LEN);
  const em = ct.subarray(PUB_LEN, ct.length - MAC_LEN);
  const mac = ct.subarray(ct.length - MAC_LEN);

  const sharedX = secp256k1.getSharedSecret(privateKey, ephPub, true).subarray(1);
  const { ke, km } = deriveKeys(sharedX);

  const expected = hmac(sha256, km, em);
  if (!timingSafeEqual(expected, mac)) throw new Error("invalid MAC");

  return ctr(ke, em.subarray(0, BLOCK_SIZE)).decrypt(em.subarray(BLOCK_SIZE));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
