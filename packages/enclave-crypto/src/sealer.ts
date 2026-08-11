/**
 * `EnclaveSignalSealer` — the confidentiality primitive of the whole product.
 *
 * The leader ABI-encodes the signal and ECIES-encrypts it to the FCC
 * enclave's published public key, **in the browser**. Only ciphertext leaves the client; the
 * plaintext exists in exactly two places — the leader's tab and the enclave's memory. Nothing on
 * this path can decrypt a signal, which is why `accessSignal` is unimplementable here by design.
 */

import { encodeSignal, type Signal } from "@sigmax/shared";
import type { SealedSignalPort } from "./port.js";
import { eciesEncrypt, bytesToHex, normalizePublicKey } from "./ecies.js";

/**
 * The enclave's secp256k1 public key as the proxy reports it. tee-node serves it as the affine
 * coordinate pair, not as an encoded key — see the note on `coordsToUncompressed`.
 */
type ProxyPublicKey = string | { x?: string; y?: string };

/** Shape of the `machineData` block returned by the ext-proxy's `/info` endpoint. */
interface ProxyInfo {
  machineData?: { publicKey?: ProxyPublicKey; teeAddress?: string; extensionId?: string; codeHash?: string };
}

/**
 * Assemble SEC1 uncompressed form (`0x04 ‖ x ‖ y`) from the coordinate pair.
 *
 * tee-node v0.0.25 reports `machineData.publicKey` as `{x, y}` hex strings, NOT as an encoded key
 * string. Each coordinate is left-padded to 32 bytes: Go emits them via big.Int hex, which drops
 * leading zeros, so a key with a small x would otherwise assemble one byte short and fail to parse.
 *
 * Note this is the enclave's *encryption* key. The TEE's *signing* identity is the registered
 * machine address and is a different key — do not derive one from the other.
 */
function coordsToUncompressed(x: string, y: string): string {
  const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
  const px = strip(x).padStart(64, "0");
  const py = strip(y).padStart(64, "0");
  if (px.length !== 64 || py.length !== 64) {
    throw new Error(`enclave public key coordinates are not 32 bytes (x=${px.length / 2}B, y=${py.length / 2}B)`);
  }
  return `0x04${px}${py}`;
}

export interface EnclaveKeySource {
  /** Fetch the enclave's secp256k1 public key (uncompressed or compressed hex). */
  fetchPublicKey(): Promise<string>;
}

/** Reads the enclave public key from the FCC ext-proxy `/info` endpoint. */
export class ProxyEnclaveKeySource implements EnclaveKeySource {
  constructor(
    private readonly proxyUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchPublicKey(): Promise<string> {
    const res = await this.fetchImpl(`${this.proxyUrl.replace(/\/$/, "")}/info`);
    if (!res.ok) throw new Error(`proxy /info failed (${res.status})`);
    const info = (await res.json()) as ProxyInfo;
    const key = info.machineData?.publicKey;
    if (!key) throw new Error("proxy /info did not report machineData.publicKey");
    if (typeof key === "string") return key;
    if (!key.x || !key.y) throw new Error("proxy /info publicKey is missing an x or y coordinate");
    return coordsToUncompressed(key.x, key.y);
  }
}

/** A key source pinned to a known public key (tests, or a key baked into the deployment config). */
export class StaticEnclaveKeySource implements EnclaveKeySource {
  constructor(private readonly publicKey: string) {}
  async fetchPublicKey(): Promise<string> {
    return this.publicKey;
  }
}

export interface SealedSignal {
  /** The ECIES ciphertext to pass to `InstructionSender.publishSignal`. */
  ciphertext: `0x${string}`;
  /** keccak256 of the ciphertext is computed on-chain; kept here only for display/logging. */
  byteLength: number;
}

export class EnclaveSignalSealer implements SealedSignalPort {
  private cachedKey: Uint8Array | null = null;

  constructor(private readonly keySource: EnclaveKeySource) {}

  /** Fetch (once) and validate the enclave public key. */
  async enclavePublicKey(): Promise<Uint8Array> {
    if (this.cachedKey === null) {
      this.cachedKey = normalizePublicKey(await this.keySource.fetchPublicKey());
    }
    return this.cachedKey;
  }

  /**
   * Encrypt a signal to the enclave. Returns the ciphertext for the caller to submit on-chain —
   * this class never touches a wallet, so publishing stays an explicit, user-signed action.
   */
  async encryptSignal(signal: Signal): Promise<SealedSignal> {
    const key = await this.enclavePublicKey();
    const plaintext = hexToBytes(encodeSignal(signal));
    const ct = eciesEncrypt(key, plaintext);
    return { ciphertext: bytesToHex(ct), byteLength: ct.length };
  }

  /**
   * @deprecated On Flare the ciphertext is submitted by the leader's own wallet via
   * `InstructionSender.publishSignal`. Use {@link encryptSignal} and send the transaction from the UI.
   */
  async publishSignal(): Promise<{ uuid: number }> {
    throw new Error(
      "EnclaveSignalSealer does not publish on the leader's behalf — call encryptSignal() and submit the ciphertext with the user's wallet",
    );
  }

  /**
   * Not implementable, deliberately: only the enclave holds the decryption key. If this ever
   * becomes possible, confidentiality has been broken.
   */
  async accessSignal(): Promise<Signal> {
    throw new Error("signals are decryptable only inside the TEE");
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
