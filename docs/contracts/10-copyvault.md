# 10 — CopyVault.sol (the core contract)

> The single most important contract you will write. It is the **per-follower, non-custodial vault**
> on the liquidity chain (Arbitrum One / Base). It holds the follower's spot funds and lets the
> agent execute swaps **within strict bounds** — and nothing else.
> Read alongside `key-management/50-non-custodial.md` (the trust model) and `execution/41-dex-swaps.md`
> (how the swap calldata is produced).

---

## 1. What it is and why it exists

A `CopyVault` is a smart contract owned by one follower. The follower deposits spot funds (e.g.
USDC) into it. The agent is granted a **restricted executor role** that can call exactly one
state-changing trading function — `executeSwap` — and only within a token whitelist and size caps.
**Only the follower can withdraw.** The agent can never move funds out to itself.

This is what makes Sigmax non-custodial: even if the agent's key is fully compromised, the
attacker can at worst swap the follower's whitelisted tokens among themselves at honest market
prices (bounded by `minOut`); they cannot withdraw the funds. (See `key-management/50` for the full
threat analysis and the session-key alternatives.)

## 2. Hard requirements (from CLAUDE.md)

- **SPOT ONLY.** `executeSwap` is the only trading primitive. No function may borrow, leverage,
  short, or open a margin position. There is intentionally no "approve arbitrary call" path.
- **NON-CUSTODIAL.** `withdraw` is `onlyOwner`. The executor role can never transfer tokens to an
  arbitrary address; it can only route an exact-input swap through a whitelisted router and must
  leave the proceeds in the vault.
- **BOUNDED.** Every swap is checked against a token whitelist, a router whitelist, a per-trade cap,
  and a rolling daily cap. A failing check reverts (never silently clamps).

## 3. State

```solidity
address public immutable owner;          // the follower; set in constructor
bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

mapping(address => bool) public whitelistedToken;    // tokens allowed in/out of a swap
mapping(address => bool) public whitelistedRouter;   // DEX/aggregator routers allowed

uint256 public perTradeCap;              // max amountIn per single swap (in the input token's units)
uint256 public dailyCap;                 // max cumulative amountIn per rolling day
uint256 public spentToday;               // running total for the current day bucket
uint256 public dayStart;                 // unix timestamp of the current day bucket start
```

> Caps are denominated in a **single reference input token** for the MVP (e.g. USDC, 6 decimals)
> to keep accounting simple. If you later allow multiple input tokens, value the cap via an oracle
> — but for the MVP, restrict entries to swapping FROM the reference token. (See §9.)

## 4. Functions

### Constructor / setup (owner only)
```solidity
constructor(address _owner) { owner = _owner; _grantRole(DEFAULT_ADMIN_ROLE, _owner); }

function setExecutor(address agent, bool enabled) external onlyOwner;       // grant/revoke EXECUTOR_ROLE
function setTokenWhitelist(address token, bool allowed) external onlyOwner;
function setRouterWhitelist(address router, bool allowed) external onlyOwner;
function setCaps(uint256 _perTradeCap, uint256 _dailyCap) external onlyOwner;
```

### Deposit / withdraw (owner controls funds)
```solidity
function deposit(address token, uint256 amount) external;                   // pull tokens in (SafeERC20)
function withdraw(address token, uint256 amount) external onlyOwner;        // ONLY owner can remove funds
function withdrawAll(address token) external onlyOwner;
```

### The one trading primitive (executor only)
```solidity
/// @notice Execute a single spot swap inside the vault. Agent-only, bounded.
/// @param router   a whitelisted DEX/aggregator router (e.g. 0x AllowanceHolder)
/// @param tokenIn  whitelisted input token
/// @param tokenOut whitelisted output token
/// @param amountIn exact input amount (<= perTradeCap, rolling <= dailyCap)
/// @param minOut   minimum acceptable output (slippage backstop, enforced on-chain)
/// @param swapData calldata produced off-chain by the aggregator (see execution/41)
function executeSwap(
    address router,
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    uint256 minOut,
    bytes calldata swapData
) external onlyRole(EXECUTOR_ROLE) nonReentrant {
    require(whitelistedToken[tokenIn] && whitelistedToken[tokenOut], "TOKEN_NOT_WHITELISTED");
    require(whitelistedRouter[router], "ROUTER_NOT_WHITELISTED");
    require(amountIn > 0 && amountIn <= perTradeCap, "PER_TRADE_CAP");
    _accrueDaily(amountIn);  // updates the day bucket; reverts if > dailyCap

    uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

    // exact, scoped approval to the router for this swap only
    IERC20(tokenIn).forceApprove(router, amountIn);
    (bool ok, ) = router.call(swapData);
    require(ok, "SWAP_FAILED");
    IERC20(tokenIn).forceApprove(router, 0);   // reset approval (no lingering allowance)

    uint256 received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
    require(received >= minOut, "MIN_OUT");     // proceeds MUST stay in the vault

    emit Swapped(tokenIn, tokenOut, amountIn, received, router);
}
```

