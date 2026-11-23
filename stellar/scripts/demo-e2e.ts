/**
 * End-to-end Tranche 1 flow on Stellar Testnet, with nothing mocked:
 *
 *   follower  funds a fresh account, gets Circle Testnet USDC, creates a vault through the factory
 *             with a trading policy, deposits USDC
 *   leader    seals an entry signal to the enclave key read from the Enclave Registry, commits its
 *             hash to the Signal Registry and posts the ciphertext to the relay
 *   agent     waits for the commitment, the enclave decrypts and sizes, the relayer submits; the
 *             vault's __check_auth checks everything on-chain and the Aquarius pool settles
 *   leader    then closes: a close signal sells the position back to USDC
 *
 * Needs the enclave (`stellar/enclave`) and the agent (`stellar/agent`) running. Testnet only.
 *
 *   AGENT_URL           relay endpoint (default http://127.0.0.1:8788)
 *   USDC_SOURCE_POOL    Aquarius pool the follower buys its test USDC in (default: the busiest
 *                       Testnet XLM/USDC pool, which is not the demo venue)
 */

import {
  Chain,
  keypairSigner,
  withRetry,
  policyToScVal,
  prepareSignal,
  USD,
  type Policy,
} from "@sigmax/stellar-client";
import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { fmt, fundWithFriendbot, loadDeployment, newFundedAccount, sleep } from "./lib.js";

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:8788";
const USDC_SOURCE_POOL = process.env.USDC_SOURCE_POOL ?? "CAYBMZYJCOMMOHOGOGBK7ANIKF3JPZAL4D7SWAPVPHC4WBMOUT5DJN5B";
const EXPLORER = "https://stellar.expert/explorer/testnet/tx/";

interface Job {
  status: string;
  error?: string;
  results: { vault: string; status: string; reason?: string; tx?: string; amountIn?: string; minOut?: string }[];
}

