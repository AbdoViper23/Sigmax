# 12 — SubscriptionRegistry.sol (monthly subscriptions)

> The contract that turns "the follower paid this month" into an on-chain boolean the read
> condition and the agent both trust. This is what makes a **monthly subscription** work and what
> the agent checks before executing for each follower.
> Read with `contracts/11-cdr-conditions.md` (the condition that reads this) and
> `cdr-story/21-story-ip-royalty.md` (how payment + revenue split happen).

---

## 1. What it is

A registry mapping `(subscriber, strategyId) → subscription expiry timestamp`. Paying extends the
expiry by one month. Two consumers read it:
1. **`SubscriptionReadCondition`** (Story) — gates CDR decryption on `isActive(...)` (Option B in `11`).
2. **The agent** — before executing a signal for a follower, it checks `isActive(follower, strategyId)`.

It lives on **Story L1** (so the read condition can call it natively in the same execution context).
The agent reads it cross-chain via RPC (it's just a view call). See `execution/42-cross-chain.md`.

## 2. Why a registry instead of "just NFT ownership"

Story License Tokens prove a one-time mint, not a *recurring, expiring* subscription. A registry
gives clean monthly semantics (expiry, renewal, grace) without minting/burning an NFT every month,
and lets the agent answer "is this person currently paying?" with a single view call.

The registry can still be **funded through Story's royalty system** so revenue auto-splits — see §6.

## 3. State & data model

```solidity
struct Sub {
    uint64 expiry;       // unix seconds; active iff block.timestamp <= expiry
    uint64 startedAt;    // first subscription (for analytics)
    uint32 renewals;     // count of renewals (for "loyal follower" features)
}

// strategyId => subscriber => Sub
mapping(uint256 => mapping(address => Sub)) public subs;

// strategyId => config
struct Plan {
    address leader;          // who owns the strategy / receives revenue
    address payToken;        // $WIP (or a stablecoin) used to pay
    uint256 monthlyPrice;    // price for 30 days
    uint16  platformFeeBps;  // platform cut in basis points (e.g. 1500 = 15%)
    bool    active;          // leader can pause new subs
}
mapping(uint256 => Plan) public plans;

uint64 public constant PERIOD = 30 days;
uint64 public constant GRACE  = 2 days;   // optional: keep active briefly past expiry
address public platformTreasury;
```

## 4. Functions

### Leader sets up a plan
```solidity
function createPlan(
    uint256 strategyId,
    address payToken,
    uint256 monthlyPrice,
    uint16 platformFeeBps
) external;                                  // msg.sender becomes the plan leader
function setPlanActive(uint256 strategyId, bool active) external onlyLeader(strategyId);
function setMonthlyPrice(uint256 strategyId, uint256 price) external onlyLeader(strategyId);
```

### Follower subscribes / renews
```solidity
/// @notice Pay for one month. Extends from max(now, current expiry) so early renewals stack.
function subscribe(uint256 strategyId) external {
    Plan memory p = plans[strategyId];
    require(p.active, "PLAN_INACTIVE");

    // pull payment, split fee
    uint256 fee = (p.monthlyPrice * p.platformFeeBps) / 10_000;
    IERC20(p.payToken).safeTransferFrom(msg.sender, platformTreasury, fee);
    IERC20(p.payToken).safeTransferFrom(msg.sender, p.leader, p.monthlyPrice - fee);
    // (production: route through Story Royalty Vault instead — see §6)

    Sub storage s = subs[strategyId][msg.sender];
    uint64 base = uint64(block.timestamp) > s.expiry ? uint64(block.timestamp) : s.expiry;
    if (s.startedAt == 0) s.startedAt = uint64(block.timestamp);
    else s.renewals += 1;
    s.expiry = base + PERIOD;

    emit Subscribed(strategyId, msg.sender, s.expiry);
}
```

### The view everyone trusts
```solidity
function isActive(address subscriber, uint256 strategyId) public view returns (bool) {
    return block.timestamp <= subs[strategyId][subscriber].expiry + GRACE;
}
function expiryOf(address subscriber, uint256 strategyId) external view returns (uint64) {
    return subs[strategyId][subscriber].expiry;
}
```

## 5. How the three parts use it

```
Follower ──subscribe()──► SubscriptionRegistry ──isActive()──► SubscriptionReadCondition (decrypt gate)
                                       ▲
                                       └──isActive()── Agent (execution-eligibility gate)
```

- **Decryption** (Option B): the read condition calls `isActive`. (Note the "who decrypts" decision
  in `contracts/11 §5`: with operator-decrypt, the condition checks the operator, while the agent
  uses the registry to decide *which followers it trades for*.)
- **Execution eligibility:** the agent calls `isActive(follower, strategyId)` before every entry.
  - **Active** → open entries + manage exits.
  - **Expired** → open **no new entries**, but still **manage the exit of an already-open position**
    (don't strand a follower mid-trade). This rule lives in the agent (`agent/31`), enforced by
    reading the registry.

## 6. Revenue routing: registry vs Story Royalty Vault

Two payment paths; both supported, different stages:

- **MVP (simple):** `subscribe()` splits the payment directly (leader + platform treasury) as shown
  above. Easy to demo, easy to reason about.
- **Product (Story-native):** instead of a direct transfer, the subscription payment is a
  **license mint** that pays `$WIP` into the strategy's **IP Royalty Vault**; the platform holds a
  slice of the 100 Royalty Tokens and claims its cut permissionlessly via `claimAllRevenue`. This
  is the canonical Story revenue model and keeps everything on-protocol. (Full detail in
  `cdr-story/21-story-ip-royalty.md`.) In this path, `subscribe()` becomes "mint license + write
  expiry to the registry," and the registry stops handling money directly.

> Decision: ship the simple split for the hackathon; migrate to the Royalty-Vault path for launch.
> Keep the `isActive` interface identical so nothing downstream changes.

## 7. Access control & safety
```solidity
modifier onlyLeader(uint256 strategyId) { require(msg.sender == plans[strategyId].leader); _; }
```
- `subscribe` is permissionless (anyone can pay to follow).
- Only the plan's leader can change price / pause.
- `platformTreasury` and `platformFeeBps` bounds: cap `platformFeeBps` (e.g. ≤ 3000) in code so a
  misconfig can't take an absurd cut.
- Use `SafeERC20`; no reentrancy surface (no external calls after state writes beyond token
  transfers — still mark `subscribe` `nonReentrant` to be safe).

## 8. Events
```solidity
event PlanCreated(uint256 indexed strategyId, address indexed leader, uint256 monthlyPrice);
event Subscribed(uint256 indexed strategyId, address indexed subscriber, uint64 newExpiry);
event PlanActiveSet(uint256 indexed strategyId, bool active);
```
The frontend uses `Subscribed` to show "active until {date}"; the leaderboard counts active subs.

## 9. Foundry tests (acceptance)
- ✅ `createPlan` sets leader/price/fee; non-leader cannot change price or pause
- ✅ `subscribe` pulls payment, splits fee correctly (leader vs treasury), sets expiry = now + 30d
- ✅ early renewal **stacks** (extends from current expiry, not from now)
- ✅ `isActive` true within period (+grace), false after expiry+grace
- ✅ `platformFeeBps` cannot exceed the hard cap
- ✅ `subscribe` reverts when plan inactive
- ✅ cross-check: `SubscriptionReadCondition` returns the same `isActive` result (integration test)

## 10. MVP vs defer
- **MVP:** single-month `subscribe`, direct fee split, `isActive` with grace, leader plan controls.
- **Defer:** auto-renew (needs a keeper pulling payment — like TP/SL, a keeper concern), multi-tier
  plans, discounts for loyal renewers, and the Royalty-Vault payment path (migrate at launch).

→ Next batch: `cdr-story/` — `20-cdr-sdk.md`, `21-story-ip-royalty.md`, `22-signal-template.md`.
