# 11 — CDR Condition Contracts (Story-side access control)

> The Solidity contracts on **Story L1** that decide **who may publish** a signal (write) and
> **who may decrypt** it (read). These are the gatekeepers of the encrypted vault. Grounded in the
> verbatim interface from `piplabs/cdr-sdk` `docs/CONDITIONS.md`.
> Read `cdr-story/20-cdr-sdk.md` for how the SDK calls these.

---

## 1. How CDR conditions work (verified)

When someone calls write/read on the CDR contract, the protocol:
1. looks up the vault's `writeConditionAddr` / `readConditionAddr`,
2. calls that contract with `(caller, conditionData, accessAuxData)`,
3. **rejects the operation if the contract returns `false` or reverts.**

Enforcement is at the protocol level — the SDK does **not** enforce conditions locally; an
unauthorized read/write reverts on-chain.

### The exact interface (must match verbatim)
```solidity
// Write conditions
function checkWriteCondition(
    address caller,
    bytes calldata conditionData,
    bytes calldata accessAuxData
) external view returns (bool);

// Read conditions
function checkReadCondition(
    address caller,
    bytes calldata conditionData,
    bytes calldata accessAuxData
) external view returns (bool);
```

| Parameter | Source | Meaning |
|---|---|---|
| `caller` | `msg.sender` of the CDR write/read call | who is attempting the op |
| `conditionData` | stored **at vault allocation time** | static config (token addr, IP id, registry addr, role) |
| `accessAuxData` | supplied **by the caller at access time** | dynamic proof (license token IDs, a signature, a Merkle proof) |

If a condition needs no extra data, pass `"0x"`.

## 2. Deployed contracts we can reuse on Aeneid (chain 1315)

| Contract | Address | Use |
|---|---|---|
| `OwnerWriteCondition` | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` | only the address encoded in `writeConditionData` may write |
| `LicenseReadCondition` | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` | only Story license-token holders for a given IP may read |

**These two already cover the simplest version of Sigmax** — we don't have to write any new
condition contract for the MVP if we model a subscription as a Story License Token (see Option A).

## 3. Two ways to gate decryption (pick one for the MVP)

Sigmax's read condition must answer: *"is this caller an active subscriber?"* Two designs:

### Option A (MVP, lowest effort) — reuse `LicenseReadCondition`
A subscription **is** a Story License Token for the leader's strategy IP. Decryption is gated on
holding that token. No new Solidity needed.

- **Allocation (publish time)** — encode the LicenseToken contract + the strategy's IP id:
  ```ts
  const readCondData = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [LICENSE_TOKEN_CONTRACT, STRATEGY_IP_ID]      // ipId is an ERC-6551 ADDRESS, not a uint
  );
  // readConditionAddr: "0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3"
  ```
- **Read time** — caller passes the license token IDs:
  ```ts
  const accessAuxData = encodeAbiParameters([{ type: "uint256[]" }], [[BigInt(licenseTokenId)]]);
  ```
- **Who reads?** In Sigmax the **agent** decrypts, so the agent must hold (or be delegated) a
  valid license token. Simplest: the leader mints one "operator" license to the agent's address at
  setup; the agent uses it for `accessCDR`. Per-follower payment is then tracked separately for
  *execution eligibility* (who the agent trades for), not for decryption. See note in §5.
- **Limitation:** Story License Tokens are not inherently "monthly." For time-boxed monthly access
  you either (a) mint licenses with a PIL `expiration` and re-mint monthly, or (b) use Option B.

### Option B (cleaner monthly subs) — custom `SubscriptionReadCondition`
Gate decryption on an **active subscription** tracked in our own `SubscriptionRegistry` on Story
(see `contracts/12`). This gives true monthly expiry without re-minting NFTs.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISubscriptionRegistry {
    function isActive(address subscriber, uint256 strategyId) external view returns (bool);
}

