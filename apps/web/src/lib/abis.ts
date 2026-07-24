import { parseAbi } from "viem";

/**
 * Minimal human-readable ABIs the web app calls. Mirrors packages/agent/src/abis.ts plus the
 * follower-flow write/event fragments. Defined here (not imported from @sigmax/agent — that pulls
 * node:fs and is server-only).
 */
export const COPY_VAULT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
  "function setExecutor(address executor, bool allowed)",
  "function setPaused(bool paused)",
  "function paused() view returns (bool)",
  "function isExecutor(address) view returns (bool)",
  "function perTradeCap() view returns (uint256)",
  "function owner() view returns (address)",
  "event Swapped(address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 received)",
]);

export const COPY_VAULT_FACTORY_ABI = parseAbi([
  "function vaultOf(address follower) view returns (address)",
  "function createVault(address executor, address[] tokens, address[] routers, uint256 cap) returns (address vault)",
  "event VaultCreated(address indexed owner, address vault)",
]);

export const SUBSCRIPTION_REGISTRY_ABI = parseAbi([
  "function isActive(address subscriber, address strategyId) view returns (bool)",
  "function expiryOf(address subscriber, address strategyId) view returns (uint64)",
  "function subscribe(address strategyId)",
  "function cancel(address strategyId)",
  "function plans(address strategyId) view returns (address leader, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, bool active)",
  // leader-side writes (createPlan makes the caller the plan leader; username/displayName are
  // profile labels emitted in PlanCreated only — not stored in the Plan struct)
  "function createPlan(address strategyId, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, string username, string displayName)",
  "function setMonthlyPrice(address strategyId, uint256 monthlyPrice)",
  "function setPlanActive(address strategyId, bool active)",
  "event PlanCreated(address indexed strategyId, address indexed leader, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, string username, string displayName)",
  "event Subscribed(address indexed strategyId, address indexed subscriber, uint64 newExpiry, uint256 paid)",
  "event SubscriptionCancelled(address indexed strategyId, address indexed subscriber)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
