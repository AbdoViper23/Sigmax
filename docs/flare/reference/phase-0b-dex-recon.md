# Phase 0b — Flare Coston2 DEX Recon (FXRP / stablecoin pairing)

**Date:** 2026-08-08
**Network:** Flare Testnet Coston2 — chain id `114` (verified via `cast chain-id`)
**RPC:** `https://coston2-api.flare.network/ext/C/rpc`
**Method:** read-only `cast call` / `cast estimate` / `cast call --trace`. No transactions sent.

---

## TL;DR / Recommendation

**There is NO FXRP/stablecoin pool on BlazeSwap Coston2.** The canonical FXRP has exactly **one**
pair in the entire factory (121 pairs): `FXRP/WC2FLR`, and it holds only **4.75 FXRP** — effectively
dust, and mispriced ~7x vs real XRP.

**Recommendation: seed our own `FXRP / testUSD` pool.**

- `testUSD` (`0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73`, 6 dec) has a **permissionless open faucet**:
  `mint()` takes no args, no access control, and mints **100.000000 testUSD per call** to `msg.sender`.
  Verified by static-simulating from the dev wallet — see [Faucet verification](#faucet-verification).
- `FXRP` is obtainable from the [Coston2 faucet](https://faucet.flare.network/coston2) (Flare docs
  confirm the faucet dispenses C2FLR, FXRP and USDT0); the dev wallet already holds 10 FXRP.
- Both legs are therefore obtainable by the dev wallet with no external dependency.

Do **not** rely on the existing `FXRP/WC2FLR` pool or the 2-hop `FXRP→WC2FLR→testUSD` route for
anything beyond a ~0.01 FXRP smoke test (17% slippage at 1 FXRP, 51% at 5 FXRP).

---

## 1. Canonical FXRP — and a decoy to avoid

There are **two** tokens on Coston2 whose `symbol()` is `FTestXRP` / `name()` is `FXRP`. Only one is live.

| Token | Address | `assetManager()` | Registered in AssetManagerController? | Verdict |
|---|---|---|---|---|
| FTestXRP (canonical) | `0x0b6A3645c240605887a5532109323A3E12273dc7` | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` | **yes** | **use this** |
| FTestXRP (legacy) | `0x8b4abA9C4BD7DD961659b02129beE20c6286e17F` | `0xDeD50DA9C3492Bee44560a4B35cFe0e778F41eC5` | **no** | deprecated — do not use |

Evidence:

- `ContractRegistry.getContractAddressByName("AssetManagerController")` → `0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0`
- `AssetManagerController.getAssetManagers()` → `[0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA]` (exactly one)
- `assetManagerExists(0xc1Ca…)` → `true`; `assetManagerExists(0xDeD50…)` → `false`
- `AssetManagerFXRP.fAsset()` → `0x0b6A3645c240605887a5532109323A3E12273dc7`
- Flare Developer Hub [FAssets Reference](https://dev.flare.network/fassets/reference#deployed-contracts)
  lists the same Coston2 triple (Controller `0x1C77…`, AssetManager `0xc1Ca…`, FTestXRP `0x0b6A…`).

> ⚠️ **This matters a lot.** The legacy FXRP (`0x8b4a…`) is the one with all the funded stablecoin
> pools on BlazeSwap (see §4). It is very easy to look at the factory, see a healthy `FXRP/testUSD`
> pool, and wire the agent to a dead token. The canonical FXRP has none of those pools.

FXRP (canonical) `totalSupply()` = `4133778003657` = **4,133,778.003657 FXRP** (6 dec).

---

## 2. Stablecoins found on Coston2 (all symbols read on-chain)

`AssetManagerFXRP.getCollateralTypes()` returned **2** collateral types:

1. `0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273` — `C2FLR` / WNat, 18 dec (pool collateral)
2. `0x21709e63fc7f264f329e0826ea82197694b82775` — **`testUSDT0`**, 6 dec (vault collateral)

Additional stablecoins discovered by sweeping the BlazeSwap token universe:

| Symbol | Name | Address | Dec | `totalSupply` | Notes |
|---|---|---|---|---|---|
| `testUSDT0` | Test USDT0 | `0x21709e63fc7f264f329e0826ea82197694b82775` | 6 | 10,000,010 | FAssets **vault collateral**. **Zero BlazeSwap pairs.** No mint/faucet selector in bytecode; `mint(uint256)` reverts. Not an EIP-1967 proxy. |
| `testUSD` | Test USD | `0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73` | 6 | 10,000,170,300 | **Open public `mint()` faucet — 100 per call.** Deep `testUSD/WC2FLR` pool. Not FAssets collateral. |
| `eUSDT` | eUSDT Token | `0xC92f35F4B0c73e61CA5E6591F98688d6cfd5a163` | 6 | 1.0e17 | Only a dust `WC2FLR/eUSDT` pair (0.35 WC2FLR / 0.01 eUSDT, last touched 2024). No mint surface. |
| `USDC` | USDC | `0x43DC694BE73BB40A1DEE0B2c50db6e16699E83D3` | 6 | 1.0e19 | Paired only with **legacy** FXRP. No mint surface. |
| `USDC` | USDC | `0xb7F965E9038BE04D3F176fC50A680B723e2c75a7` | 18 | 1.0e9 | Paired only with **legacy** FXRP. No mint surface. Note the non-standard 18 decimals. |

`ContractRegistry` has **no** `USDT0` entry (previously checked; re-confirmed indirectly — the
AssetManager exposes `testUSDT0` only through `getCollateralTypes()`).

**Unverified:** the Flare FAQ states the [Coston2 faucet](https://faucet.flare.network/coston2)
dispenses "C2FLR, FXRP and USDT0". We could not confirm on-chain that the faucet's "USDT0" is
exactly `0x21709e63…`; that is the only USDT0-named token registered as FAssets collateral, so it is
the likely match, but treat it as unverified until a faucet claim is actually made.

---

## 3. BlazeSwap factory sweep

- Factory `0xF0f5e4CdE15b22A423E995415f373FEDC1f8F431`, `allPairsLength()` = **121**
- Router `0x8D29b61C41CF318d15d031BE2928F79630e068e6` → `factory()` and `wNat()` both check out
  (`0xF0f5e4Cd…` / `0xC67DCE33…`)
- All 121 pairs enumerated via `allPairs(i)` + `token0()` / `token1()`

### FXRP (canonical `0x0b6A…`) pairs — the complete list

| # | Pair | Token0 | Token1 | Reserve0 | Reserve1 | Last update |
|---|---|---|---|---|---|---|
| 115 | `0x18Ee914a7EFBE587eA99808b17Be1df184d85B6e` | FXRP (6) | WC2FLR (18) | **4.752648 FXRP** | **177.616988 WC2FLR** | ts `1786117146` (recent) |

That is the **only** one. Direct `getPair()` checks against every stablecoin found returned the zero address:

| `getPair(FXRP, X)` | Result |
|---|---|
| `testUSD` `0x6623C0BB…` | `0x0` (none) |
| `testUSDT0` `0x21709e63…` | `0x0` (none) |
| `eUSDT` `0xC92f35F4…` | `0x0` (none) |
| `USDC` (6) `0x43DC694B…` | `0x0` (none) |
| `USDC` (18) `0xb7F965E9…` | `0x0` (none) |

Also: `getPair(WC2FLR, testUSDT0)` = `0x0`, `getPair(WC2FLR, USDC6)` = `0x0`,
`getPair(WC2FLR, USDC18)` = `0x0`. **testUSDT0 has zero pairs anywhere in the factory.**

Pool depth: at spot the pair implies **1 FXRP ≈ 37.4 WC2FLR ≈ 19.9 testUSD**, i.e. FXRP is
overpriced roughly 7x versus real XRP (~$2–3). The pool holds ~$14 of genuine value.

---

## 4. The trap: funded pools belong to the LEGACY FXRP

The legacy `FTestXRP` `0x8b4abA9C…` has 8 pairs, several well funded:

| Pair | Other token | Reserves (legacy FXRP / other) | Last update |
|---|---|---|---|
| `0x4CFa4bFfAb3E8aEF920C78F9501b5bFF226e5eA8` | `testUSD` (6) | 201.619378 / 2,750.236724 | `1785212590` |
| `0x997fE0d924d57F60bA60cEC67CF0733B4EDF9e39` | `USDC` (6) | 154.000000 / 401.134687 | `1748755084` (stale, 2025) |
| `0xd401FE2C6f233833b15011292AAA4aC750f13510` | `USDC` (18) | 0.000001 / ~0 | stale, dust |
| `0xB43eb92DDAbE59CBab21ec7ABc1E025e5F4eCC38` | `testALGO` | 43.482988 / 2,839.736844 | `1785212882` |
| `0x8d6f48f01D53029f5Dbd6DA1927D4bCC26d977c0` | `testXLM` | 71.488948 / 2,158.4696401 | `1785213140` |
| `0x4b9b881CF18CBed674561D282c01C1B6737905F5` | `testDGB` | 38.702994 / 66,663.34757574 | `1785213077` |
| `0xbF60b84E3F0924E96553796b79D77c54F82f58da` | `testFIL` | 38.286298 / 116.178862 | `1785213116` |
| `0xEE56b0A045bc88a15EA23312f2A662c4d94cCf1B` | `testBCH` | 44.405868 / 6.02731425 | `1773036692` |

None of these are usable — the token is not the fAsset of any registered AssetManager, so it cannot
be minted or redeemed and has no relationship to real testnet XRP.

---

## 5. Existing routes for canonical FXRP → stablecoin

A 2-hop route **does** work today via WC2FLR, because `testUSD/WC2FLR`
(`0x26Baa4d1F7c836384Bd0117Fb6a003518d2ddE68`) is deep: **59,360.050481 testUSD / 111,583.879597 WC2FLR**.

`router.getAmountsOut(amountIn, [FXRP, WC2FLR, testUSD])`:

| FXRP in | testUSD out | Effective testUSD/FXRP | Slippage vs 0.01 FXRP |
|---|---|---|---|
| 0.01 | 0.197206 | 19.72 | — (reference) |
| 0.10 | 1.935537 | 19.36 | 1.9% |
| 0.50 | 8.941655 | 17.88 | 9.3% |
| 1.00 | 16.330777 | 16.33 | 17.2% |
| 5.00 | 48.187107 | 9.64 | 51.1% |

The bottleneck is entirely the `FXRP/WC2FLR` leg (4.75 FXRP of depth). Usable only for a token-plumbing
smoke test, not for a demo that trades meaningful size.

---

## 6. Dev wallet balances — `0xecb5DD1c755FCE23735f2Eb41Dbd3533CB62647b`

| Asset | Address | Balance |
|---|---|---|
| C2FLR (native) | — | **100.0 C2FLR** |
| FXRP (canonical) | `0x0b6A3645c2…` | **10.000000 FXRP** |
| WC2FLR | `0xC67DCE33D7…` | 0 |
| testUSD | `0x6623C0BB56…` | 0 |
| testUSDT0 | `0x21709e63fc…` | 0 |
| eUSDT | `0xC92f35F4B0…` | 0 |
| USDC (6) | `0x43DC694BE7…` | 0 |
| USDC (18) | `0xb7F965E903…` | 0 |
| FTestXRP (legacy) | `0x8b4abA9C4B…` | 0 |

---

## Faucet verification

`testUSD.mint()` static-simulated from the dev wallet (**no transaction sent**):

```
cast call 0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73 "mint()" --from 0xecb5DD1c... --trace

  [51855] 0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73::mint()
    ├─ emit Transfer(from: 0x0, to: 0xecb5DD1c…, amount: 100000000)
    └─ ← [Stop]
  Transaction successfully executed. Gas used: 72919
```

`mint()` takes no arguments, reverts for nobody, and credits `msg.sender` with `1e8` = **100.000000
testUSD**. `cast estimate` returns 73791 gas — no access-control revert.

**Unverified:** whether `mint()` is rate-limited per address or per block. The simulation is against
current head state, so a per-address cooldown (if any) is not currently blocking the dev wallet. Plan
for possibly needing many calls, and test the second call before relying on a large seeding amount.

By contrast `testUSDT0` exposes **no** mint entry point: a PUSH4 scan of its runtime bytecode finds
no `mint(address,uint256)` / `mint()` / `mint(uint256)` / `mintTo` / `faucet()` selector, `owner()`
and `MINTER_ROLE()` both revert, and the EIP-1967 implementation slot is zero (not a proxy). It can
only be obtained from the faucet, if at all.

---

## 7. Recommendation in detail

**Seed our own `FXRP / testUSD` BlazeSwap pool.**

Why this pair:

| Candidate | Verdict |
|---|---|
| Use existing `FXRP/WC2FLR` | ❌ 4.75 FXRP of depth, ~7x mispriced. Unusable for demo size. |
| Use existing `FXRP/testUSD` | ❌ **Does not exist** — `getPair` returns `0x0`. |
| Use legacy-FXRP `testUSD` pool | ❌ Wrong token, not backed by any registered AssetManager. |
| Pair with `testUSDT0` | ❌ Zero pairs on BlazeSwap, no mint path, faucet supply unconfirmed. We'd be blocked on acquiring the token at all. |
| **Seed `FXRP/testUSD`** | ✅ Both legs obtainable by the dev wallet today. |

Concrete plan:

1. **Get testUSD** — call `testUSD.mint()` N times (100 testUSD each). For a pool priced near real XRP
   (~$2.20/XRP) against, say, 500 FXRP, that's ~1,100 testUSD → ~11 `mint()` calls.
2. **Get FXRP** — top up from https://faucet.flare.network/coston2 (dev wallet holds 10 FXRP now).
   If the faucet caps out, the full FAssets mint path against `AssetManagerFXRP` `0xc1Ca88b9…` is the
   fallback (needs testnet XRP from the XRPL faucet).
3. **Top up C2FLR** for gas from the same faucet (100 C2FLR on hand is fine for a handful of txs).
4. **Create + seed the pool** — `router.addLiquidity(FXRP, testUSD, …)` on
   `0x8D29b61C41CF318d15d031BE2928F79630e068e6`. The factory auto-creates the pair. Seed at a
   realistic XRP price so the demo quotes look sane; both tokens are 6-decimal, which keeps the math
   simple.
5. **Record the new pair address** here once created, and point the agent's swap config at the direct
   `FXRP→testUSD` path (single hop, no WC2FLR leg).

Caveat to carry forward: `testUSD` is **not** FAssets vault collateral and has no oracle/FTSO feed
tied to it — it is a plain test ERC-20 that happens to be freely mintable. That is fine for a
hackathon demo of swap execution, but it is not a "real" stablecoin, and the pool price is whatever
we set it to. If a judge asks for a canonical stablecoin, the honest answer is that Coston2's
FAssets vault collateral (`testUSDT0`) has **no DEX liquidity whatsoever**.

---

## Appendix — key addresses

| Name | Address |
|---|---|
| ContractRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` |
| AssetManagerController | `0x1C772F700308aF4c13897cc7b9c41EFfB82c50C0` |
| AssetManager FTestXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
| FXRP / FTestXRP (canonical, 6 dec) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| WNat / WC2FLR (18 dec) | `0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273` |
| BlazeSwap factory | `0xF0f5e4CdE15b22A423E995415f373FEDC1f8F431` |
| BlazeSwap router | `0x8D29b61C41CF318d15d031BE2928F79630e068e6` |
| testUSD (6 dec, open faucet) | `0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73` |
| testUSDT0 (6 dec, FAssets collateral) | `0x21709e63fc7f264f329e0826ea82197694b82775` |
| Pair FXRP/WC2FLR | `0x18Ee914a7EFBE587eA99808b17Be1df184d85B6e` |
| Pair testUSD/WC2FLR | `0x26Baa4d1F7c836384Bd0117Fb6a003518d2ddE68` |
| ⚠️ Legacy FTestXRP (do not use) | `0x8b4abA9C4BD7DD961659b02129beE20c6286e17F` |
| ⚠️ Legacy AssetManager (unregistered) | `0xDeD50DA9C3492Bee44560a4B35cFe0e778F41eC5` |
