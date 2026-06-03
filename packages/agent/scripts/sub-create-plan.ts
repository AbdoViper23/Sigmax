/**
 * Leader: create a subscription Plan on Story `SubscriptionRegistry` for a strategy (one-time).
 * A plan must exist before any follower can subscribe. No frontend needed.
 *
 * Run:
 *   LEADER_PK=0x… STRATEGY_IP_ID=0x… REGISTRY_ADDRESS=0x… \
 *   [PAY_TOKEN=0x1514…(WIP)] [MONTHLY_PRICE=1] [PLATFORM_FEE_BPS=1500] \
 *   [USERNAME=demo] [DISPLAY_NAME="Demo Leader"] [STORY_RPC_URL=…] \
 *   pnpm --filter @sigmax/agent exec tsx scripts/sub-create-plan.ts
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STORY_AENEID, STORY_AENEID_ADDRESSES } from "@sigmax/shared";

const REGISTRY_ABI = parseAbi([
  "function createPlan(address strategyId, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, string username, string displayName)",
  "function plans(address) view returns (address leader, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, bool active)",
]);
const WIP_DECIMALS = 18;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(env("LEADER_PK") as Hex);
  const strategyId = env("STRATEGY_IP_ID") as Hex;
  const registry = env("REGISTRY_ADDRESS") as Hex;
  const payToken = env("PAY_TOKEN", STORY_AENEID_ADDRESSES.wip) as Hex;
  const monthlyPrice = parseUnits(env("MONTHLY_PRICE", "1") as `${number}`, WIP_DECIMALS);
  const feeBps = Number(env("PLATFORM_FEE_BPS", "1500"));
  const rpcUrl = env("STORY_RPC_URL", STORY_AENEID.rpcUrl);

  const chain = defineChain({
    id: STORY_AENEID.id,
    name: STORY_AENEID.name,
    nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const existing = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "plans", args: [strategyId] });
  if (existing[0] !== "0x0000000000000000000000000000000000000000") {
    console.log(JSON.stringify({ status: "exists", leader: existing[0], monthlyPrice: existing[2].toString() }, null, 2));
    return;
  }

  // Story rejects EIP-1559 — send a legacy tx by supplying gasPrice.
  const gasPrice = await publicClient.getGasPrice();
  const hash = await wallet.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "createPlan",
    args: [strategyId, payToken, monthlyPrice, feeBps, env("USERNAME", "demo"), env("DISPLAY_NAME", "Demo Leader")],
    gasPrice,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ status: "created", strategyId, payToken, monthlyPrice: monthlyPrice.toString(), feeBps, tx: hash }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
