/** Handler functions for the KEY and SIGNAL extension operations. */

import { Framework } from '../base/types.js';
import {
  VERSION,
  OP_TYPE_KEY,
  OP_COMMAND_UPDATE,
  OP_COMMAND_SIGN,
  OP_TYPE_SIGNAL,
  OP_COMMAND_EXECUTE,
} from './config.js';
import { abiEncodeTwo } from './abi.js';
import { signECDSA, parsePrivateKey, addressFromPrivateKey } from './crypto.js';
import { hexToBytes, bytesToHex } from '../base/encoding.js';
import { decryptViaNode, setSignPort } from './node.js';
import { getStoredKey, setStoredKey } from './keystore.js';
import { masterPublicKey } from './sigmax/hl/agent-key.js';
import {
  handleSignalExecute,
  reportSigmaxState,
  resetSigmaxState,
} from './sigmax/handler.js';

export { setSignPort };

/** Register the KEY and SIGNAL handlers with the framework. */
export function register(framework: Framework): void {
  framework.handle(OP_TYPE_KEY, OP_COMMAND_UPDATE, handleKeyUpdate);
  framework.handle(OP_TYPE_KEY, OP_COMMAND_SIGN, handleKeySign);
  framework.handle(OP_TYPE_SIGNAL, OP_COMMAND_EXECUTE, handleSignalExecute);
}

/**
 * A JSON-serializable snapshot of the current state. Public values only — the key itself is never
 * exposed here or anywhere else.
 *
 * `hlAgentMasterPubkey` is the load-bearing field. A Hyperliquid follower must `approveAgent` to a
 * specific address, and that address is derived per-follower (see `sigmax/hl/agent-key.ts`). By
 * publishing the master PUBLIC key, the follower's wallet computes the address it is approving
 * itself — it verifies the derivation instead of trusting an address a server hands it.
 */
export function reportState(): unknown {
  const key = getStoredKey();
  return {
    hasKey: key !== null,
    agentAddress: key !== null ? addressFromPrivateKey(key) : null,
    hlAgentMasterPubkey: key !== null ? bytesToHex(masterPublicKey(key)) : null,
    version: VERSION,
    sigmax: reportSigmaxState(),
  };
}

/** Reset state (for testing). */
export function resetState(): void {
  setStoredKey(null);
  resetSigmaxState();
}

async function handleKeyUpdate(
  msg: string,
): Promise<[string | null, number, string | null]> {
  if (!msg) {
    return [null, 0, 'originalMessage is empty'];
  }

  let ciphertext: Uint8Array;
  try {
    ciphertext = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `invalid hex in originalMessage: ${e}`];
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = await decryptViaNode(ciphertext);
  } catch (e) {
    return [null, 0, `decryption failed: ${e}`];
  }

  let validatedKey: Uint8Array;
  try {
    validatedKey = parsePrivateKey(keyBytes);
  } catch (e) {
    return [null, 0, `invalid private key: ${e}`];
  }

  setStoredKey(validatedKey);
  console.log('private key updated');
  return [null, 1, null];
}

async function handleKeySign(
  msg: string,
): Promise<[string | null, number, string | null]> {
  const privateKey = getStoredKey();
  if (privateKey === null) {
    return [null, 0, 'no private key stored'];
  }

  if (!msg) {
    return [null, 0, 'originalMessage is empty'];
  }

  let msgBytes: Uint8Array;
  try {
    msgBytes = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `invalid hex in originalMessage: ${e}`];
  }

  let sig: Uint8Array;
  try {
    sig = signECDSA(privateKey, msgBytes);
  } catch (e) {
    return [null, 0, `signing failed: ${e}`];
  }

  let encoded: Uint8Array;
  try {
    encoded = abiEncodeTwo(msgBytes, sig);
  } catch (e) {
    return [null, 0, `ABI encoding failed: ${e}`];
  }

  const dataHex = bytesToHex(encoded);
  return [dataHex, 1, null];
}
