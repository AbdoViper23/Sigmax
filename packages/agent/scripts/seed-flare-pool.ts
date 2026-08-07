/**
 * Phase 0b — seed the FXRP/testUSD pool on BlazeSwap (Coston2).
 *
 * Coston2 has no FXRP/stablecoin liquidity: the canonical FXRP appears in exactly one BlazeSwap pair
 * (FXRP/WC2FLR, ~4.75 FXRP, mispriced ~7x). See docs/flare/reference/phase-0b-dex-recon.md. This
 * script mints testUSD from its permissionless faucet and adds liquidity at the **live FTSO XRP/USD
 * price**, so the pool the vaults trade against agrees with the oracle that bounds their `minOut`.
 *
 * Read-only by default. Pass --execute to send transactions.
 *
 *   pnpm --filter @sigmax/agent tsx scripts/seed-flare-pool.ts            # dry run
 *   pnpm --filter @sigmax/agent tsx scripts/seed-flare-pool.ts --execute
 *
 * Requires DEPLOYMENT_PRIVATE_KEY (the throwaway Coston2 dev wallet — never a funded key).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  defineChain,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** Canonical FXRP — the one whose AssetManager is registered in AssetManagerController. */
const FXRP: Address = "0x0b6A3645c240605887a5532109323A3E12273dc7";
/**
 * NOT to be confused with 0x8b4abA9C…, a legacy FTestXRP with the same symbol and healthy-looking
 * pools whose AssetManager is unregistered. Wiring to it would look fine and execute nothing real.
 */
const TEST_USD: Address = "0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73";
const ROUTER: Address = "0x8D29b61C41CF318d15d031BE2928F79630e068e6";
const FACTORY: Address = "0xF0f5e4CdE15b22A423E995415f373FEDC1f8F431";
const FTSO_V2: Address = "0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d";
const XRP_USD_FEED = "0x015852502f55534400000000000000000000000000" as const;

/** FXRP to commit. The scarcer leg caps pool depth; keep a reserve for the demo swaps themselves. */
const FXRP_TO_ADD = 8_000_000n; // 8 FXRP (6 decimals)
const SLIPPAGE_BPS = 200n; // tolerance on the addLiquidity minimums

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint()",
]);

/**
 * BlazeSwap's `addLiquidity` is NOT the stock Uniswap-V2 one — it takes two extra `feeBips` params
 * (the LP's share of the reward fee). The V2 selector reverts. Its `swapExactTokensForTokens`, which
 * is what the vaults actually call, does match V2 exactly.
 */
const ROUTER_ABI = parseAbi([
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, uint256 feeBipsA, uint256 feeBipsB, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
]);

const FACTORY_ABI = parseAbi(["function getPair(address, address) view returns (address)"]);
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

  console.log(`wallet   ${account.address}`);
  console.log(`mode     ${execute ? "EXECUTE" : "dry run (pass --execute to send)"}\n`);

  // --- price the pool off FTSO, so it agrees with the oracle the vaults bound minOut against ---
  const [price, priceDecimals] = await publicClient.readContract({
    address: FTSO_V2,
    abi: FTSO_ABI,
    functionName: "getFeedById",
    args: [XRP_USD_FEED],
  });
  const pd = BigInt(priceDecimals);
  console.log(`FTSO XRP/USD  ${formatUnits(price, Number(pd))}`);

  // testUSD and FXRP are both 6-decimal, so the scaling is just the price exponent.
  const usdToAdd = (FXRP_TO_ADD * price) / 10n ** pd;
  console.log(`seeding       ${formatUnits(FXRP_TO_ADD, 6)} FXRP + ${formatUnits(usdToAdd, 6)} testUSD\n`);

  const [fxrpBal, usdBal, pair] = await Promise.all([
    publicClient.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: TEST_USD, abi: ERC20, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getPair", args: [FXRP, TEST_USD] }),
  ]);
  console.log(`balances      ${formatUnits(fxrpBal, 6)} FXRP · ${formatUnits(usdBal, 6)} testUSD`);
  console.log(`pair          ${pair === "0x0000000000000000000000000000000000000000" ? "none yet (addLiquidity creates it)" : pair}\n`);

  if (fxrpBal < FXRP_TO_ADD) {
    throw new Error(
      `need ${formatUnits(FXRP_TO_ADD, 6)} FXRP but hold ${formatUnits(fxrpBal, 6)} — top up at https://faucet.flare.network/coston2`,
    );
  }

  // --- mint testUSD from its open faucet until we have enough (100 testUSD per call) ---
  let have = usdBal;
  const mints: number[] = [];
  while (have < usdToAdd) {
    mints.push(mints.length);
    have += 100_000_000n;
  }
  if (mints.length) console.log(`will mint     ${mints.length} × 100 testUSD`);

  if (!execute) {
    console.log("\ndry run complete — no transactions sent");
    return;
  }

  for (const i of mints) {
    const hash = await walletClient.writeContract({ address: TEST_USD, abi: ERC20, functionName: "mint" });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  mint ${i + 1}/${mints.length}  ${hash}`);
  }

  await approveIfNeeded(publicClient, walletClient, account.address, FXRP, FXRP_TO_ADD, "FXRP");
  await approveIfNeeded(publicClient, walletClient, account.address, TEST_USD, usdToAdd, "testUSD");

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const min = (v: bigint) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const hash = await walletClient.writeContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: "addLiquidity",
    args: [FXRP, TEST_USD, FXRP_TO_ADD, usdToAdd, min(FXRP_TO_ADD), min(usdToAdd), 0n, 0n, account.address, deadline],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`\naddLiquidity  ${hash}  (${receipt.status})`);

  const newPair = await publicClient.readContract({
    address: FACTORY,
    abi: FACTORY_ABI,
    functionName: "getPair",
    args: [FXRP, TEST_USD],
  });
  console.log(`pair          ${newPair}`);
  console.log(`\nSet VITE_FLARE_QUOTE_TOKEN / SIGMAX_QUOTE_TOKEN to ${TEST_USD}`);
}

async function approveIfNeeded(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  owner: Address,
  token: Address,
  amount: bigint,
  label: string,
) {
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [owner, ROUTER],
  });
  if (current >= amount) return;
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [ROUTER, amount],
    account: walletClient.account!,
    chain: coston2,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  approve ${label}  ${hash}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
