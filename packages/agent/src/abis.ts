import { parseAbi } from "viem";

/**
 * Minimal human-readable ABIs the agent needs. Defined inline (not imported from `packages/contracts`)
 * to respect the no-cross-service-import rule (doc 03 §6). Only the functions the agent actually calls.
 */
export const COPY_VAULT_ABI = parseAbi([
  "function executeSwap(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, address router, bytes swapData) returns (uint256 received)",
  "function perTradeCap() view returns (uint256)",
  "function tokenWhitelisted(address) view returns (bool)",
  "function routerWhitelisted(address) view returns (bool)",
  "function owner() view returns (address)",
]);

export const COPY_VAULT_FACTORY_ABI = parseAbi([
  "function vaultOf(address follower) view returns (address)",
]);

export const SUBSCRIPTION_REGISTRY_ABI = parseAbi([
  "function isActive(address subscriber, address strategyId) view returns (bool)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** Chainlink AggregatorV3 — used by ChainlinkPriceSource. */
export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
