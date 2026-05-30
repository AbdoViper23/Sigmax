# 41 — Spot Swap Execution (0x / Uniswap / Sushi)

> How the agent turns "buy token X with N USDC" into a real, slippage-protected swap that runs inside
> a follower's `CopyVault`. Spot only — token-for-token swaps, no leverage.
> Pairs with `contracts/10` (executeSwap), `agent/31` (who calls it), `security/70` (MEV/leakage).

---

## 1. The three routes (and our choice)

| Route | What | Use |
|---|---|---|
| **0x Swap API v2** | hosted aggregator; returns a ready-built tx + slippage-aware minOut | **Primary (MVP)** |
| **CoW Protocol** | intent/batch-auction; MEV-resistant, hidden pre-settlement | **Upgrade for leakage resistance** (`70`) |
| **Direct Uniswap v3 / SushiSwap router** | call `exactInputSingle` yourself | Fallback / no-API path |

**Decision:** start with **0x Swap API v2** (fastest correct path), keep the executor's "submit" step
swappable so we can route a batch through **CoW** later for anti-front-running (`agent/31 §6`).
The user wants Uniswap/Sushi-style DEXs — 0x aggregates exactly those, so we get them via 0x.

## 2. 0x Swap API v2 (primary)

### Get a quote (allowance-holder flow)
```ts
const params = new URLSearchParams({
  chainId: String(chainId),            // 42161 Arbitrum One
  sellToken: USDC,                     // entries sell USDC
  buyToken: targetToken,               // ... to buy the target (exits reverse this)
  sellAmount: amountIn.toString(),
  taker: vaultAddress,                 // the CopyVault is the taker (it holds the funds)
  slippageBps: String(signal.maxSlippageBps), // e.g. 100 = 1%
});
const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${params}`, {
  headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
});
const quote = await res.json();
// quote.transaction.to   -> the AllowanceHolder/router (whitelist this in the vault!)
// quote.transaction.data -> swapData for CopyVault.executeSwap
// quote.minBuyAmount      -> minOut (slippage-aware)
```

### Map to `CopyVault.executeSwap`
```ts
await writeContract(vault, "executeSwap", [
  quote.transaction.to,     // router (must be whitelisted)
  USDC, targetToken,
  amountIn,
  BigInt(quote.minBuyAmount), // minOut, ALSO enforced on-chain as a backstop
  quote.transaction.data,     // swapData
]);
```

### Approvals
0x v2 uses an **AllowanceHolder** pattern. The CopyVault approves the router **exactly** for
`amountIn` inside `executeSwap` and **resets to 0** after (`contracts/10 §4`). Never grant unlimited
approval. **Whitelist the AllowanceHolder/router address** in the vault (`setRouterWhitelist`).

## 3. Direct Uniswap v3 / Sushi (fallback, no API dependency)

If 0x isn't available on the chosen network (or for a fully self-contained demo), call the router
directly:
```solidity
// inside a thin adapter the vault calls, or build calldata off-chain for executeSwap
ISwapRouter.ExactInputSingleParams({
  tokenIn: USDC, tokenOut: target, fee: 3000,   // pick the right fee tier / pool
  recipient: address(this), deadline: block.timestamp + 60,
  amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
});
```
You compute `minOut` from a quoter (`QuoterV2.quoteExactInputSingle`) × (1 − slippage). More control,
but you own routing/pool selection. Keep this as a fallback; 0x's routing is better out of the box.

## 4. Slippage / minOut (defense in depth)

Two layers, both required:
1. **Off-chain:** the aggregator computes `minBuyAmount` from `slippageBps`.
2. **On-chain:** `CopyVault.executeSwap` re-checks `received >= minOut` and reverts otherwise
   (`contracts/10`). This protects the follower even if the off-chain quote is stale or wrong.

For **exits triggered by stop-loss**, consider a slightly looser exit slippage so the stop actually
fills in a fast move (`agent/32 §6`) — document the exit-slippage policy and keep it bounded.

## 5. Fork testing (how the demo gets real liquidity)

Aeneid/L2 testnets lack real spot liquidity, so test against a **forked mainnet L2**:
```bash
anvil --fork-url $ARBITRUM_RPC --chain-id 42161
```
- Deploy `CopyVaultFactory` + a vault to the fork.
- Fund the vault with USDC (impersonate a whale via `anvil_impersonateAccount`, or use a faucet
  helper / `deal`).
- Get a real 0x quote for the forked chain, call `executeSwap`, assert the vault received ≥ minOut.
This proves the end-to-end swap with genuine liquidity and routing, locally and for free.

## 6. Token whitelist discipline (spot-only + safety)
- Only whitelist **real, liquid spot tokens** (USDC + a curated set of majors) in each vault.
- The reference input token is **USDC** (entries USDC→token, exits token→USDC) for the MVP
  (`contracts/10 §9`).
- Never whitelist a token that isn't a plain ERC-20 spot asset (no rebasing/fee-on-transfer tokens
  without special handling; no LP/derivative tokens). This keeps swaps predictable and `minOut`
  honest.

## 7. CoW Protocol (the upgrade — see `security/70`)
For batched, MEV-resistant execution: submit followers' orders into a **CoW batch auction** (uniform
clearing price, hidden pre-settlement, peer-to-peer matching). Live on Arbitrum One
(`@cowprotocol/cow-sdk`). This is the strongest readily-available leakage mitigation. Architect the
executor so "submit swap" is an interface with a `ZeroXExecutor` (now) and a `CowBatchExecutor`
(later) implementation.

## 8. Acceptance
- ✅ 0x v2 quote → `executeSwap` performs a USDC→WETH swap in a vault on a forked Arbitrum
- ✅ router/AllowanceHolder is whitelisted; approval is exact and reset to 0 after
- ✅ on-chain `minOut` reverts when a mock router under-delivers
- ✅ direct Uniswap v3 fallback path swaps correctly when 0x is disabled
- ✅ executor exposes a swappable "submit" interface (0x now, CoW later)
- ✅ exit (token→USDC) works with the exit-slippage policy

→ Next: `42-cross-chain.md`.
