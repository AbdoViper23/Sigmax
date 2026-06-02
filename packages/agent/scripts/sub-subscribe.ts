/**
 * Follower: subscribe to a leader's strategy on Story `SubscriptionRegistry` (no frontend).
 * Reads the plan's payToken + monthlyPrice, approves the registry to pull it, then subscribes.
 * After this, the running agent's `isActive(follower, strategyId)` check passes for this wallet.
 *
 * Run:
 *   FOLLOWER_PK=0x… STRATEGY_IP_ID=0x… REGISTRY_ADDRESS=0x… [STORY_RPC_URL=…] \
 *   pnpm --filter @sigmax/agent exec tsx scripts/sub-subscribe.ts
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { STORY_AENEID } from "@sigmax/shared";

const REGISTRY_ABI = parseAbi([
  "function subscribe(address strategyId)",
  "function plans(address) view returns (address leader, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, bool active)",
  "function isActive(address subscriber, address strategyId) view returns (bool)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(env("FOLLOWER_PK") as Hex);
  const strategyId = env("STRATEGY_IP_ID") as Hex;
  const registry = env("REGISTRY_ADDRESS") as Hex;
  const rpcUrl = env("STORY_RPC_URL", STORY_AENEID.rpcUrl);

  const chain = defineChain({
    id: STORY_AENEID.id,
    name: STORY_AENEID.name,
    nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const plan = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "plans", args: [strategyId] });
  const [leader, payToken, monthlyPrice] = plan;
  if (leader === "0x0000000000000000000000000000000000000000") throw new Error("no plan for this strategyId — run sub-create-plan first");

  const gasPrice = await publicClient.getGasPrice(); // Story rejects EIP-1559 → legacy txs

  // 1) approve the registry to pull monthlyPrice of payToken (skip if already sufficient).
  const allowance = await publicClient.readContract({ address: payToken, abi: ERC20_ABI, functionName: "allowance", args: [account.address, registry] });
  if (allowance < monthlyPrice) {
    const approveHash = await wallet.writeContract({ address: payToken, abi: ERC20_ABI, functionName: "approve", args: [registry, monthlyPrice], gasPrice });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  // 2) subscribe.
  const subHash = await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: "subscribe", args: [strategyId], gasPrice });
  await publicClient.waitForTransactionReceipt({ hash: subHash });

  const active = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "isActive", args: [account.address, strategyId] });
  console.log(JSON.stringify({ status: "subscribed", follower: account.address, strategyId, monthlyPrice: monthlyPrice.toString(), isActive: active, tx: subHash }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
