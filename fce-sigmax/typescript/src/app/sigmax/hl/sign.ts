/**
 * Hyperliquid L1 action hashing and signing — the enclave's half of "authorize a trade off-chain".
 *
 * On Flare the enclave signs a `SwapAuth[]` and the follower's vault verifies it on-chain. Hyperliquid
 * has no on-chain verification to hand a signature to: its only permission primitive is `approveAgent`,
 * an address allowed to place orders (and provably NOT to withdraw — the exchange rejects withdrawals
 * signed by an agent key). So the agent key must live where the plaintext lives — inside the TEE — and
 * this module is what turns it into a signed order.
 *
 * The scheme (matching the reference SDK exactly):
 *   connectionId = keccak256( msgpack(action) ‖ uint64BE(nonce) ‖ vaultMarker ‖ [vault] ‖ [expires] )
 *   signature    = EIP-712 over Agent{ source, connectionId } in the "Exchange" domain on chainId 1337
 *
 * `source` is "a" on mainnet and "b" on testnet — the ONLY thing separating a testnet signature from a
 * mainnet one, which is why it is threaded through explicitly rather than defaulted.
 */

import { hashTypedData, type Hex } from "viem";
import { encodeMsgpack, prepareAction, type MsgpackValue } from "./msgpack.js";
import { signDigestECDSA } from "../../crypto.js";
import { bytesToHex, hexToBytes } from "../../../base/encoding.js";
import { keccak256 } from "../../../base/crypto.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** The `{ r, s, v }` shape Hyperliquid's `/exchange` endpoint expects alongside the action. */
export interface HlSignature {
  r: Hex;
  s: Hex;
  v: number;
}

export interface L1ActionHashArgs {
  action: MsgpackValue;
  nonce: number;
  /** Trading on behalf of a subaccount/vault. Unused here — followers are their own master account. */
  vaultAddress?: Hex;
  expiresAfter?: number;
}

function uint64BE(n: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
  return bytes;
}

/**
 * The action hash Hyperliquid binds a signature to.
 *
 * NB the `expiresAfter` marker byte is `0` when the field is PRESENT and the field is omitted
 * entirely when absent — that looks like a bug but it is what the exchange expects, so it is
 * reproduced deliberately.
 */
export function createL1ActionHash(args: L1ActionHashArgs): Hex {
  const { action, nonce, vaultAddress, expiresAfter } = args;

  const parts: Uint8Array[] = [encodeMsgpack(prepareAction(action)), uint64BE(nonce)];

  if (vaultAddress) {
    parts.push(new Uint8Array([1]), hexToBytes(vaultAddress));
  } else {
    parts.push(new Uint8Array([0]));
  }

  if (expiresAfter !== undefined) {
    parts.push(new Uint8Array([0]), uint64BE(expiresAfter));
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }

  return bytesToHex(keccak256(buf));
}

export interface SignL1ActionArgs extends L1ActionHashArgs {
  /** The agent key, held in enclave memory only (injected via KEY/UPDATE). Never logged, never returned. */
  privateKey: Uint8Array;
  isTestnet: boolean;
}

/** Sign an L1 action with the enclave-held agent key. */
export function signL1Action(args: SignL1ActionArgs): HlSignature {
  const { privateKey, isTestnet, ...hashArgs } = args;

  const digest = hashTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337, // Hyperliquid pins this regardless of the real chain
      verifyingContract: ZERO_ADDRESS,
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: isTestnet ? "b" : "a",
      connectionId: createL1ActionHash(hashArgs),
    },
  });

  const sig = signDigestECDSA(privateKey, hexToBytes(digest));
  return {
    r: bytesToHex(sig.slice(0, 32)),
    s: bytesToHex(sig.slice(32, 64)),
    v: sig[64]!,
  };
}
