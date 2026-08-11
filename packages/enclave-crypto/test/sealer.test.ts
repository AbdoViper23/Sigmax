import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { decodeSignal, type Signal } from "@sigmax/shared";
import { EnclaveSignalSealer, StaticEnclaveKeySource, ProxyEnclaveKeySource } from "../src/sealer.js";
import { eciesDecrypt, bytesToHex } from "../src/ecies.js";

const enclavePriv = secp256k1.utils.randomPrivateKey();
const enclavePub = bytesToHex(secp256k1.getPublicKey(enclavePriv, false));

const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const USDT0 = "0x1111111111111111111111111111111111111111";

const signal: Signal = {
  version: 1,
  signalId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  strategyId: "0x2222222222222222222222222222222222222222",
  chainId: 114,
  venue: "flare",
  action: "ENTRY",
  token: FXRP,
  quoteToken: USDT0,
  sizeBps: 500,
  maxEntryPrice: "0",
  takeProfitPrice: "123456789",
  stopLossPrice: "987654321",
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_003_600,
};

function hexToBytes(hex: string): Uint8Array {
  const h = hex.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe("EnclaveSignalSealer", () => {
  const cdr = () => new EnclaveSignalSealer(new StaticEnclaveKeySource(enclavePub));

  it("encrypts a signal that only the enclave key can decrypt back to the original", async () => {
    const { ciphertext } = await cdr().encryptSignal(signal);

    const plaintext = eciesDecrypt(enclavePriv, hexToBytes(ciphertext));
    expect(decodeSignal(bytesToHex(plaintext))).toEqual(signal);
  });

  it("leaks no plaintext field into the ciphertext", async () => {
    const { ciphertext } = await cdr().encryptSignal(signal);
    const hex = ciphertext.toLowerCase();

    expect(hex).not.toContain(FXRP.slice(2).toLowerCase());
    expect(hex).not.toContain(USDT0.slice(2).toLowerCase());
    expect(hex).not.toContain(BigInt(signal.takeProfitPrice).toString(16));
    expect(hex).not.toContain(BigInt(signal.stopLossPrice).toString(16));
    expect(hex).not.toContain(signal.signalId.replace(/-/g, ""));
  });

  it("cannot be decrypted with any key other than the enclave's", async () => {
    const { ciphertext } = await cdr().encryptSignal(signal);
    expect(() => eciesDecrypt(secp256k1.utils.randomPrivateKey(), hexToBytes(ciphertext))).toThrow();
  });

  it("fetches the enclave key once and caches it", async () => {
    const fetchPublicKey = vi.fn(async () => enclavePub);
    const instance = new EnclaveSignalSealer({ fetchPublicKey });

    await instance.encryptSignal(signal);
    await instance.encryptSignal(signal);

    expect(fetchPublicKey).toHaveBeenCalledTimes(1);
  });

  it("refuses to publish or decrypt — those are not this class's job", async () => {
    await expect(cdr().publishSignal()).rejects.toThrow(/does not publish/);
    await expect(cdr().accessSignal()).rejects.toThrow(/only inside the TEE/);
  });

  it("rejects an invalid signal before any encryption happens", async () => {
    const bad = { ...signal, token: "not-an-address" } as Signal;
    await expect(cdr().encryptSignal(bad)).rejects.toThrow();
  });

  describe("ProxyEnclaveKeySource", () => {
    it("reads machineData.publicKey from /info", async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({ machineData: { publicKey: enclavePub } }),
      })) as unknown as typeof fetch;

      const key = await new ProxyEnclaveKeySource("https://proxy.example/", fetchImpl).fetchPublicKey();

      expect(key).toBe(enclavePub);
      expect(fetchImpl).toHaveBeenCalledWith("https://proxy.example/info");
    });

    // What a real tee-node actually serves: the affine coordinate pair, not an encoded key string.
    // The first live run failed here ("unsupported public key encoding"), so this is pinned.
    it("assembles the uncompressed key from the {x, y} pair a real proxy returns", async () => {
      const raw = enclavePub.slice(4); // drop "0x04"
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          machineData: { publicKey: { x: `0x${raw.slice(0, 64)}`, y: `0x${raw.slice(64)}` } },
        }),
      })) as unknown as typeof fetch;

      const key = await new ProxyEnclaveKeySource("https://proxy.example", fetchImpl).fetchPublicKey();

      expect(key).toBe(enclavePub);
    });

    // Go renders coordinates via big.Int hex, which drops leading zeros — left-pad or the key is short.
    it("left-pads coordinates that Go emitted without their leading zeros", async () => {
      const fetchImpl = (async () => ({
        ok: true,
        json: async () => ({ machineData: { publicKey: { x: "0x1a2b", y: "0x3c4d" } } }),
      })) as unknown as typeof fetch;

      const key = await new ProxyEnclaveKeySource("https://p", fetchImpl).fetchPublicKey();

      expect(key).toBe(`0x04${"1a2b".padStart(64, "0")}${"3c4d".padStart(64, "0")}`);
      expect(key).toHaveLength(2 + 2 + 128);
    });

    it("throws when the proxy is unreachable or reports no key", async () => {
      const failing = (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
      await expect(new ProxyEnclaveKeySource("https://p", failing).fetchPublicKey()).rejects.toThrow(/502/);

      const empty = (async () => ({ ok: true, json: async () => ({ machineData: {} }) })) as unknown as typeof fetch;
      await expect(new ProxyEnclaveKeySource("https://p", empty).fetchPublicKey()).rejects.toThrow(/publicKey/);
    });
  });
});
