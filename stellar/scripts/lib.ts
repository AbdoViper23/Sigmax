/**
 * Helpers for the Testnet scripts: friendbot funding, trustlines, classic submission, and the
 * deployment file. Testnet only: these scripts create throwaway accounts and hold their secrets
 * in memory.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Chain, parseDeployment, TESTNET_FRIENDBOT, withRetry, type Deployment } from "@sigmax/stellar-client";
import { Asset, BASE_FEE, Keypair, Operation, rpc, TransactionBuilder } from "@stellar/stellar-sdk";

export function loadDeployment(): Deployment {
  const path = process.env.SIGMAX_DEPLOYMENT ?? fileURLToPath(new URL("../deployments/testnet.json", import.meta.url));
  return parseDeployment(JSON.parse(readFileSync(path, "utf-8")));
}

export async function fundWithFriendbot(publicKey: string): Promise<void> {
  await withRetry(async () => {
    const res = await fetch(`${TESTNET_FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`);
    const body = await res.text();
    // A retry after a dropped response finds the account already funded.
    if (!res.ok && !/createAccountAlreadyExist|already funded/i.test(body)) {
      throw new Error(`friendbot failed for ${publicKey}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  }, 4, 2_000);
}

/** Submit a classic transaction built from `ops` and signed by `signer`. */
export async function submitClassic(chain: Chain, signer: Keypair, ops: ReturnType<typeof Operation.payment>[]): Promise<string> {
  const account = await withRetry(() => chain.server.getAccount(signer.publicKey()));
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.passphrase });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(60).build();
  tx.sign(signer);
  const sent = await withRetry(() => chain.server.sendTransaction(tx), 4, 2_000);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") throw new Error(`classic tx ${sent.status}`);
  const done = await withRetry(() => chain.server.pollTransaction(sent.hash, { attempts: 30 }), 4);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`classic tx ${sent.hash} ${done.status}`);
  return sent.hash;
}

/** A fresh friendbot-funded account with a trustline to Circle's Testnet USDC. */
export async function newFundedAccount(chain: Chain, label: string): Promise<Keypair> {
  const kp = Keypair.random();
  await fundWithFriendbot(kp.publicKey());
  const usdc = chain.deployment.assets.USDC!;
  await submitClassic(chain, kp, [Operation.changeTrust({ asset: new Asset(usdc.code, usdc.issuer!) })]);
  console.log(`${label}: ${kp.publicKey()} (funded, USDC trustline)`);
  return kp;
}

export const fmt = (amount: bigint, decimals = 7) => {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const s = a.toString().padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -decimals)}.${s.slice(-decimals).replace(/0+$/, "") || "0"}`;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
