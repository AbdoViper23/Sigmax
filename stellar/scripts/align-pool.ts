/**
 * Testnet scaffolding: move the demo Aquarius pool to the Reflector price.
 *
 * Testnet pools are not arbitraged against real markets, so their prices drift far from the
 * Reflector feed (on 2026-11-19 the XLM/USDC pools sat at 0.56-0.69 USDC per XLM while Reflector
 * quoted 0.137). Every vault bounds `min_amount_out` by the oracle, so against such a pool vaults
 * correctly refuse one side of every trade. This script trades the pool back to the oracle price
 * from throwaway friendbot accounts. It is never needed on Mainnet, where arbitrage does this.
 *
 *   pnpm align-pool            dry run: print the trade that would align the pool
 *   pnpm align-pool --execute  do it
 */

import { Chain, symbolOf } from "@sigmax/stellar-client";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { keypairSigner } from "@sigmax/stellar-client";

import { fmt, loadDeployment, newFundedAccount } from "./lib.js";

const BPS = 10_000n;

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const deployment = loadDeployment();
  const chain = new Chain(deployment);
  const venue = deployment.venues[0]!;
  const pool = await chain.poolState(venue.pool);
  const symbols = pool.tokens.map((t) => symbolOf(deployment, t)!);
  const oracle = await chain.oracleState(symbols);
  const [s0, s1] = symbols as [string, string];
  const p0 = oracle.prices[s0]!.price;
  const p1 = oracle.prices[s1]!.price;
  const [r0, r1] = pool.reserves as [bigint, bigint];

  // Pool price of token1 in token0 vs oracle: r0/r1 vs p1/p0. All tokens have 7 decimals here.
  const fmtPrice = (num: bigint, den: bigint) => (Number(num) / Number(den)).toFixed(6);
  console.log(`pool ${venue.pool}: ${fmt(r0)} ${s0} / ${fmt(r1)} ${s1}`);
  console.log(`pool price ${fmtPrice(r0, r1)} ${s0}/${s1}, oracle ${fmtPrice(p1, p0)} ${s0}/${s1}`);

  // Target reserves keep k: r0' = sqrt(k * p1/p0), r1' = sqrt(k * p0/p1).
  const k = r0 * r1;
  const target0 = isqrt((k * p1) / p0);
  const target1 = isqrt((k * p0) / p1);
  const fee = BigInt(pool.feeBps);
  let inIdx: number;
  let amountNet: bigint;
  if (target1 > r1) {
    inIdx = 1;
    amountNet = target1 - r1;
  } else {
    inIdx = 0;
    amountNet = target0 - r0;
  }
  const amountIn = (amountNet * BPS) / (BPS - fee);
  const deviationBps = Number(((r0 * p0 - r1 * p1 < 0n ? r1 * p1 - r0 * p0 : r0 * p0 - r1 * p1) * BPS) / (r1 * p1));
  console.log(`needs ${fmt(amountIn)} ${symbols[inIdx]} in (price off by ~${deviationBps / 100}%)`);
  if (deviationBps < 50) {
    console.log("within 0.5% of the oracle, nothing to do");
    return;
  }
  if (!execute) {
    console.log("dry run; pass --execute to trade");
    return;
  }
  if (symbols[inIdx] !== "XLM") throw new Error("this script only sells friendbot XLM; the pool needs USDC in");

  // Each friendbot account brings 10,000 XLM; keep 20 for reserves and fees.
  let remaining = amountIn;
  for (let i = 1; remaining > 0n; i++) {
    const funder = await newFundedAccount(chain, `funder ${i}`);
    const chunk = remaining < 9_980n * 10_000_000n ? remaining : 9_980n * 10_000_000n;
    const sent = await chain.invoke(funder.publicKey(), keypairSigner(funder), venue.pool, "swap", [
      new Address(funder.publicKey()).toScVal(),
      xdr.ScVal.scvU32(inIdx),
      xdr.ScVal.scvU32(1 - inIdx),
      nativeToScVal(chunk, { type: "u128" }),
      nativeToScVal(1n, { type: "u128" }),
    ]);
    remaining -= chunk;
    console.log(`  swapped ${fmt(chunk)} XLM, tx ${sent.hash}`);
  }
  const after = await chain.poolState(venue.pool);
  console.log(`after: ${fmt(after.reserves[0]!)} ${s0} / ${fmt(after.reserves[1]!)} ${s1}, price ${fmtPrice(after.reserves[0]!, after.reserves[1]!)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
