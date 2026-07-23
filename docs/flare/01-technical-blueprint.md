# Sigmax on Flare — Verified Technical Blueprint

**Date:** July 23, 2026 · **Target:** Flare Summer Signal hackathon, submission Aug 14, 2026 · **Author's verdict:** BUILDABLE in 4 weeks with disciplined scope cuts. The core loop (encrypt-to-enclave signal → Confidential Space TEE agent → Flare control plane → Hyperliquid spot fan-out) is fully available today. The XRPL-native "moat" (FSA) is real and developer-open, but must be scoped to *subscription payment on Flare*, not cross-chain trade approval. FCC is correctly excluded — it is not production-ready.

---

## TL;DR
- **GO on the core.** Encrypt-to-enclave (HPKE), Google Confidential Space (GA on Intel TDX since September 2024 and AMD SEV-SNP), Flare control-plane contracts, and Hyperliquid spot execution via `approveAgent` (trade-only, cannot withdraw — confirmed in HL docs) are all verified available today. FXRP/USDC spot has been live since Jan 7, 2026 and FXRP/USDH since ~Jan 28, 2026.
- **FSA is real and open to third-party devs, but narrower than the moat pitch.** It controls a Flare-side `PersonalAccount` only. Use it for one-XRPL-signature subscription payment in FXRP; it **cannot** grant trade-only permission over funds sitting on Hyperliquid, Sui, or other EVM chains. Per-chain trade approvals stay on each execution chain.
- **Two things will bite you.** (1) On-chain vTPM attestation verification (`flare-vtpm-attestation`) is unverified/experimental — spike it day-1 or fall back to off-chain verification. (2) FDC cannot natively attest Hyperliquid fills except via Web2Json, which is documented as Coston/Coston2-only — so the "verifiable track record" is only cleanly available for swaps on ETH/FLR/SGB. **Cut Sui and XRPL-DEX venues for the hackathon.**

---

## Key Findings

