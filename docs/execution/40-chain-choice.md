# 40 — Liquidity Chain Choice (Arbitrum One vs Base)

> Which chain executes the spot swaps. The CDR vault + conditions + IP/royalty live on Story; the
> actual trading happens on a high-liquidity EVM chain because Story has no real spot liquidity.
> Pairs with `execution/41` (the swaps) and `execution/42` (linking the two chains).

---

## 1. The decision in one line

**Both Arbitrum One and Base are excellent for aggregator-routed spot swaps. Pick ONE for the MVP;
the other is a near-free secondary deployment (both EVM, both supported by the same tooling).**

Default recommendation: **Arbitrum One** if you want the deepest stablecoin/multi-protocol liquidity
and the most mature DeFi + CoW Protocol support; **Base** if you want the highest raw spot DEX
volume and the lowest fees. For Sigmax's MVP either is fine — choose Arbitrum One unless you have
a Base-specific reason, because **CoW Protocol (our MEV/leakage-resistance path) is live on Arbitrum
One** and that matters for `security/70`.

## 2. The data (and why sources disagree — read before quoting numbers)

The liquidity picture in 2026 is healthy on both chains, but **headline numbers conflict by source
because they measure different things** — don't cite a single figure as gospel:
- **DefiLlama TVL (May 2026):** Base ~**$4.3B** leading Arbitrum ~**$1.5B** (assets actively
  deployed in DeFi). On this metric Base leads.
- **L2Beat-style TVS (per Aave's Arbitrum post, Dec 2025):** Arbitrum ~**$17B total value secured**,
  ~**$3B TVL**, ~**$8B stablecoins** (ranks first among L2s by value secured). The gap vs DefiLlama
  is **methodology** (total value bridged/secured vs assets in DeFi), not an error.
- **Spot DEX volume:** Base's Aerodrome posted ~**$13.3B 30-day spot volume** (~$99M annualized
  fees) as of May 2026 — a real Base lead in raw spot throughput.

**Takeaway:** Arbitrum = deepest stablecoin + multi-protocol depth + most mature DeFi/CoW; Base =
highest spot DEX volume + cheapest fees. For retail-size copy-trading swaps, the slippage difference
is negligible. **Verify current numbers at build time** (`94-risks-and-unknowns.md`); don't hardcode
a decision to a stale figure.

## 3. What actually matters for Sigmax (the real selection criteria)

| Criterion | Why it matters here | Arbitrum One | Base |
|---|---|---|---|
| Aggregator support (0x) | our primary swap path (`41`) | ✅ | ✅ |
| CoW Protocol (batch auctions) | leakage/MEV resistance (`70`) | ✅ live | partial/varies — verify |
| Stablecoin depth (USDC) | entries/exits are USDC↔token | deepest among L2s | deep |
| Gas cost per swap | many small follower swaps | very low (~$0.02–0.05) | very low |
| Tooling maturity (RPC, fork) | Anvil fork for the demo | excellent | excellent |
| Chain id | config | 42161 | 8453 |

**CoW availability on Arbitrum One** tips the MVP toward Arbitrum, because reducing on-chain strategy
leakage (`security/70`) is a core product concern, not a nicety.

## 4. Recommendation

- **MVP / launch:** **Arbitrum One (42161)**. Deep USDC liquidity, 0x + CoW both available, cheap
  gas, mature fork tooling for the demo.
- **Secondary (low effort):** **Base (8453)** — deploy the same `CopyVaultFactory` + agent config;
  add it once Arbitrum is solid. Followers pick their chain in the UI.
- Keep chain specifics behind `shared/chains.ts` so adding Base is config, not code.

## 5. Demo/testnet reality (important)

**Aeneid (Story testnet) has no real spot liquidity, and L2 testnets have thin/fake liquidity.** So:
- **Demo swaps against a forked mainnet L2:** `anvil --fork-url $ARBITRUM_RPC` gives real pools and
  real 0x routes locally. The CopyVault + agent execute genuine swaps against forked liquidity. This
  is the credible way to show the full loop without spending real funds. (`execution/41 §fork`.)
- Story-side (CDR publish/decrypt, IP/license) runs on **real Aeneid testnet** — that part has no
  liquidity dependency.
- For a public live demo, you can also point at a mainnet L2 with tiny real amounts once audited.

## 6. Acceptance
- ✅ `shared/chains.ts` defines Arbitrum One (42161) with RPC, USDC address, 0x + CoW endpoints
- ✅ adding Base (8453) is a config entry, no code changes in agent/contracts
- ✅ `anvil --fork-url` of the chosen chain lets CopyVault.executeSwap perform a real USDC→WETH swap
- ✅ the chain choice + current liquidity figures are re-verified and noted in `94`

→ Next: `41-dex-swaps.md`.
