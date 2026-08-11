import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { eciesEncrypt, eciesDecrypt, concatKDF, normalizePublicKey, bytesToHex } from "../src/ecies.js";

const priv = secp256k1.utils.randomPrivateKey();
const pub = secp256k1.getPublicKey(priv, false);

function bytes(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

describe("go-ethereum ECIES (ECIES_AES128_SHA256)", () => {
  it("round-trips a message", () => {
    const msg = new TextEncoder().encode("the strategy stays secret");
    expect(eciesDecrypt(priv, eciesEncrypt(pub, msg))).toEqual(msg);
  });

  it("round-trips an empty message and a multi-block message", () => {
    for (const len of [0, 1, 15, 16, 17, 1024]) {
      const msg = new Uint8Array(len).map((_, i) => i % 251);
      expect(eciesDecrypt(priv, eciesEncrypt(pub, msg))).toEqual(msg);
    }
  });

  it("produces the geth wire layout: 65-byte pubkey ‖ 16-byte iv ‖ ct ‖ 32-byte mac", () => {
    const msg = new Uint8Array(40);
    const ct = eciesEncrypt(pub, msg);

    expect(ct.length).toBe(65 + 16 + 40 + 32);
    expect(ct[0]).toBe(0x04); // uncompressed ephemeral point
    secp256k1.ProjectivePoint.fromHex(ct.subarray(0, 65)).assertValidity();
  });

  it("is non-deterministic across calls (fresh ephemeral key + iv)", () => {
    const msg = new TextEncoder().encode("same plaintext");
    expect(bytesToHex(eciesEncrypt(pub, msg))).not.toBe(bytesToHex(eciesEncrypt(pub, msg)));
  });

  it("is deterministic when the ephemeral key and iv are pinned", () => {
    const ephemeral = { privateKey: secp256k1.utils.randomPrivateKey(), iv: new Uint8Array(16).fill(7) };
    const msg = new TextEncoder().encode("pinned");

    const a = eciesEncrypt(pub, msg, ephemeral);
    const b = eciesEncrypt(pub, msg, ephemeral);

    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(eciesDecrypt(priv, a)).toEqual(msg);
  });

  it("rejects a tampered ciphertext, iv, or mac", () => {
    const ct = eciesEncrypt(pub, new TextEncoder().encode("authentic"));

    for (const i of [70, 90, ct.length - 1]) {
      const tampered = Uint8Array.from(ct);
      tampered[i]! ^= 0xff;
      expect(() => eciesDecrypt(priv, tampered)).toThrow(/invalid MAC/);
    }
  });

  it("rejects decryption with the wrong private key", () => {
    const ct = eciesEncrypt(pub, new TextEncoder().encode("not for you"));
    expect(() => eciesDecrypt(secp256k1.utils.randomPrivateKey(), ct)).toThrow(/invalid MAC/);
  });

  it("rejects a truncated ciphertext", () => {
    expect(() => eciesDecrypt(priv, new Uint8Array(80))).toThrow(/too short/);
  });

  /**
   * geth's concatKDF: K_i = SHA256(counter_be32 ‖ z ‖ s1). Pinned against a hand-computed vector so a
   * refactor cannot silently change the derivation (which would break node interop invisibly).
   */
  it("matches the NIST SP 800-56 concat KDF construction", () => {
    const z = bytes(1, 2, 3, 4);
    const block1 = sha256(new Uint8Array([0, 0, 0, 1, ...z]));
    const block2 = sha256(new Uint8Array([0, 0, 0, 2, ...z]));

    expect(concatKDF(z, new Uint8Array(0), 32)).toEqual(block1);
    expect(concatKDF(z, new Uint8Array(0), 16)).toEqual(block1.subarray(0, 16));
    expect(concatKDF(z, new Uint8Array(0), 48)).toEqual(new Uint8Array([...block1, ...block2.subarray(0, 16)]));
  });

  describe("public key normalization", () => {
    it("accepts uncompressed, compressed, bare X‖Y, and hex forms", () => {
      const compressed = secp256k1.getPublicKey(priv, true);
      const expected = bytesToHex(pub);

      expect(bytesToHex(normalizePublicKey(pub))).toBe(expected);
      expect(bytesToHex(normalizePublicKey(compressed))).toBe(expected);
      expect(bytesToHex(normalizePublicKey(pub.subarray(1)))).toBe(expected);
      expect(bytesToHex(normalizePublicKey(bytesToHex(pub)))).toBe(expected);
      expect(bytesToHex(normalizePublicKey(bytesToHex(pub).slice(2)))).toBe(expected);
    });

    it("rejects an off-curve or malformed key", () => {
      const offCurve = Uint8Array.from(pub);
      offCurve[64]! ^= 0xff;
      expect(() => normalizePublicKey(offCurve)).toThrow();
      expect(() => normalizePublicKey(new Uint8Array(10))).toThrow(/unsupported public key encoding/);
    });
  });
});
