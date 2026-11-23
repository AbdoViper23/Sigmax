import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  authPayload,
  eciesDecrypt,
  eciesEncrypt,
  encodeSignal,
  mapKeys,
  policyFromScVal,
  policyToScVal,
  prepareSignal,
  swapInvocation,
  swapMessage,
  swapProofToScVal,
  TESTNET_PASSPHRASE,
  type Policy,
  type SwapPlan,
} from "../src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const POOL = "CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD";
const VAULT = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const LEADER = "GCJRIDGV4EFTNEDBF4VRJLLA66LSJ5KYLGAK5E5HIODF6MZRYEAJI44X";

describe("ECIES (go-ethereum compatible)", () => {
  it("decrypts the go-ethereum vector the Rust enclave also decrypts", () => {
    const v = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/geth-ecies-vector.json", import.meta.url)), "utf-8"),
    ) as { privateKey: string; ciphertext: string; expectedPlaintext: string };
    expect(hex(eciesDecrypt(unhex(v.privateKey), unhex(v.ciphertext)))).toBe(v.expectedPlaintext.slice(2));
  });

  it("round-trips", () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const msg = new TextEncoder().encode("the strategy stays secret");
    expect(eciesDecrypt(priv, eciesEncrypt(secp256k1.getPublicKey(priv, false), msg))).toEqual(msg);
  });
});

describe("signal format", () => {
  const base = { kind: "entry" as const, leader: LEADER, base: "XLM", quote: "USDC", sizeBps: 2500 };

  it("serializes in the field order the enclave expects", () => {
    const json = encodeSignal({ ...base, takeProfit: "0.16", stopLoss: "0.12", salt: "ab".repeat(32), ts: 1795060000 });
    expect(json).toBe(
      `{"v":1,"kind":"entry","leader":"${LEADER}","base":"XLM","quote":"USDC","size_bps":2500,"take_profit":"0.16","stop_loss":"0.12","salt":"${"ab".repeat(32)}","ts":1795060000}`,
    );
  });

  it("commits to the sealed bytes and only the enclave key opens them", () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const prepared = prepareSignal({ ...base, salt: "cd".repeat(32), ts: 1 }, secp256k1.getPublicKey(priv, false));
    const opened = eciesDecrypt(priv, unhex(prepared.ciphertextHex));
    expect(hex(sha256(opened))).toBe(prepared.commitmentHex);
    expect(JSON.parse(new TextDecoder().decode(opened)).size_bps).toBe(2500);
  });

  it("gives every signal a fresh salt by default", () => {
    expect(encodeSignal({ ...base, ts: 1 })).not.toBe(encodeSignal({ ...base, ts: 1 }));
  });

  it("rejects what the enclave would reject", () => {
    expect(() => encodeSignal({ ...base, sizeBps: 0 })).toThrow(/sizeBps/);
    expect(() => encodeSignal({ ...base, base: "xlm" })).toThrow(/ticker/);
    expect(() => encodeSignal({ ...base, quote: "XLM" })).toThrow(/different/);
    expect(() => encodeSignal({ ...base, leader: "GBAD" })).toThrow(/leader/);
    expect(() => encodeSignal({ ...base, kind: "close" })).toThrow(/entryRef/);
    expect(() => encodeSignal({ ...base, takeProfit: "-1" })).toThrow(/takeProfit/);
  });
});

describe("contract encoding", () => {
  const policy: Policy = {
    leader: LEADER,
    assets: [
      { token: USDC, symbol: "USDC", decimals: 7 },
      { token: XLM, symbol: "XLM", decimals: 7 },
    ],
    venues: [{ pool: POOL, tokens: [USDC, XLM] }],
    maxTradeBps: 5000,
    maxTradeUsd: 1_000n * 10_000_000n,
    maxDailyUsd: 3_000n * 10_000_000n,
    maxDailyTrades: 5,
    maxSlippageBps: 250,
    maxSignalAgeSecs: 3600n,
    maxOracleAgeSecs: 900n,
    expiresAt: 1_800_000_000n,
  };

  it("encodes a policy as a sorted symbol-keyed map and decodes it back", () => {
    const v = policyToScVal(policy);
    const keys = mapKeys(v);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("max_slippage_bps");
    expect(policyFromScVal(xdr.ScVal.fromXDR(v.toXDR()))).toEqual(policy);
  });

  it("encodes a swap proof the way the vault's SwapProof decodes", () => {
    const v = swapProofToScVal({ signal: new Uint8Array(32).fill(1), expiresAtLedger: 99, signature: new Uint8Array(64).fill(2) });
    expect(mapKeys(v)).toEqual(["expires_at_ledger", "signal", "signature"]);
    expect(scValToNative(v).expires_at_ledger).toBe(99);
  });
});

describe("swap authorization", () => {
  const plan: SwapPlan = { pool: POOL, tokenIn: USDC, tokenOut: XLM, inIdx: 0, outIdx: 1, amountIn: 5_000_000_000n, minOut: 35_000_000_000n };

  /** Same vectors as `stellar/enclave/src/auth.rs` (`shared_vectors`), computed there with stellar-xdr. */
  it("computes the same authorization payload as the Rust enclave", () => {
    const inv = swapInvocation(VAULT, plan);
    expect(authPayload(TESTNET_PASSPHRASE, 42n, 5050, inv).toString("hex")).toBe(
      "e998ddcef4175658c6a6ae9376a6847c0f93f85d5c0b6379e30a4f93939aaea1",
    );
    expect(authPayload(TESTNET_PASSPHRASE, -7n, 5050, inv).toString("hex")).toBe(
      "ca574cc86bd298e230d076e516d5917004739aa1bf6492022269908b0057dc3f",
    );
  });

  it("builds the swap message byte layout and it verifies under the signer's key", () => {
    const msg = swapMessage(new Uint8Array(32).fill(0xab), new Uint8Array(32).fill(0x11), 0x01020304);
    expect(new TextDecoder().decode(msg.slice(0, 14))).toBe("SIGMAX/swap/v1");
    expect(Array.from(msg.slice(78))).toEqual([1, 2, 3, 4]);
    const kp = Keypair.random();
    expect(kp.verify(Buffer.from(msg), kp.sign(Buffer.from(msg)))).toBe(true);
  });
});
