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
import { signECDSA, parsePrivateKey } from './crypto.js';
import { hexToBytes, bytesToHex } from '../base/encoding.js';
import { decryptViaNode, setSignPort } from './node.js';
import {
  handleSignalExecute,
  reportSigmaxState,
  resetSigmaxState,
} from './sigmax/handler.js';

/** Mutable state — the framework serializes all handler calls. */
let privateKey: Uint8Array | null = null;

export { setSignPort };

/** Register the KEY and SIGNAL handlers with the framework. */
export function register(framework: Framework): void {
  framework.handle(OP_TYPE_KEY, OP_COMMAND_UPDATE, handleKeyUpdate);
  framework.handle(OP_TYPE_KEY, OP_COMMAND_SIGN, handleKeySign);
  framework.handle(OP_TYPE_SIGNAL, OP_COMMAND_EXECUTE, handleSignalExecute);
}

/** Return a JSON-serializable snapshot of the current state. */
export function reportState(): unknown {
  return {
    hasKey: privateKey !== null,
    version: VERSION,
    sigmax: reportSigmaxState(),
  };
}

/** Reset state (for testing). */
export function resetState(): void {
  privateKey = null;
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

  privateKey = validatedKey;
  console.log('private key updated');
  return [null, 1, null];
}

async function handleKeySign(
  msg: string,
): Promise<[string | null, number, string | null]> {
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
