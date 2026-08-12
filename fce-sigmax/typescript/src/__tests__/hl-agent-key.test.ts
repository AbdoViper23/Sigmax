/**
 * The property this suite exists to pin: the enclave (holding the master SECRET) and a follower's
 * wallet (holding only the master PUBLIC key) must independently arrive at the same agent address.
 * If they ever disagree, followers approve one address while the enclave signs with another, and
 * every order is rejected by Hyperliquid as an unapproved signer.
 */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  addressFromPublicKey,
  deriveAgentAddress,
  deriveAgentPrivateKey,
  deriveAgentPublicKey,
  masterPublicKey,
} from "../app/sigmax/hl/agent-key.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";

const MASTER = hexToBytes("0x2222222222222222222222222222222222222222222222222222222222222222");
const MASTER_PUB = masterPublicKey(MASTER);

const FOLLOWERS = [
  "0x1111111111111111111111111111111111111111",
  "0x86a072E0b3B0dF3b0f1Dc4b0e4bA0eF0c0d0A0b0",
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
];

describe("per-follower agent key derivation", () => {
  it("public-side derivation matches private-side derivation", () => {
    for (const follower of FOLLOWERS) {
      const priv = deriveAgentPrivateKey(MASTER, follower);
      const pubFromPriv = masterPublicKey(priv);
      const pubFromMaster = deriveAgentPublicKey(MASTER_PUB, follower);
      expect(bytesToHex(pubFromPriv)).toBe(bytesToHex(pubFromMaster));
    }
  });

  /** The address a follower approves must be the address the enclave signs with — checked via viem. */
  it("derives an address viem agrees the child key controls", () => {
    for (const follower of FOLLOWERS) {
      const priv = deriveAgentPrivateKey(MASTER, follower);
      const viemAddress = privateKeyToAccount(bytesToHex(priv)).address;
      expect(deriveAgentAddress(MASTER_PUB, follower)).toBe(viemAddress);
      expect(addressFromPublicKey(masterPublicKey(priv))).toBe(viemAddress);
    }
  });

  it("gives every follower a distinct agent address", () => {
    const addresses = FOLLOWERS.map((f) => deriveAgentAddress(MASTER_PUB, f));
    expect(new Set(addresses).size).toBe(FOLLOWERS.length);
  });

  /** Case-insensitivity matters: the registry emits checksummed addresses, wallets may not. */
  it("is insensitive to the case of the follower address", () => {
    const lower = FOLLOWERS[1]!.toLowerCase();
    expect(deriveAgentAddress(MASTER_PUB, lower)).toBe(deriveAgentAddress(MASTER_PUB, FOLLOWERS[1]!));
  });

  /** Restart clears the injected key; re-injecting the same secret must not force re-approval. */
  it("is stable across repeated derivations", () => {
    const first = deriveAgentAddress(MASTER_PUB, FOLLOWERS[0]!);
    const second = deriveAgentAddress(masterPublicKey(MASTER), FOLLOWERS[0]!);
    expect(second).toBe(first);
  });

  /**
   * The cross-implementation contract. `@sigmax/enclave-crypto` carries a vendored copy of this
   * derivation so a follower's BROWSER can compute the address it is about to approve, and its test
   * asserts these exact same values (`packages/enclave-crypto/test/hlAgentAddress.test.ts`).
   *
   * If this fails, do not update the numbers — find which of the two copies moved. A silent drift means
   * followers approve an address the enclave never signs with, and every order is rejected as coming
   * from an unapproved signer.
   */
  it("matches the vectors pinned by the browser-side copy", () => {
    expect(bytesToHex(MASTER_PUB)).toBe(
      "0x02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
    );
    expect(deriveAgentAddress(MASTER_PUB, "0x1111111111111111111111111111111111111111")).toBe(
      "0x1039D231DEbA92c8EB5083A8dAc49236F5459D57",
    );
    expect(deriveAgentAddress(MASTER_PUB, "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(
      "0x80FF2130Fe204a0818B49EaCD370931ae9d54188",
    );
  });

  it("a different master secret yields different agent addresses", () => {
    const other = hexToBytes("0x3333333333333333333333333333333333333333333333333333333333333333");
    expect(deriveAgentAddress(masterPublicKey(other), FOLLOWERS[0]!)).not.toBe(
      deriveAgentAddress(MASTER_PUB, FOLLOWERS[0]!),
    );
  });
});