1. **FSA is live and developer-open.** Documented at `dev.flare.network/smart-accounts/*`, public repo `flare-foundation/flare-smart-accounts`, a Python CLI, and TypeScript/viem guides. `MasterAccountController` has the same address on all Flare networks, resolvable from the `FlareContractRegistry` at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`. D'CENT and Xaman are integration *partners*, not gatekeepers — an independent dev can derive a deterministic `PersonalAccount` (CREATE2) for any XRPL address via `getPersonalAccount` and drive it end-to-end.
2. **FSA custom instructions** encode an EIP-4337 `PackedUserOperation`. Memo opcode **`0xFE`** = fixed 42-byte memo `[0xFE | walletId | executorFeeUBA(8B) | userOpHash(32B)]`, with the full userOp delivered off-chain (payload private on XRPL, constant size). Opcode **`0xFF`** carries the full ABI-encoded userOp inline (bounded by XRPL's 1024-byte memo cap). On-chain, only `sender` (must equal the derived PersonalAccount) and `nonce` are validated; authorization is the XRPL Payment signature itself.
3. **FSA's hard limit:** the `PersonalAccount` lives on and acts on Flare. It cannot sign a Hyperliquid `approveAgent`, an EVM CopyVault approval, or a Sui capability grant. The "one XRPL signature to subscribe + approve across all chains" claim is only true for the Flare-side subscription/approval.
4. **Google Confidential Space is GA.** Google Cloud blog (Next '24): *"As of September 2024, Confidential VM with Intel TDX and Intel AMX is generally available on the general purpose C3 machine series"*; AMD SEV-SNP is supported; H100 GPU CC is GA. Google Cloud Attestation issues OIDC (jwks, RS256) and PKI attestation tokens. Workload Identity Pool + IAM conditions on attestation claims gate Cloud KMS key release — the mechanism for attestation-bound key persistence across enclave restarts.
5. **`flare-vtpm-attestation` is UNVERIFIED for production.** Could not confirm contract names, on-chain RS256 verification, audit status, or deployed addresses. Treat as experimental/PoC. The related scaffolding SDK `flare-ai-kit` is explicitly labeled alpha.
6. **FCC is NOT production-ready.** Dev hub warns: *"Flare Confidential Compute is in the final stages of development and is not yet a fully public production system."* STP.13 (deploy FCC to Songbird canary) voting ran July 6–13, 2026. Correctly excluded — run the TEE off-Flare on Confidential Space with an on-chain attestation gate.
7. **Hyperliquid `approveAgent` is trade-only.** HL docs: *"Agent wallets can only sign trading operations, not withdrawals."* `@nktkas/hyperliquid` is an actively maintained TS SDK (`ExchangeClient`, `approveAgent`, vault/subaccount support). Builder codes: HL docs — *"Builder fees charged can be at most 0.1% on perps and 1% on spot ... builder codes do not apply to the buying side of spot trades."* Builder needs ≥100 USDC in perps value, `standard` AA mode, max 10 active approvals. Do not reuse agent-wallet addresses (pruned nonce state → replay risk).
8. **EVM:** keep the built CopyVault pattern. EIP-7702 (activated on Ethereum mainnet at epoch 364032, May 7, 2025 10:05:11 UTC per the Ethereum Foundation blog; live on major L2s) is a viable modern alternative for scoped session-key trade-only delegation but adds complexity. 0x Swap API v2 (Settler + Permit2/AllowanceHolder; 0.15% fee on select pairs) for routing; set allowances on Permit2/AllowanceHolder, never Settler.
9. **FDC** supports EVMTransaction (ETH/FLR/SGB source chains only), Payment (BTC/DOGE/XRP), and Web2Json/JsonApi (docs say "currently only on Coston & Coston2"). Rounds finalize in ~90–180s. Hyperliquid fills are only attestable via Web2Json (not mainnet-ready) — the verifiable track record is thin today.
10. **Flare-native:** SparkDEX is the #1 Flare DEX; FXRP/USDT0 on SparkDEX V4 shows ~$1M/24h volume. Fine as ONE optional venue, not the liquidity core. FIP.16 *"reduces annual token issuance by 40% (from 5B to 3B FLR) and raises the base gas fee 20x"* (CoinMarketCap) — still cheap in absolute USD (FLR traded in a $0.006493–$0.007137 24h range around this date per CoinMarketCap, with an all-time low of $0.006331 on Jul 1, 2026).

---

## Details

### 1. Product spec (actors & flows)
**Actors:** Leader (publishes signals), Follower/Subscriber (pays fee, pre-approves trade-only execution per chain), Platform (Flare contracts + off-chain TEE agent), TEE Agent (sole decryptor + executor), Executor/Relayer (bridges XRPL payments to Flare via FDC).

**Sequence:**
1. **Publish** — Leader encrypts the signal (`swap X/Y at Z% of balance on chain A`) to the enclave's public key (HPKE) and posts `SignalPublished(leader, planId, ciphertextHash, uri)` on Flare (event = canonical timestamp/trigger).
2. **Decrypt-in-TEE** — The attested agent (and only it) decrypts inside the enclave.
3. **Subscription check** — Agent reads `SubscriptionRegistry` on Flare to enumerate active followers and their per-chain trade approvals.
4. **Fan-out execution** — Agent executes the spot swap for all subscribers simultaneously: Hyperliquid via `approveAgent` agent wallets; EVM via per-follower CopyVault `executeSwap`; (Sui/XRPL-DEX out of scope).
5. **Optional FDC receipt** — Executed swaps on ETH/FLR/SGB attested back to Flare via EVMTransaction → `TrackRecord`.

### 2. Architecture (text diagram)
```
        ┌──────────────── FLARE CONTROL PLANE (on-chain) ────────────────┐
        │ LeaderRegistry · SubscriptionRegistry (fee-split) ·            │
        │ AgentAttestationGate (vTPM verify → gate decrypt/execute) ·    │
        │ optional TrackRecord (FDC EVMTransaction receipts) ·           │
        │ FSA MasterAccountController → per-XRPL PersonalAccount         │
        └───────▲───────────────────────────────────▲───────────────────┘
                │ publish/subscribe events           │ attestation proof + pubkey
   XRPL (Xaman) │                          ┌─────────┴───────────┐
   Payment+memo─┘ (FDC XRPPayment proof)   │  OFF-FLARE TEE AGENT │
   → executor → PersonalAccount.subscribe  │ Google Confidential  │
                                           │ Space (TDX/SEV-SNP)  │
                                           │ HPKE decrypt · KMS   │
                                           │ key release via WIP  │
                                           └─────────┬────────────┘
                                                     │ trade-only signing
        ┌──────────── EXECUTION CHAINS ──────────────┴──────────────┐
        │ Hyperliquid spot (approveAgent) · EVM CopyVault · Flare DEX │
        └────────────────────────────────────────────────────────────┘