contract SubscriptionReadCondition {
    ISubscriptionRegistry public immutable registry;
    constructor(address _registry) { registry = ISubscriptionRegistry(_registry); }

    /// conditionData = abi.encode(uint256 strategyId)
    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata /*accessAuxData*/
    ) external view returns (bool) {
        uint256 strategyId = abi.decode(conditionData, (uint256));
        return registry.isActive(caller, strategyId);
    }

    function checkWriteCondition(address, bytes calldata, bytes calldata)
        external pure returns (bool) { return false; } // not a write condition
}
```
- **Allocation:** `readConditionData = abi.encode(strategyId)`, `readConditionAddr =` deployed
  `SubscriptionReadCondition`.
- **Read time:** `accessAuxData = "0x"` (nothing dynamic needed; the registry holds the truth).
- **Same caller note as Option A:** the agent is the one calling `accessCDR`, so for Option B the
  registry must consider the **agent** active for the strategy (e.g. the registry returns true for
  the platform's operator address), OR the agent reads with its operator license while the registry
  governs *which followers it executes for*. Decide this explicitly (see §5).

### `LeaderWriteCondition` (write side, both options)
Only the leader may publish/update signals. Reuse the deployed `OwnerWriteCondition`
(`writeConditionData = abi.encode(leaderAddress)`), or write a trivial equivalent if you want the
leader to be a contract/multisig:
```solidity
contract LeaderWriteCondition {
    function checkWriteCondition(address caller, bytes calldata conditionData, bytes calldata)
        external pure returns (bool) { return caller == abi.decode(conditionData, (address)); }
    function checkReadCondition(address, bytes calldata, bytes calldata)
        external pure returns (bool) { return false; }
}
```

## 4. Recommendation

- **Hackathon MVP:** use **Option A** (reuse `LicenseReadCondition` + `OwnerWriteCondition`) to
  prove the full loop with zero new Story Solidity. It maps a subscription to a license token and
  is the canonical CDR pattern judges expect.
- **Product (monthly subs):** add **Option B** (`SubscriptionReadCondition` + `SubscriptionRegistry`)
  for real time-boxed monthly access without re-minting NFTs. This is the better long-term design
  and is itself a clean "novel custom condition" for the Technical track.

## 5. The "who decrypts" decision (resolve this early — it's subtle)

There are two viable models; pick ONE and document it in code:

- **Operator-decrypt (recommended for MVP):** the **agent/platform** holds the decryption right
  (one operator license or an operator entry in the registry). It decrypts each signal **once**,
  then executes for every follower whose subscription is active (eligibility checked against the
  registry / license ownership). This matches the auto-execute product: followers never decrypt.
- **Follower-decrypt:** each follower holds their own license and could decrypt themselves. Not
  needed for auto-execution and exposes plaintext to followers (re-share risk) — avoid unless you
  add a "manual mode."

→ See `agent/31-agent-execution-flow.md` for how the agent uses its decryption right, and
`contracts/12-subscription-registry.md` for the registry that governs execution eligibility.

## 6. Encoding cheat-sheet (so publisher and reader always agree)

| Field | Option A (License) | Option B (Subscription) |
|---|---|---|
| `readConditionAddr` | `0xC064…f7a3` | deployed `SubscriptionReadCondition` |
| `readConditionData` | `abi.encode(licenseToken, ipId)` | `abi.encode(strategyId)` |
| `accessAuxData` (read) | `abi.encode(uint256[] tokenIds)` | `0x` |
| `writeConditionAddr` | `0x4C9b…c34B` | `0x4C9b…c34B` or `LeaderWriteCondition` |
| `writeConditionData` | `abi.encode(leader)` | `abi.encode(leader)` |

> Keep these encodings in `packages/shared` so the web app (allocation) and the agent (read) use
> identical encoders. A mismatch = silent decryption failures.

## 7. Foundry tests (acceptance)
- ✅ `SubscriptionReadCondition.checkReadCondition` returns true for an active sub, false when expired
- ✅ `checkWriteCondition` returns false (it's read-only)
- ✅ `LeaderWriteCondition` returns true only for the encoded leader, false otherwise
- ✅ encode/decode round-trips match the `packages/shared` encoders (cross-checked in a TS test)
- ✅ `simulateContract` against a deployed condition reproduces the expected accept/reject

→ Next: `12-subscription-registry.md`.
