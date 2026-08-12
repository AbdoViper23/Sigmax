/**
 * DIFFERENTIAL TEST — the gate on the hand-written Hyperliquid signing path.
 *
 * We deliberately do NOT ship `@nktkas/hyperliquid` inside the enclave: it is 7.7 MB across three
 * transitive packages, and everything in the image is attested surface. Instead the ~150 lines we
 * need are implemented locally (`hl/msgpack.ts`, `hl/sign.ts`) and pinned here against the real SDK,
 * which is a **devDependency only** — the Dockerfile runs `npm prune --omit=dev`, so it never reaches
 * the runtime image.
 *
 * Every assertion below is byte-equality against the reference. If a future refactor drifts by one
 * byte, the action hash changes, Hyperliquid rejects the signature, and orders silently stop filling
 * in production — this suite is what makes that failure loud and immediate instead.
 */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createL1ActionHash as sdkCreateL1ActionHash,
  signL1Action as sdkSignL1Action,
} from "@nktkas/hyperliquid/signing";
import { createL1ActionHash, signL1Action } from "../app/sigmax/hl/sign.js";
import { encodeMsgpack, prepareAction } from "../app/sigmax/hl/msgpack.js";
import { addressFromPrivateKey } from "../app/crypto.js";
import { hexToBytes } from "../base/encoding.js";

const PK = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const PK_BYTES = hexToBytes(PK);
const wallet = privateKeyToAccount(PK);

