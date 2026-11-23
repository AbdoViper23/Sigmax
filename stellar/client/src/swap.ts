/**
 * The vault swap authorization, built the way the enclave builds it (`stellar/enclave/src/auth.rs`).
 *
 * Tree (verified against a live Aquarius Testnet pool):
 *   pool.swap(vault, in_idx, out_idx, amount_in: u128, min_out: u128)
 *     └─ token_in.transfer(vault, pool, amount_in: i128)
 *
 * The relayer recomputes the payload here and compares it with the one the enclave signed before
 * submitting anything, so an encoding drift between the two shows up as a clear error.
 */

import { Address, hash, nativeToScVal, Operation, xdr } from "@stellar/stellar-sdk";

import { swapProofToScVal, type SwapProof } from "./contracts.js";

export interface SwapPlan {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  inIdx: number;
  outIdx: number;
  amountIn: bigint;
  minOut: bigint;
}

export function swapArgs(vault: string, plan: SwapPlan): xdr.ScVal[] {
  return [
    new Address(vault).toScVal(),
    xdr.ScVal.scvU32(plan.inIdx),
    xdr.ScVal.scvU32(plan.outIdx),
    nativeToScVal(plan.amountIn, { type: "u128" }),
    nativeToScVal(plan.minOut, { type: "u128" }),
  ];
}

export function swapInvocation(vault: string, plan: SwapPlan): xdr.SorobanAuthorizedInvocation {
  const transfer = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(plan.tokenIn).toScAddress(),
        functionName: "transfer",
        args: [
          new Address(vault).toScVal(),
          new Address(plan.pool).toScVal(),
          nativeToScVal(plan.amountIn, { type: "i128" }),
        ],
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(plan.pool).toScAddress(),
        functionName: "swap",
        args: swapArgs(vault, plan),
      }),
    ),
    subInvocations: [transfer],
  });
}

/** `sha256(HashIdPreimage::SorobanAuthorization)`: the payload the enclave signs. */
export function authPayload(
  networkPassphrase: string,
  nonce: bigint,
  signatureExpirationLedger: number,
  invocation: xdr.SorobanAuthorizedInvocation,
): Buffer {
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: xdr.Int64.fromString(nonce.toString()),
      signatureExpirationLedger,
      invocation,
    }),
  );
  return Buffer.from(hash(preimage.toXDR()));
}

/** `SIGMAX/swap/v1 ‖ payload ‖ signal ‖ expires_at_ledger (u32 BE)`. */
export function swapMessage(payload: Uint8Array, signal: Uint8Array, expiresAtLedger: number): Uint8Array {
  const msg = new Uint8Array(14 + 32 + 32 + 4);
  msg.set(new TextEncoder().encode("SIGMAX/swap/v1"), 0);
  msg.set(payload, 14);
  msg.set(signal, 46);
  new DataView(msg.buffer).setUint32(78, expiresAtLedger, false);
  return msg;
}

/** A random signed 64-bit Soroban authorization nonce. */
export function randomNonce(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return BigInt.asIntN(64, new DataView(b.buffer).getBigUint64(0));
}

export function swapAuthEntry(
  vault: string,
  nonce: bigint,
  signatureExpirationLedger: number,
  invocation: xdr.SorobanAuthorizedInvocation,
  proof: SwapProof,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(vault).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger,
        signature: swapProofToScVal(proof),
      }),
    ),
    rootInvocation: invocation,
  });
}

/** The `pool.swap` operation carrying the vault's enclave-signed authorization. */
export function swapOperation(vault: string, plan: SwapPlan, entry: xdr.SorobanAuthorizationEntry): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: plan.pool,
    function: "swap",
    args: swapArgs(vault, plan),
    auth: [entry],
  });
}