```

### 3. Component availability table

| Component | Verdict | Notes / alternative |
|---|---|---|
| FSA (build as third-party dev) | ✅ AVAILABLE | Docs + repo + CLI + guides; MasterAccountController via ContractRegistry |
| FSA one-signature cross-chain trade approval | ❌ NOT AVAILABLE | PersonalAccount is Flare-side only; per-chain approvals separate |
| Google Confidential Space (TDX/SEV-SNP) | ✅ AVAILABLE | GA C3/Intel TDX since Sept 2024; C4 preview |
| Attestation-bound KMS key release | ✅ AVAILABLE | WIP + IAM conditions on attestation claims |
| On-chain vTPM verify (`flare-vtpm-attestation`) | ⚠️ NEEDS DAY-1 VERIFICATION | Unverified/experimental → fallback: off-chain verify + gate on agent pubkey |
| `flare-ai-kit` Confidential Space scaffolding | ⚠️ ALPHA | Explicitly alpha; usable for reference, not production |
| FCC (Flare Confidential Compute) | ❌ NOT AVAILABLE | Dev-hub warning; STP.13 canary vote July 6–13, 2026 |
| HPKE encrypt-to-enclave (`hpke-js` / `@noble`) | ✅ AVAILABLE | RFC 9180 pure-TS libs |
| Hyperliquid `approveAgent` trade-only | ✅ AVAILABLE | "cannot sign withdrawals" confirmed |
| `@nktkas/hyperliquid` SDK | ✅ AVAILABLE | Actively maintained |
| FXRP/USDC + FXRP/USDH spot | ✅ AVAILABLE | Live Jan 7 & ~Jan 28, 2026 |
| HL builder codes on spot | ✅ AVAILABLE | Max 1% spot, sell-side only |
| EVM CopyVault (existing) | ✅ AVAILABLE | Reuse as-is |
| EIP-7702 scoped delegation | ✅ (ETH/L2) / ⚠️ (Flare) | Live ETH+L2s; Flare support unconfirmed |
| Permit2 scoped approvals | ✅ AVAILABLE | `0x0000...78BA3` |
| 0x Swap API v2 | ✅ AVAILABLE | 0.15% on select pairs |
| Sui vault-object trade-only | ⚠️/CUT | Feasible (Move + capability + sponsored tx) but multi-day → v2 |
| XRPL DEX agent execution | ❌ EXCLUDE | Requires custody of XRPL key |
| ERC-4337 EntryPoint/bundler on Flare | ⚠️ UNVERIFIED | No live infra confirmed |
| FDC EVMTransaction (ETH/FLR/SGB) | ✅ AVAILABLE | Arbitrum/Base/HyperEVM NOT supported sources |
| FDC Web2Json (HL fills) | ⚠️ Coston/Coston2 only | Mainnet status unverified |
| USDT0 / FXRP subscription token | ✅ AVAILABLE | USDT0 most liquid; FXRP native |
| SparkDEX FXRP swap venue | ✅ AVAILABLE | ~$1M/24h FXRP/USDT0; one optional venue |
| FTSOv2 feeds (XRP/ETH/BTC/FLR/SUI) | ✅ / ⚠️ verify IDs | Use for min-out bounds |

### 4. FSA deep verdict + day-1 spike + fallback
**GO, scoped.** FSA is open to third-party developers today (dev hub, repo, CLI, viem guides). The proof-based flow uses a bytes32 payment reference (byte0 instruction code, byte1 wallet id, 30 bytes params); arbitrary calls use memo opcode `0xFE` (private, off-chain payload) or `0xFF` (inline, ≤1024B). The executor is a role a **third party can run**; a PersonalAccount can pin a specific executor (opcode `0xD0`). End-to-end latency is dominated by FDC round finalization (~90–180s); in the `0xFE` flow the userOp executes inside the executor's `executeDirectMintingWithData` tx, so no extra cross-chain wait after the proof.

**What it covers realistically:** XRP holder in Xaman sends one XRPL Payment → FDC attests → FXRP minted to their PersonalAccount → PersonalAccount calls `SubscriptionRegistry.subscribe()` (paying in FXRP, or swapping FXRP→USDT0 on SparkDEX inside the same userOp). Per-chain trade approval (HL `approveAgent`, EVM CopyVault) is a **separate** action on that chain.

**Day-1 spike test (Coston2):** (1) fetch MasterAccountController from ContractRegistry; (2) compute PersonalAccount via `getPersonalAccount` for a test XRPL testnet address; (3) build a `PackedUserOperation` whose `Call` is `SubscriptionRegistry.subscribe(planId)`; (4) send the XRPL testnet Payment with the `0xFE` memo to the FXRP direct-minting address; (5) run your own executor to fetch the FDC XRPPayment proof and call `executeDirectMintingWithData`; (6) assert `UserOperationExecuted` + subscription recorded. **Continue with FSA only if this round-trips in <1 day.**

**Fallbacks:** (a) WalletConnect/Reown EVM onboarding (already in codebase) — primary fallback; (b) ERC-4337 on Flare — no live EntryPoint/bundler confirmed, do not assume; (c) EIP-7702 on Flare — unconfirmed; (d) Flare Discord/Telegram/grants (`flare.network/grants`, Summer Signal channels) for access help.

### 5. Signal-encryption design (final)
**Pattern: encrypt-to-enclave with HPKE (RFC 9180).** Publish the enclave's X25519 public key on Flare, bound to attestation — the key is only trusted if `AgentAttestationGate` holds a valid attestation for the image that generated it. Leader encrypts to that pubkey. **Libraries:** `hpke-js` (TS, RFC 9180) or `@noble/curves` + `@noble/ciphers` for hand-rolled ECIES. **Storage:** off-chain (or public bus) + on-chain keccak256 commitment via `SignalPublished` event — cleaner than on-chain calldata (though ~200-byte ciphertext on-chain is affordable at current Flare gas). **Threshold encryption (Lit/Shutter/drand-tlock): NOT needed** — a single attested agent is the sole decryptor, so threshold committees add liveness complexity for zero benefit. **Key lifecycle:** enclave generates X25519 keypair at boot; private half wrapped by Cloud KMS and re-released on restart only to a workload whose attestation matches the pinned image digest; public half published + attestation-bound on Flare. Alternative: fresh keypair republished with a new attestation on each restart.

### 6. TEE deployment design
1. Build a reproducible Docker image (record its digest); deploy on a Confidential VM (`c3-standard-4`, Intel TDX) in a TDX-supported region.
2. At boot, request an attestation token from Google Cloud Attestation (OIDC form, RS256, verifiable via `jwks_uri`).
3. Configure a Workload Identity Pool with IAM conditions on attestation claims (image digest) → releases the Cloud KMS key that unwraps the enclave's HPKE private key.
4. **Attestation → Flare:** ideal path is `flare-vtpm-attestation` verifying the Google token on-chain and recording "agent attested" in `AgentAttestationGate`. **Because that repo is unverified, ship the fallback:** a trusted relayer verifies the token off-chain and submits (with the operator key) the agent's ephemeral signing pubkey to `AgentAttestationGate`; contracts gate decryption-key publication and execution authority on that recorded pubkey.
5. Cost: one always-on CVM (base instance + CVM premium) — a modest monthly figure; confirm exact rate in the GCP pricing calculator during the spike.
6. **Fallback platform:** if GCP onboarding stalls >2 days, switch to Phala `dstack` (Intel TDX + on-chain KMS + published attestation), which has a Web3-native attestation story.

### 7. Per-venue execution design
- **Hyperliquid (PRIMARY):** per-follower agent wallet via `approveAgent` → trade-only, cannot withdraw. Use `@nktkas/hyperliquid` `ExchangeClient.order` (spot asset index = `10000 + spotIndex`). Platform fee via builder code on the **sell side** (buy side excluded) capped at 1%, or via SubscriptionRegistry. **Fan-out:** each follower's agent wallet carries its own nonce → parallel submission is safe; respect HL API rate limits; **never reuse agent-wallet addresses**. HyperEVM is not used for orderbook spot (that's HyperCore).
- **EVM (Arbitrum/Base/etc.):** reuse CopyVault.sol (per-follower non-custodial vault, `executeSwap`-only role, token/router whitelist, min-out). Route via 0x Swap API v2 or Uniswap universal router. Per-vault nonce is sequential; parallelize across vaults. EIP-7702 session keys are a post-hackathon upgrade.
- **Flare DEX (ONE optional venue):** SparkDEX/Enosys for an FXRP demo swap with FTSO min-out bounds.
- **Sui (CUT → v2):** per-follower vault object + capability-based executor role (Move) + sponsored transactions + `Sui_Owned_Object_Pools` for parallel execution. Feasible but out of the 4-week budget.
- **XRPL DEX (EXCLUDE):** agent-executed swaps require the user's XRPL signing key = custody. Contradicts non-custodial.

### 8. Flare contracts to write (rough interfaces)
```solidity
interface ILeaderRegistry {
  function registerLeader(bytes32 profileHash) external;
  function publishSignal(uint256 planId, bytes32 ciphertextHash, string calldata uri) external; // emits SignalPublished
}
interface ISubscriptionRegistry { // ported from Sigmax
  function createPlan(uint256 fee, address token, uint16 leaderBps, uint16 platformBps) external returns (uint256 planId);
  function subscribe(uint256 planId) external;          // callable by PersonalAccount (FSA) or EOA
  function isActive(address follower, uint256 planId) external view returns (bool);
}
interface IAgentAttestationGate {
  function recordAttestation(bytes calldata token, address agentSigningKey) external; // on-chain vTPM verify OR off-chain-verified relayer path
  function isAttested(address agentSigningKey) external view returns (bool);
  function enclavePubKey() external view returns (bytes memory); // gated on attestation
}
interface ITrackRecord { // optional, FDC receipts
  function submitReceipt(bytes calldata evmTxProof) external; // EVMTransaction on ETH/FLR/SGB only
}
```

### 9. Reuse map
- **Port as-is:** SubscriptionRegistry.sol (plan/subscribe/fee-split); CopyVault.sol (per-follower vault, executeSwap-only, whitelist, min-out); TS TEE-ready agent + per-follower pipeline; Hyperliquid execution via `@nktkas/hyperliquid` + `approveAgent`; Vite+React app; WalletConnect onboarding.
- **Newly built:** LeaderRegistry + `publishSignal` event; AgentAttestationGate (vTPM verify or off-chain-verified gate); HPKE encrypt-to-enclave layer + enclave key lifecycle; Confidential Space deployment + KMS key-release; FSA subscription flow (executor + PersonalAccount + `0xFE` memo); optional TrackRecord/FDC verifier.

### 10. Risk table

| # | Risk | Mitigation | Severity |
|---|---|---|---|
| 1 | On-chain vTPM verify (`flare-vtpm-attestation`) unverified/experimental | Day-1 spike; fallback to off-chain verify + gate on agent pubkey | High |
| 2 | FDC can't attest HL fills on mainnet (Web2Json Coston-only) | Make FDC track record optional; use ETH/FLR/SGB EVMTransaction only | High |
| 3 | FSA executor/FDC plumbing overruns timebox | WalletConnect subscription fallback; FSA as stretch demo | Med-High |
| 4 | Agent-wallet nonce pruning → replay | Never reuse agent addresses; rotate per subscription | Medium |
| 5 | GCP Confidential Space onboarding delay | Switch to Phala dstack (Intel TDX + on-chain KMS) | Medium |
| 6 | Thin FXRP spot liquidity → slippage | Enforce FTSO-bounded min-out; size caps; support USDC/USDH pairs | Medium |
| 7 | Regulatory (copy-trading as advice/management) | Non-custodial, user-pre-approved, subscription (not performance) fees; disclaimers | Medium |
| 8 | Scope creep (Sui/XRPL/multi-EVM) | Hard-cut to HL + one Flare DEX + one EVM chain | Medium |
| 9 | Signal leak before decryption | HPKE to enclave; only 32-byte commitment on-chain; single attested decryptor | Low-Med |
| 10 | FIP.16 20x gas raise / FLR volatility | Still sub-cent per tx; confirm live gas during build | Low |

### 11. Four-week build plan (verified components only)
- **Week 1, Day 1–2 — spikes gate everything:** (a) FSA subscription round-trip on Coston2 (§4 test) — *continue with FSA only if <1 day*; (b) Confidential Space skeleton: deploy container, obtain attestation token, verify off-chain, release a KMS key. *Continue with on-chain attestation only if `flare-vtpm-attestation` verifies a real Google token on Coston2 within 2 days; else off-chain fallback.*
- **Week 1–2:** Port SubscriptionRegistry + CopyVault to Coston2; write LeaderRegistry + AgentAttestationGate; wire HPKE encrypt-to-enclave with attestation-bound pubkey; Hyperliquid `approveAgent` fan-out on testnet via `@nktkas/hyperliquid`.
- **Week 3 (mainnet target):** Deploy contracts to Flare mainnet; live Hyperliquid spot on FXRP/USDC; FSA subscription in FXRP/USDT0; full publish→decrypt→check→fan-out for N test followers.
- **Week 4:** Optional FDC receipt for one ETH/FLR/SGB swap (verifiable track-record demo); polish Vite/React app; record demo; submit by Aug 14.
- **Scope cuts (now):** Sui, XRPL-DEX, multi-EVM execution → v2. Ship Hyperliquid spot + one Flare DEX swap + one EVM CopyVault chain. On-chain vTPM verify and FDC receipts are "stretch."
- **Thresholds that change the plan:** GCP stall >2 days → Phala dstack; FSA executor stall → WalletConnect; `flare-vtpm-attestation` fails spike → off-chain attestation gate.

### 12. Landscape & regulatory
- **Competitive positioning:** HL copy-trading/vault-copy bots (HyperAgent, Gainium, PVP.trade, goodcryptoX) all use trade-only agent wallets but none encrypt the signal; Phala's Turbine proves TEE order-privacy is real. No product found combining **encrypted-to-enclave signals + cross-chain spot fan-out + XRPL-native onboarding** — that triple is the differentiation: the leader's edge is cryptographically protected (not just ToS), and XRP holders onboard with one XRPL signature (the "why not Base" moat).
- **Signal-leak validation:** paid signal groups leaking/reselling on Telegram is a documented fraud vector. Named scale figures: the FBI IC3 reported crypto-related fraud losses exceeding **$5.6 billion in 2023**; security researchers report Telegram malware-based attacks *"surged by an alarming 2,000% between late 2024 and early 2025"* (Zipmex, 2026). Concrete case: California DFPI's Crypto Scam Tracker documents the **"SB Signal Sniper"** Telegram group where a victim lost at least $6,000 following paid trade signals. The leak/resale problem is real and monetizable to solve.
- **Regulatory (brief, not legal advice):** copy-trading can be characterized as investment advice/portfolio management under EU MiCA/MiFID II and by the SEC/CFTC in the US. Non-custodial architecture + user-pre-approved execution + subscription (not performance) fees **reduces but does not eliminate** the "discretionary asset management" risk. Recommendation: no performance fees; position the leader as a *signal publisher*, not a manager; add clear disclaimers.

---

## Caveats (unverified / flagged)
- **`flare-vtpm-attestation`:** contract names, on-chain RS256 verification, audit status, and deployed addresses **UNVERIFIED** (repo could not be fetched). Assume experimental; plan the off-chain fallback.
- **Web2Json/JsonApi on mainnet:** docs indicate Coston/Coston2 only; mainnet availability **UNVERIFIED**. Hyperliquid-fill attestation therefore not reliably available on mainnet today.
- **FDC EVMTransaction source chains:** confirmed **ETH/FLR/SGB only**. Arbitrum/Base/HyperEVM NOT supported → those venues' swaps not attestable via EVMTransaction today.
- **ERC-4337 EntryPoint/bundler on Flare** and **EIP-7702 on Flare:** no live infrastructure confirmed — do not assume.
- **STP.13 outcome:** voting ran July 6–13, 2026; a definitive "passed and deployed to Songbird" confirmation was not found. FCC remains pre-production regardless.
- **Confidential Space exact pricing:** not quoted; verify in the GCP calculator.
- **FTSO SUI/FXRP feed IDs:** existence assumed from the FTSOv2 feed set; verify exact IDs on the dev hub.
- **Flare gas post-FIP.16:** base fee raised 20x; still sub-cent in USD but confirm live gas during build.

---

## Link pack
**FSA:** dev.flare.network/smart-accounts/overview · /custom-instruction · /reference · /guides · github.com/flare-foundation/flare-smart-accounts · flare.network/products/flare-smart-accounts · store.dcentwallet.com/blogs/post/flare-smart-accounts-guide
**FDC:** dev.flare.network/fdc/overview · /getting-started · github.com/flare-foundation/evm-verifier · flare.network/news/fip14-and-stp10-introduce-support-for-new-fdc-web2-attestations
**FCC / AI:** dev.flare.network/fcc/overview (whitepaper linked) · github.com/flare-foundation/flare-ai-kit · github.com/flare-foundation/flare-ai-skills
**TEE:** docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview · docs.cloud.google.com/confidential-computing/docs/attestation · docs.trustauthority.intel.com/main/articles/articles/ita/integrate-gcp-cs.html · cloud.google.com/blog/products/identity-security/expanding-confidential-computing-for-ai-workloads-next24 · phala.com/confidential-vm
**Hyperliquid:** hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint · nktkas.gitbook.io/hyperliquid/guides/agent-wallets-and-vaults · hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes · coindesk.com/markets/2026/01/07 (FXRP/USDC) · flare.network/news/building-the-xrp-standard-on-hyperliquid-fxrpusdh-spot-market-now-live · github.com/nktkas/hyperliquid
**EVM:** docs.0x.org · 0x.org/pricing · ethereum.org/roadmap/pectra/7702 · blog.ethereum.org (Pectra activation) · Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
**Sui:** docs.sui.io/guides/developer/sui-101/sign-and-send-txn · docs.sui.io/concepts/transactions/sponsored-transactions · github.com/MystenLabs/Sui_Owned_Object_Pools
**Flare infra:** ContractRegistry `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` · flare-hardhat-starter / flare-foundry-starter · faucet.flare.network · flare-explorer.flare.network · coingecko.com/en/coins/flare-bridged-xrp-flare · coinmarketcap.com/currencies/flare
**Risk/landscape:** phala.com/posts/turbine-trading-infra-on-phala-cloud · DFPI Crypto Scam Tracker (SB Signal Sniper) · FBI IC3 2023 crypto fraud report