/** The exact action shape the enclave builds for a spot IOC order. Field order is load-bearing. */
function orderAction(overrides: Partial<{ a: number; b: boolean; p: string; s: string }> = {}) {
  return {
    type: "order",
    orders: [
      {
        a: overrides.a ?? 10_001,
        b: overrides.b ?? true,
        p: overrides.p ?? "2.1234",
        s: overrides.s ?? "5.5",
        r: false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  };
}

describe("hyperliquid action hashing matches the reference SDK", () => {
  it("agrees on a spot IOC buy", () => {
    const action = orderAction();
    const nonce = 1_700_000_000_000;
    expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
  });

  it("agrees on a sell", () => {
    const action = orderAction({ b: false, p: "0.00012345", s: "1234.5678" });
    const nonce = 1_700_000_000_001;
    expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
  });

  /**
   * `Date.now()` is ~1.7e12, far past uint32. The reference promotes such integers to bigint so they
   * encode as a fixed-width uint64; without that they would degrade to float64 and every signature
   * would be wrong. This is the single most load-bearing case in the file.
   */
  it("agrees on nonces past uint32 (the real-world case)", () => {
    const action = orderAction();
    for (const nonce of [1, 255, 65_535, 4_294_967_295, 4_294_967_296, 1_755_000_000_123]) {
      expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
    }
  });

  it("agrees on multi-order batches (array and map widths past their fix forms)", () => {
    const action = {
      type: "order",
      orders: Array.from({ length: 20 }, (_, i) => ({
        a: 10_000 + i,
        b: i % 2 === 0,
        p: `${i + 1}.5`,
        s: `${i + 1}`,
        r: false,
        t: { limit: { tif: "Ioc" as const } },
      })),
      grouping: "na",
    };
    const nonce = 1_755_000_000_456;
    expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
  });

  it("agrees when a vault address is present", () => {
    const action = orderAction();
    const nonce = 1_755_000_000_789;
    const vaultAddress = "0x1234567890abcdef1234567890abcdef12345678" as const;
    expect(createL1ActionHash({ action, nonce, vaultAddress })).toBe(
      sdkCreateL1ActionHash({ action, nonce, vaultAddress }),
    );
  });

  it("agrees when expiresAfter is present", () => {
    const action = orderAction();
    const nonce = 1_755_000_000_999;
    const expiresAfter = 1_755_000_060_000;
    expect(createL1ActionHash({ action, nonce, expiresAfter })).toBe(
      sdkCreateL1ActionHash({ action, nonce, expiresAfter }),
    );
  });

  it("agrees on a cancel action (different action shape entirely)", () => {
    const action = { type: "cancel", cancels: [{ a: 10_001, o: 987_654_321 }] };
    const nonce = 1_755_000_001_111;
    expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
  });

  it("agrees on strings past the fixstr boundary", () => {
    // 31 chars is the last fixstr; 32 crosses into str8.
    for (const len of [31, 32, 255, 256]) {
      const action = { type: "x".repeat(len), orders: [], grouping: "na" };
      const nonce = 1_755_000_002_222;
      expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
    }
  });

  it("drops undefined keys exactly like the reference", () => {
    const action = { type: "order", orders: [], grouping: "na", extra: undefined } as never;
    const nonce = 1_755_000_003_333;
    expect(createL1ActionHash({ action, nonce })).toBe(sdkCreateL1ActionHash({ action, nonce }));
  });
});

describe("hyperliquid signatures match the reference SDK", () => {
  it("produces an identical signature on testnet", async () => {
    const action = orderAction();
    const nonce = 1_755_000_004_444;
    const mine = signL1Action({ privateKey: PK_BYTES, action, nonce, isTestnet: true });
    const theirs = await sdkSignL1Action({ wallet, action, nonce, isTestnet: true });
    expect(mine).toEqual(theirs);
  });

  /** `source` is the only difference between the two networks — a swap here would sign for the wrong one. */
  it("produces an identical signature on mainnet, and a different one from testnet", async () => {
    const action = orderAction();
    const nonce = 1_755_000_005_555;
    const mine = signL1Action({ privateKey: PK_BYTES, action, nonce, isTestnet: false });
    const theirs = await sdkSignL1Action({ wallet, action, nonce, isTestnet: false });
    expect(mine).toEqual(theirs);

    const testnetSig = signL1Action({ privateKey: PK_BYTES, action, nonce, isTestnet: true });
    expect(testnetSig.r).not.toBe(mine.r);
  });

  it("produces an identical signature across a batch of orders", async () => {
    const action = {
      type: "order",
      orders: [
        { a: 10_001, b: true, p: "1.5", s: "10", r: false, t: { limit: { tif: "Ioc" as const } } },
        { a: 10_002, b: false, p: "999.25", s: "0.001", r: false, t: { limit: { tif: "Ioc" as const } } },
      ],
      grouping: "na",
    };
    const nonce = 1_755_000_006_666;
    const mine = signL1Action({ privateKey: PK_BYTES, action, nonce, isTestnet: true });
    const theirs = await sdkSignL1Action({ wallet, action, nonce, isTestnet: true });
    expect(mine).toEqual(theirs);
  });
});

describe("msgpack encoder", () => {
  it("encodes the primitive forms at their width boundaries", () => {
    expect(encodeMsgpack(0)).toEqual(new Uint8Array([0x00]));
    expect(encodeMsgpack(127)).toEqual(new Uint8Array([0x7f]));
    expect(encodeMsgpack(128)).toEqual(new Uint8Array([0xcc, 0x80]));
    expect(encodeMsgpack(65_535)).toEqual(new Uint8Array([0xcd, 0xff, 0xff]));
    expect(encodeMsgpack(-1)).toEqual(new Uint8Array([0xff]));
    expect(encodeMsgpack(-32)).toEqual(new Uint8Array([0xe0]));
    expect(encodeMsgpack(-33)).toEqual(new Uint8Array([0xd0, 0xdf]));
    expect(encodeMsgpack(true)).toEqual(new Uint8Array([0xc3]));
    expect(encodeMsgpack(false)).toEqual(new Uint8Array([0xc2]));
    expect(encodeMsgpack(null)).toEqual(new Uint8Array([0xc0]));
    expect(encodeMsgpack("")).toEqual(new Uint8Array([0xa0]));
    expect(encodeMsgpack("ab")).toEqual(new Uint8Array([0xa2, 0x61, 0x62]));
  });

  it("promotes integers past uint32 to a fixed-width uint64 rather than float64", () => {
    // Without prepareAction this would encode as 0xcb (float64) and every hash would be wrong.
    expect(encodeMsgpack(prepareAction(4_294_967_296))).toEqual(
      new Uint8Array([0xcf, 0, 0, 0, 1, 0, 0, 0, 0]),
    );
  });

  it("preserves map key insertion order rather than sorting", () => {
    const ab = encodeMsgpack({ a: 1, b: 2 });
    const ba = encodeMsgpack({ b: 2, a: 1 });
    expect(ab).not.toEqual(ba);
  });

  it("refuses values it does not understand instead of guessing", () => {
    expect(() => encodeMsgpack(new Date() as never)).toThrow(/plain objects/);
  });
});

describe("agent address derivation", () => {
  it("matches viem for the same key", () => {
    expect(addressFromPrivateKey(PK_BYTES)).toBe(wallet.address);
  });
});
