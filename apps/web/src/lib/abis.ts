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

/**
 * CopyVaultFlare — the follower's own non-custodial vault on Coston2.
 *
 * `executeSwapWithTeeSig` is deliberately absent: only the keeper ever calls it, and the browser has
 * no business holding an authorization. Everything here is owner-scoped (fund, withdraw, inspect).
 */
export const COPY_VAULT_FLARE_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount)",
  // Owner-only. The follower's escape hatch when the enclave re-attests under a new identity: without
  // it their vault would keep trusting a retired key and reject every authorization.
  "function setTeeAddress(address teeAddress)",
  "function owner() view returns (address)",
  "function perTradeCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function tokenWhitelisted(address) view returns (bool)",
  "function routerWhitelisted(address) view returns (bool)",
  "function teeAddress() view returns (address)",
  "event Swapped(address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 received)",
  "event Withdrawn(address indexed token, address indexed to, uint256 amount)",
]);

/**
 * CopyVaultFlareFactory — one vault per follower, at a deterministic CREATE2 address.
 *
 * `createVaultAndDeposit` is the onboarding path: create and fund in ONE signature. The two-step
 * `createVault` + `deposit` is kept for a follower who already has a vault and wants to top it up.
 */
export const COPY_VAULT_FLARE_FACTORY_ABI = parseAbi([
  "function vaultOf(address follower) view returns (address)",
  "function createVault(address[] tokens, address[] routers, uint256 cap) returns (address vault)",
  "function createVaultAndDeposit(address[] tokens, address[] routers, uint256 cap, address token, uint256 amount) returns (address vault)",
  "function teeAddress() view returns (address)",
  "event VaultCreated(address indexed owner, address vault)",
  "event VaultFunded(address indexed owner, address vault, address token, uint256 amount)",
]);

/** testUSD's public faucet — the only reason a Coston2 demo can be self-serve. */
export const TEST_USD_ABI = parseAbi([
  "function mint()",
  "function balanceOf(address) view returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
