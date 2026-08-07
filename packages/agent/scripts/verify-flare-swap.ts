/**
 * Phase 0b acceptance — execute one real FXRP→testUSD swap on Coston2 with an FTSO-derived `minOut`.
 *
 * This is the direct-EOA version of what a `CopyVaultFlare` does on a TEE-signed authorization: read
 * the FTSO XRP/USD feed, derive the floor with the same `computeMinOut` the enclave uses, and swap
 * through BlazeSwap. If this passes, the venue + oracle half of the pipeline is proven independently
 * of the FCC round-trip.
 *
 *   pnpm --filter @sigmax/agent tsx scripts/verify-flare-swap.ts            # dry run (quote only)
 *   pnpm --filter @sigmax/agent tsx scripts/verify-flare-swap.ts --execute
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, defineChain, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeMinOut } from "../src/flare/swap-auth.js";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const FXRP: Address = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const TEST_USD: Address = "0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73";
const ROUTER: Address = "0x8D29b61C41CF318d15d031BE2928F79630e068e6";
const FTSO_V2: Address = "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d";
const XRP_USD_FEED = "0x015852502f55534400000000000000000000000000" as const;

/** Small enough that price impact stays inside the slippage bound on an 8-FXRP pool. */
const AMOUNT_IN = 50_000n; // 0.05 FXRP
const SLIPPAGE_BPS = 100; // 1%

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ROUTER_ABI = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);
const FTSO_ABI = parseAbi([
  "function getFeedById(bytes21) view returns (uint256 value, int8 decimals, uint64 timestamp)",
]);

const execute = process.argv.includes("--execute");

async function main() {
  const pk = process.env.DEPLOYMENT_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYMENT_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC) });
  const path = [FXRP, TEST_USD] as const;

  const [price, priceDecimals] = await publicClient.readContract({
    address: FTSO_V2,
    abi: FTSO_ABI,
    functionName: "getFeedById",
    args: [XRP_USD_FEED],
  });

  // The identical function the enclave calls when building a SwapAuth.
  const minOut = computeMinOut({
    amountIn: AMOUNT_IN,
    tokenInDecimals: 6,
    tokenOutDecimals: 6,
    price,
    priceDecimals: Number(priceDecimals),
    slippageBps: SLIPPAGE_BPS,
  });

  const quoted = await publicClient.readContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [AMOUNT_IN, [...path]],
  });

  console.log(`FTSO XRP/USD   ${formatUnits(price, Number(priceDecimals))}`);
  console.log(`amountIn       ${formatUnits(AMOUNT_IN, 6)} FXRP`);
  console.log(`minOut (FTSO)  ${formatUnits(minOut, 6)} testUSD   [${SLIPPAGE_BPS} bps]`);
  console.log(`DEX quote      ${formatUnits(quoted[1]!, 6)} testUSD`);
  console.log(`headroom       ${formatUnits(quoted[1]! - minOut, 6)} testUSD\n`);

  if (quoted[1]! < minOut) {
    throw new Error("DEX quote is below the FTSO floor — the swap would revert (pool mispriced or too thin)");
  }

  if (!execute) {
    console.log("dry run complete — pass --execute to swap");
    return;
  }

  const allowance = await publicClient.readContract({
    address: FXRP,
    abi: ERC20,
    functionName: "allowance",
    args: [account.address, ROUTER],
  });
  if (allowance < AMOUNT_IN) {
    const hash = await walletClient.writeContract({
      address: FXRP,
      abi: ERC20,
      functionName: "approve",
      args: [ROUTER, AMOUNT_IN],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`approve   ${hash}`);
  }

  const before = await publicClient.readContract({
    address: TEST_USD,
    abi: ERC20,
    functionName: "balanceOf",
    args: [account.address],
  });

  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [AMOUNT_IN, minOut, [...path], account.address, BigInt(Math.floor(Date.now() / 1000) + 600)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  const after = await publicClient.readContract({
    address: TEST_USD,
    abi: ERC20,
    functionName: "balanceOf",
    args: [account.address],
  });

  console.log(`swap      ${hash}  (${receipt.status})`);
  console.log(`received  ${formatUnits(after - before, 6)} testUSD  (floor was ${formatUnits(minOut, 6)})`);
  if (after - before < minOut) throw new Error("received less than minOut — should have reverted on-chain");
  console.log("\nPhase 0b acceptance: FTSO-bounded swap executed on Coston2 ✓");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