### Internal daily-cap accounting
```solidity
function _accrueDaily(uint256 amountIn) internal {
    if (block.timestamp >= dayStart + 1 days) { dayStart = block.timestamp; spentToday = 0; }
    require(spentToday + amountIn <= dailyCap, "DAILY_CAP");
    spentToday += amountIn;
}
```

## 5. Why `executeSwap` cannot be abused

| Attack | Why it fails |
|---|---|
| Agent tries to withdraw funds | No path: `withdraw` is `onlyOwner`; `executeSwap` leaves proceeds in the vault |
| Agent swaps to a token it controls then drains | Output token must be **whitelisted**; the follower only whitelists real assets, and proceeds stay in-vault |
| Agent routes through a malicious router that steals | Router must be **whitelisted** (only known aggregators); approval is exact and reset to 0 after |
| Agent sandwiches/over-slips the follower | `minOut` enforced on-chain as a backstop independent of the off-chain quote |
| Agent drains via many tiny swaps | `dailyCap` bounds total daily volume; `perTradeCap` bounds each |
| Reentrancy via router callback | `nonReentrant` guard + checks-effects-interactions |
| Leftover allowance exploited later | Approval reset to 0 at the end of every swap |

## 6. Events
```solidity
event Deposited(address indexed token, uint256 amount);
event Withdrawn(address indexed token, uint256 amount);
event ExecutorSet(address indexed agent, bool enabled);
event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address router);
```
The agent and the frontend index `Swapped` to show trade history. **Never** emit the strategy logic,
the take-profit, or the stop-loss — those are off-chain secrets (CLAUDE.md rule 3).

## 7. The factory

Followers shouldn't hand-deploy. `CopyVaultFactory` deploys a vault per follower deterministically:
```solidity
function createVault(
    address agent,
    address[] calldata tokens,
    address[] calldata routers,
    uint256 perTradeCap,
    uint256 dailyCap
) external returns (address vault);   // deploys CopyVault(msg.sender), wires whitelist+caps+executor

mapping(address => address) public vaultOf;   // follower => their vault
event VaultCreated(address indexed owner, address vault);
```
Use CREATE2 with the follower address as salt so the vault address is predictable (the agent and
frontend can derive it without an extra lookup). One transaction sets everything up.

## 8. Foundry test checklist (acceptance for this contract)

Write these in `test/CopyVault.t.sol`; the contract is "done" only when all pass:

- ✅ owner can deposit and withdraw; **non-owner withdraw reverts**
- ✅ executor can `executeSwap` on whitelisted tokens/router within caps
- ✅ swap with a **non-whitelisted token** reverts (`TOKEN_NOT_WHITELISTED`)
- ✅ swap with a **non-whitelisted router** reverts (`ROUTER_NOT_WHITELISTED`)
- ✅ swap exceeding `perTradeCap` reverts; exceeding `dailyCap` reverts; daily bucket **resets** after 24h
- ✅ swap returning `< minOut` reverts (use a mock router that under-delivers)
- ✅ **non-executor cannot call `executeSwap`**
- ✅ revoked executor (`setExecutor(agent,false)`) can no longer swap
- ✅ reentrancy attempt via a malicious router is blocked
- ✅ token approval is 0 after every swap (no lingering allowance)
- ✅ fork test: a real 0x quote against a forked Arbitrum/Base actually swaps USDC→WETH in-vault
  (`anvil --fork-url`, see `execution/41` and `40`)

## 9. MVP simplifications (and what to defer)

- **MVP:** entries swap FROM a single reference token (USDC) INTO a whitelisted target; exits swap
  back to USDC. Caps denominated in USDC. This avoids needing an oracle to value caps.
- **Defer:** multi-input-token caps (needs a price oracle), partial fills, limit-style entries
  (needs a keeper — see `agent/32`), and gas abstraction (paymaster — see `key-management/50`).
- **Defer:** upgradeability. Keep the MVP vault immutable + simple; redeploy the factory if logic
  changes. (Upgradeable vaults add audit surface; not worth it pre-launch.)

## 10. Security notes for the audit (see business/91 for cost)

- This is the only contract holding user funds → it is the audit's primary focus.
- Keep it small and boring: no assembly beyond what OZ provides, no delegatecall, no arbitrary
  external calls except the bounded `router.call(swapData)` to a **whitelisted** router.
- Consider a per-vault `pause()` (owner-only) so a follower can freeze execution instantly in an
  incident, independent of revoking the executor.

→ Next: `11-cdr-conditions.md` (the Story-side access conditions) and `12-subscription-registry.md`.