async function agent<T>(path: string, body?: unknown): Promise<T> {
  const res = await withRetry(() => fetch(`${AGENT}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`agent ${path}: ${json.error ?? res.status}`);
  return json;
}

async function waitForJob(commitment: string): Promise<Job> {
  for (let i = 0; i < 120; i++) {
    const job = await agent<Job>(`/signals/${commitment}`);
    if (job.status === "done" || job.status === "failed") return job;
    await sleep(3_000);
  }
  throw new Error("signal still running after 6 minutes");
}

async function main() {
  const deployment = loadDeployment();
  const chain = new Chain(deployment);
  const usdc = deployment.assets.USDC!;
  const xlm = deployment.assets.XLM!;
  const venue = deployment.venues[0]!;

  const health = await agent<{ relayer: string; enclave: { signing_key?: string; error?: string } }>("/health");
  if (!health.enclave.signing_key) throw new Error(`enclave not reachable through the agent: ${health.enclave.error}`);
  const onChainKey = await chain.enclaveSigningKey();
  if (!onChainKey || Buffer.from(onChainKey).toString("hex") !== health.enclave.signing_key) {
    throw new Error("the running enclave's key is not the one registered on-chain; run scripts/register-enclave.sh");
  }
  console.log(`agent ok, relayer ${health.relayer}; enclave key matches the Enclave Registry`);

  // Leader: an account that commits signals.
  const leader = Keypair.random();
  await fundWithFriendbot(leader.publicKey());
  console.log(`leader: ${leader.publicKey()}`);

  // Follower: account, test USDC, vault, deposit.
  const follower = await newFundedAccount(chain, "follower");
  const signer = keypairSigner(follower);
  await chain.invoke(follower.publicKey(), signer, USDC_SOURCE_POOL, "swap", [
    new Address(follower.publicKey()).toScVal(),
    xdr.ScVal.scvU32(1),
    xdr.ScVal.scvU32(0),
    nativeToScVal(1_000n * 10_000_000n, { type: "u128" }),
    nativeToScVal(1n, { type: "u128" }),
  ]);
  const usdcBalance = await chain.tokenBalance(usdc.token, follower.publicKey());
  console.log(`follower bought ${fmt(usdcBalance)} test USDC`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const policy: Policy = {
    leader: leader.publicKey(),
    assets: [
      { token: usdc.token, symbol: "USDC", decimals: usdc.decimals },
      { token: xlm.token, symbol: "XLM", decimals: xlm.decimals },
    ],
    venues: [{ pool: venue.pool, tokens: venue.tokens }],
    // Each trade may use the whole balance (so a close sells the whole position); the USD caps
    // below are what bound the size.
    maxTradeBps: 10_000,
    maxTradeUsd: 50n * USD,
    maxDailyUsd: 500n * USD,
    maxDailyTrades: 10,
    // The demo pool charges 1% and Testnet pools drift from the oracle between alignments, so
    // the oracle band leaves room for fee, price impact and drift. Still a hard on-chain bound.
    maxSlippageBps: 500,
    maxSignalAgeSecs: 3_600n,
    maxOracleAgeSecs: 900n,
    expiresAt: now + 7n * 86_400n,
  };
  const created = await chain.invoke(follower.publicKey(), signer, deployment.contracts.vaultFactory, "create_vault", [
    new Address(follower.publicKey()).toScVal(),
    policyToScVal(policy),
  ]);
  const vault = scValToNative(created.returnValue!) as string;
  console.log(`vault: ${vault}  (${EXPLORER}${created.hash})`);

  const deposit = 300n * 10_000_000n;
  const dep = await chain.invoke(follower.publicKey(), signer, vault, "deposit", [
    new Address(follower.publicKey()).toScVal(),
    new Address(usdc.token).toScVal(),
    nativeToScVal(deposit, { type: "i128" }),
  ]);
  console.log(`deposited ${fmt(deposit)} USDC  (${EXPLORER}${dep.hash})`);

  const encryptionKey = await chain.enclaveEncryptionKey();
  if (!encryptionKey) throw new Error("no enclave encryption key registered");

  const send = async (label: string, input: Parameters<typeof prepareSignal>[0]) => {
    const sealed = prepareSignal(input, encryptionKey);
    await agent("/signals", { commitment: sealed.commitmentHex, ciphertext: sealed.ciphertextHex });
    const committed = await chain.invoke(leader.publicKey(), keypairSigner(leader), deployment.contracts.signalRegistry, "commit", [
      new Address(leader.publicKey()).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(sealed.commitment)),
    ]);
    console.log(`\n${label}: committed ${sealed.commitmentHex.slice(0, 16)}…  (${EXPLORER}${committed.hash})`);
    let job = await waitForJob(sealed.commitmentHex);
    for (let retry = 1; job.status === "failed" && retry <= 2; retry++) {
      // Re-posting a failed commitment makes the agent run it again (Testnet RPC drops happen).
      console.log(`  ${label} failed (${job.error}); asking the agent to retry`);
      await agent("/signals", { commitment: sealed.commitmentHex, ciphertext: sealed.ciphertextHex });
      job = await waitForJob(sealed.commitmentHex);
    }
    if (job.status === "failed") throw new Error(`${label} failed: ${job.error}`);
    for (const r of job.results) {
      console.log(
        r.status === "submitted"
          ? `  vault ${r.vault.slice(0, 8)}… swapped ${fmt(BigInt(r.amountIn!))} in, min out ${fmt(BigInt(r.minOut!))}  (${EXPLORER}${r.tx})`
          : `  vault ${r.vault.slice(0, 8)}… ${r.status}: ${r.reason}`,
      );
    }
    return sealed.commitmentHex;
  };
  const balances = async () => {
    const [u, x] = await Promise.all([chain.tokenBalance(usdc.token, vault), chain.tokenBalance(xlm.token, vault)]);
    console.log(`  vault holds ${fmt(u)} USDC, ${fmt(x)} XLM`);
  };

  // Entry: buy XLM with half the USDC (capped by the vault at $50). The take-profit and
  // stop-loss travel sealed; nothing on-chain reveals them.
  const entry = await send("entry", {
    kind: "entry",
    leader: leader.publicKey(),
    base: "XLM",
    quote: "USDC",
    sizeBps: 5_000,
    takeProfit: "0.16",
    stopLoss: "0.12",
  });
  await balances();

  // Close: sell the whole XLM position back to USDC.
  await send("close", {
    kind: "close",
    leader: leader.publicKey(),
    base: "XLM",
    quote: "USDC",
    sizeBps: 10_000,
    entryRef: entry,
  });
  await balances();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
