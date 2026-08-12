/**
 * These vectors are the contract between two vendored copies of the same derivation.
 *
 * The enclave derives a follower's agent PRIVATE key; this package derives the matching PUBLIC address
 * so the browser can show the follower exactly which address they are approving. The two live in
 * separate npm projects and cannot import each other, so the only thing keeping them honest is that
 * `fce-sigmax/typescript/src/__tests__/hl-agent-key.test.ts` asserts the SAME hard-coded addresses
 * below. If either implementation drifts, one of the two suites fails — instead of followers approving
 * an address the enclave never signs with, and every order being rejected as an unapproved signer.
 *
 * Do not "fix" a mismatch by updating these numbers. Find which side moved.
 */

import { describe, expect, it } from "vitest";
import {
  addressFromPublicKey,
  deriveHlAgentAddress,
  deriveHlAgentPublicKey,
} from "../src/hlAgentAddress.js";

/** Master public key for the fixture secret 0x2222…22, as published by the enclave's `/state`. */
const MASTER_PUB = "0x02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";

const VECTORS: [follower: string, agent: string][] = [
  ["0x1111111111111111111111111111111111111111", "0x1039D231DEbA92c8EB5083A8dAc49236F5459D57"],
  ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "0x80FF2130Fe204a0818B49EaCD370931ae9d54188"],
];

describe("hyperliquid agent address derivation", () => {
  it("matches the enclave's derivation for known followers", () => {
    for (const [follower, expected] of VECTORS) {
      expect(deriveHlAgentAddress(MASTER_PUB, follower)).toBe(expected);
    }
  });

  /** The registry emits checksummed addresses; a wallet may hand us a lower-cased one. */
  it("is insensitive to the case of the follower address", () => {
    const [follower, expected] = VECTORS[0]!;
    expect(deriveHlAgentAddress(MASTER_PUB, follower.toLowerCase())).toBe(expected);
    expect(deriveHlAgentAddress(MASTER_PUB, follower.toUpperCase().replace("0X", "0x"))).toBe(expected);
  });

  it("gives every follower a distinct agent address", () => {
    const addresses = VECTORS.map(([f]) => deriveHlAgentAddress(MASTER_PUB, f));
    expect(new Set(addresses).size).toBe(VECTORS.length);
  });

  /** An uncompressed master key must derive the same agent as its compressed form. */
  it("accepts either public key encoding", () => {
    const uncompressed = addressFromPublicKey(MASTER_PUB); // sanity: the master's own address
    expect(uncompressed).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const [follower, expected] = VECTORS[0]!;
    const compressedChild = deriveHlAgentPublicKey(MASTER_PUB, follower);
    expect(compressedChild).toHaveLength(33);
    expect(addressFromPublicKey(compressedChild)).toBe(expected);
  });

  it("a different master key yields a different agent address", () => {
    const other = "0x0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const [follower] = VECTORS[0]!;
    expect(deriveHlAgentAddress(other, follower)).not.toBe(deriveHlAgentAddress(MASTER_PUB, follower));
  });
});
