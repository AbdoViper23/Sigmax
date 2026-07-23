# Sigmax on Flare — Phase 0 (Spikes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the three unknowns that gate the whole architecture — (0a) does a Flare Compute Extension round-trip on Coston2 **in TypeScript**, and can a TEE `ActionResult` signature be verified on-chain; (0b) can we execute an FXRP↔USDT0 swap on a Coston2 DEX bounded by an FTSO price — before writing any production contract or extension code.

**Architecture:** Two independent spikes against Coston2 (chain 114). 0a is built on **`fce-sign`** (which already demonstrates ECIES-decrypt + enclave key-holding + signing — our exact core) run with `LANGUAGE=typescript` in simulated-TEE mode; it proves a `SIGNAL/EXECUTE` instruction round-trips and a TEE `ActionResult` signature recovers on-chain to the registered `teeAddress`, and it *locks the fan-out authorization format* the vault will later verify. 0b proves the Flare-native execution leg (faucet tokens → FTSO read → swap through a Coston2 router). Each spike has a hard gate; failing 0a triggers the GCP Confidential Space fallback.

**Tech Stack:** Coston2 EVM (chain 114), Foundry (Solidity 0.8.24), FCC `fce-sign` (TypeScript path) + Docker + ngrok, viem + `@flarenetwork/flare-wagmi-periphery-package` (FTSO/registry), later `@nktkas/hyperliquid`.

## Global Constraints

*(Every task implicitly includes these — copied from the design spec.)*
- **Swap-only:** the only trading action is a swap between two whitelisted tokens; never add a `side`/`leverage`/`margin` field or any perp/borrow path.
- **Non-custodial:** the agent/TEE executes but can never withdraw or transfer funds out; only a vault owner withdraws.
- **Confidential:** plaintext strategy/TP/SL is decrypted only inside the enclave; never logged, persisted, or sent to any server/frontend. Encryption is client-side.
- **No religious framing:** never write halal/haram/riba/religious language in any file; frame swap-only neutrally.
- **Tooling:** viem (not ethers) for TS EVM I/O; Solidity 0.8.24 + Foundry with `evmVersion: "cancun"`; TS everywhere off-chain; ESM; resolve Flare contracts via `ContractRegistry` (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`) — never hardcode.
- **Secrets:** the shared Coston2 indexer credentials (`username hackathon_user_57`, password from the hackathon group) go ONLY in the git-ignored proxy toml — never in a committed file. No private keys in committed files.
- **Commits:** single-line messages, no Co-Authored-By / no tool attribution, local only (no push) unless the user asks.
- **Gates are condition-based, not date-based.** External deadline (tracked separately): 2026-08-14.

## Coston2 constants (verified)
- RPC: `https://coston2-api.flare.network/ext/C/rpc` · Chain ID: `114` · Explorer: `https://coston2-explorer.flare.network`
- Faucet (C2FLR + FXRP + USDT0): `https://faucet.flare.network/coston2`
- `ContractRegistry`: `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same on all Flare networks)
- FTSO XRP/USD feed id: `0x015852502f55534400000000000000000000000000`
- FCC Coston2 FTDC proxy: `NORMAL_PROXY_URL=https://tee-proxy-coston2-1.flare.rocks`
- FCC indexer DB: host `34.38.42.208`, port `3306`, database `indexer`
- BlazeSwap (Coston2, UniswapV2-compatible) router: `0x8D29b61C41CF318d15d031BE2928F79630e068e6` · WC2FLR: `0xC67DCE33D7A8efA5FfEB961899C73fe01bCe9273` *(verify on the explorer during 0b)*

---

## File Structure (created by this plan)

- `packages/fce-sigmax/` — clone of `fce-sign` (the FCC extension + its InstructionSender contract + docker stack). Spike lives here; Phase 2 hardens it. `LANGUAGE=typescript`; business logic in `typescript/src/app/` (never edit `typescript/src/base/`).
  - `.env`, `.env.local.coston2`, `config/extension.env`, `config/proxy/extension_proxy.coston2*.toml` — **git-ignored** (hold keys + indexer creds).
  - `typescript/src/app/` — add the `SIGNAL/EXECUTE` handler; adapt the existing `sign` op to sign a `SwapAuth[]` result.
  - `contracts/InstructionSender.sol` — add `OP_TYPE_SIGNAL`/`OP_COMMAND_EXECUTE` constants + a `sendExecute` function.
- `packages/contracts/src/TeeSigVerifier.sol` + `test/TeeSigVerifier.t.sol` — spike verifier proving on-chain `ecrecover` of a TEE `ActionResult` signature (the exact recovery CopyVault will reuse).
- `packages/contracts/script/spike/` — spike scripts (token resolve, FTSO read, swap).
- `docs/flare/reference/phase-0-findings.md` — **the deliverable**: what round-tripped, the locked `SwapAuth[]` format, `teeAddress` provenance, the DEX decision, the Go-vs-TS decision, gate outcomes.

---

## Task 0.0: Prerequisites & environment

**Files:** none (environment only).

- [ ] **Step 1: Create a dedicated Coston2 dev account** (throwaway, not a personal wallet). Record the address; keep the key local.
- [ ] **Step 2: Fund it** at `https://faucet.flare.network/coston2` — request C2FLR + FXRP + USDT0.
- [ ] **Step 3: Verify balance.** Run: `cast balance <ADDR> --rpc-url https://coston2-api.flare.network/ext/C/rpc` → expect non-zero.
- [ ] **Step 4: Confirm toolchain.** Run: `forge --version && docker --version && node --version && go version && ngrok --version` → all print versions (install any missing).
- [ ] **Step 5: Confirm indexer creds are on hand** (`hackathon_user_57` + group password) — do NOT paste them into any committed file.

---

## Task 0a.1: Clone `fce-sign`, add the `SIGNAL/EXECUTE` op, and configure Coston2 (TypeScript)

*Rationale for the ordering: the on-chain `InstructionSender` is deployed once by `pre-build.sh` and the registry only accepts that exact address, so our custom op MUST be in the contract before the first deploy — otherwise it can't be added without `pre-build.sh --force`, which mints a new extension id and triggers the `MachineManager.TooMany()` trap.*

**Files:**
- Create: `packages/fce-sigmax/` (clone), `.env.local.coston2`, `config/proxy/extension_proxy.coston2.docker.toml`
- Modify: `packages/fce-sigmax/contracts/InstructionSender.sol`, `packages/fce-sigmax/typescript/src/app/` (register a handler), repo root `.gitignore`

- [ ] **Step 1: Clone.** Run: `git clone https://github.com/flare-foundation/fce-sign.git packages/fce-sigmax`
- [ ] **Step 2: Select TypeScript + Coston2 simulated mode.** Run (from `packages/fce-sigmax`): `./scripts/use-chain.sh local coston2 typescript` (sets `SIMULATED_TEE=true`, `LOCAL_MODE=false`).
- [ ] **Step 3: Gitignore secrets.** Add to root `.gitignore`:

```
packages/fce-sigmax/.env
packages/fce-sigmax/.env.local.coston2
packages/fce-sigmax/config/extension.env
packages/fce-sigmax/config/proxy/extension_proxy.coston2*.toml
```

- [ ] **Step 4: Add our op to the contract.** In `contracts/InstructionSender.sol` add constants `bytes32 OP_TYPE_SIGNAL = bytes32("SIGNAL")`, `bytes32 OP_COMMAND_EXECUTE = bytes32("EXECUTE")` and a `sendExecute(bytes calldata _ciphertext) external payable` copying the existing `sign` send shape (route to `sendInstructions` with those ops).
- [ ] **Step 5: Register the handler (TS).** In `typescript/src/app/`, register `framework.handle(OP_TYPE_SIGNAL, OP_COMMAND_EXECUTE, handleExecute)` where `handleExecute` returns `df.originalMessage` verbatim with `status=1` (echo — proves routing). Keep the existing `KEY/UPDATE` + `KEY/SIGN` ops intact (baseline).
- [ ] **Step 6: Fill `.env.local.coston2`:** `DEPLOYMENT_PRIVATE_KEY`, `INITIAL_OWNER=0x<addr>`, `PROXY_PRIVATE_KEY`. Re-run `./scripts/use-chain.sh local coston2 typescript` so `.env` picks up the edits.
- [ ] **Step 7: Start ngrok** (separate terminal): `ngrok http 6674`; copy the HTTPS URL into `EXT_PROXY_URL` in `.env.local.coston2`; re-run `use-chain.sh`.
- [ ] **Step 8: Indexer toml.** `cp config/proxy/extension_proxy.coston2.docker.toml.example config/proxy/extension_proxy.coston2.docker.toml`; fill `[db]` = host `34.38.42.208`, port `3306`, database `indexer`, `username="hackathon_user_57"`, `password="<group password>"`. (No commit — secrets.)

---

## Task 0a.2: Deploy the InstructionSender (with our op) + start services

**Files:** writes `config/extension.env` (git-ignored).

- [ ] **Step 1: Deploy + register.** Run: `./scripts/pre-build.sh` → writes `EXTENSION_ID` + `INSTRUCTION_SENDER` to `config/extension.env`. (Do NOT re-run with `--force` later.)
- [ ] **Step 2: Start the stack.** Run: `./scripts/start-services.sh` then `until curl -sf http://localhost:6674/info >/dev/null 2>&1; do sleep 2; done; echo ready`
- [ ] **Step 3: Verify.** Run: `source .env && curl -s "$EXT_PROXY_URL/info" | jq '.machineData'` → `codeHash` = simulated `0x194844cf…`, `extensionId` matches `config/extension.env`, `initialOwner` matches your address. Record `teeAddress` from `/info` for Task 0a.5.
- [ ] **Step 4: Register the TEE machine.** Run: `./scripts/post-build.sh` (uses `register-tee -command rRap`). *If it reverts `InvalidGovernanceHash`, the `GOVERNANCE_SIGNERS`/`GOVERNANCE_THRESHOLD` in `.env` must match what the extension container received — rebuild/restart after changing them (deployer default is fine).* *If `Verification.ChallengeExpired`, re-run `post-build.sh`.*

---

## Task 0a.3: Baseline — `fce-sign` KEY ops round-trip (isolates "scaffold broken" from "our changes broken")

- [ ] **Step 1: Run the stock test.** Run: `./scripts/test.sh` → fetches the TEE pubkey, ECIES-encrypts a test key, `updateKey` on-chain, `sign` on-chain, verifies the ECDSA signature — **PASS**.
- [ ] **Step 2: Record baseline** in `docs/flare/reference/phase-0-findings.md` ("fce-sign TS round-trips on Coston2, extensionId=…, teeAddress=…"). Commit.

```bash
git add docs/flare/reference/phase-0-findings.md
git commit -m "Phase 0a: fce-sign TypeScript round-trips on Coston2"
```

---

## Task 0a.4: Prove our `SIGNAL/EXECUTE` op round-trips

- [ ] **Step 1: Send a test instruction.** Adapt `tools/`/`test.sh` to call `sendExecute(0xdeadbeef)` and poll the proxy for the `ActionResult`.
Expected: the result data == `0xdeadbeef` (echo), proving our op is deployed and routed.
- [ ] **Step 2: Record + commit.**

```bash
git add packages/fce-sigmax docs/flare/reference/phase-0-findings.md
git commit -m "Phase 0a: SIGNAL/EXECUTE op round-trips on Coston2"
```

---

## Task 0a.5: Lock the fan-out `SwapAuth[]` format + verify a real TEE signature on-chain

**Files:** Create `packages/contracts/src/TeeSigVerifier.sol`, `packages/contracts/test/TeeSigVerifier.t.sol`; modify `docs/flare/reference/phase-0-findings.md`.

**Interfaces:**
- Produces: `TeeSigVerifier.recoverActionSigner(bytes resultData, bytes32 actionId, string submissionTag, uint8 status, bytes signature) → address` — the exact recovery CopyVault reuses in Phase 1.

- [ ] **Step 1: Write the failing test** `packages/contracts/test/TeeSigVerifier.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "forge-std/Test.sol";
import {TeeSigVerifier} from "../src/TeeSigVerifier.sol";

contract TeeSigVerifierTest is Test {
    TeeSigVerifier v;
    function setUp() public { v = new TeeSigVerifier(); }

    function test_recoversKnownSigner() public {
        uint256 pk = 0xA11CE;
        address expected = vm.addr(pk);
        bytes memory resultData = hex"deadbeef";
        bytes32 actionId = keccak256("action-1");
        string memory tag = "sigmax";
        uint8 status = 1;
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(tag)), status));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", resultHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        assertEq(v.recoverActionSigner(resultData, actionId, tag, status, abi.encodePacked(r, s, vv)), expected);
    }
}
```

- [ ] **Step 2: Run → confirm it fails.** Run: `forge test --match-contract TeeSigVerifierTest -vvv` → FAIL (not found).
- [ ] **Step 3: Implement `TeeSigVerifier.sol`** (mirrors `fce-weather-insurance`'s `settle()` recovery):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract TeeSigVerifier {
    function recoverActionSigner(
        bytes calldata resultData, bytes32 actionId, string calldata submissionTag,
        uint8 status, bytes calldata signature
    ) external pure returns (address) {
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(submissionTag)), status));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", resultHash));
        require(signature.length == 65, "bad sig");
        bytes32 r = bytes32(signature[0:32]); bytes32 s = bytes32(signature[32:64]); uint8 vv = uint8(signature[64]);
        return ecrecover(ethSigned, vv, r, s);
    }
}
```

- [ ] **Step 4: Run → confirm it passes.** Run: `forge test --match-contract TeeSigVerifierTest -vvv` → PASS.
- [ ] **Step 5: Prove it against a REAL TEE signature.** Adapt the extension's `SIGNAL/EXECUTE` handler to return `resultData = abi.encode(SwapAuth[])` (below) for a test input; trigger it; capture the node's real `ActionResult` (`resultData`, `actionId`, `submissionTag`, `status`, `signature`) from the proxy; write a second test asserting `recoverActionSigner(...) == teeAddress` (from 0a.2 Step 3). This catches any packing/width subtleties (esp. the `status` type).
- [ ] **Step 6: Lock the fan-out format + `teeAddress` provenance** in `phase-0-findings.md`:
  - **Fan-out = one signed result covering all followers.** The handler returns `resultData = abi.encode(SwapAuth[] auths)`; one `signalId` → one instruction → one signature. Phase-1 call shape: `executeSwapWithTeeSig(SwapAuth[] auths, uint256 index, bytes32 actionId, string submissionTag, uint8 status, bytes sig)` — the vault recomputes the `ActionResult` hash over `abi.encode(auths)`, requires `recoverActionSigner(...) == teeAddress`, then acts on `auths[index]` after checking `auths[index].vault == address(this)`, `chainId == block.chainid`, `block.timestamp <= deadline`, and `keccak256(abi.encode(actionId, index))` not already consumed. **Also require `status == 1`.**

    ```
    struct SwapAuth { address vault; address tokenIn; address tokenOut; uint256 amountIn;
                      uint256 minOut; address router; bytes swapData; bytes32 signalId; uint256 deadline; uint256 chainId; }
    ```
  - **`teeAddress` provenance:** record where CopyVault reads it (TeeMachineRegistry lookup vs. a constructor-pinned/owner-set address) and whether it survives `post-build.sh` re-runs. It WILL change between the simulated machine and the Phase-3.5 real attested VM → **CopyVault needs an owner-gated `setTeeAddress`** (note this for Phase 1).
- [ ] **Step 7: Commit.**

```bash
git add packages/contracts/src/TeeSigVerifier.sol packages/contracts/test/TeeSigVerifier.t.sol packages/fce-sigmax docs/flare/reference/phase-0-findings.md
git commit -m "Phase 0a: verify TEE ActionResult signature on-chain; lock SwapAuth[] fan-out format"
```

### GATE 0a
**Continue only if:** `fce-sign` (TS) baseline + our `SIGNAL/EXECUTE` op both round-trip on Coston2, AND a real TEE `ActionResult` signature (with `status==1`, `resultData = abi.encode(SwapAuth[])`) recovers on-chain to the registered `teeAddress`, AND the fan-out format + `teeAddress` provenance are recorded.
**If not** (after focused effort): switch the confidential core to the **GCP Confidential Space + on-chain attestation-gate** fallback (blueprint §6) before Phase 2. Also decide **Go vs TS** here: if the TS path is too rough, fall back to the Go `fce-sign` variant and note that Phase 2 ports Zod-validation/sizing to Go (losing TS reuse). Record the decision.

---

## Task 0b.1: Acquire + resolve Coston2 tokens

**Files:** `packages/contracts/script/spike/tokens.ts` (viem + `@flarenetwork/flare-wagmi-periphery-package`).

- [ ] **Step 1: Resolve FXRP.** `ContractRegistry.getContractAddressByName("AssetManagerFXRP")` → `IAssetManager` → `fAsset()`. Print.
- [ ] **Step 2: Resolve/confirm USDT0** on Coston2 (faucet output / explorer). Print.
- [ ] **Step 3: Confirm `balanceOf` of FXRP + USDT0** for your address is non-zero (from the faucet). If zero, revisit the faucet.
- [ ] **Step 4: Record** both addresses in `phase-0-findings.md`. Commit.

---

## Task 0b.2: Read FTSO XRP/USD and compute a minOut

**Files:** `packages/contracts/script/spike/ftso.ts`.

- [ ] **Step 1: Write the script.** Resolve `FtsoV2` via `ContractRegistry` (on Coston2 use `TestFtsoV2Interface`); `getFeedById(0x015852502f55534400000000000000000000000000)`; print `(value, decimals, timestamp)` and `value/10**decimals`.
- [ ] **Step 2: Run.** Run: `pnpm --filter @sigmax/contracts exec tsx script/spike/ftso.ts` → prints a plausible XRP/USD (~2.x) + recent timestamp.
- [ ] **Step 3: Add + test a `minOut(amountIn, xrpUsd, slippageBps)` pure helper** (known input → expected output). Commit.

---

## Task 0b.3: Execute an FXRP↔USDT0 swap on a Coston2 DEX

*Decision tree (pre-authorized): **SparkDEX** (if it has a Coston2 deployment) → **BlazeSwap** (create/seed an FXRP/USDT0 pair on its existing factory) → **self-deployed Uniswap-V2 pair** (last resort).*

**Files:** `packages/contracts/script/spike/swap.ts`; (fallback only) a pair-creation/seed script.

- [ ] **Step 1: Find a router with a *funded FXRP/USDT0 pool*** (not merely a router). Check SparkDEX Coston2 deployment; else BlazeSwap factory (router `0x8D29b61C41CF318d15d031BE2928F79630e068e6`) — query `getPair(FXRP, USDT0)` and its reserves. Record which one has liquidity.
- [ ] **Step 2a (funded pool exists):** `approve` the router; swap a small FXRP amount → USDT0 with `minOut` from 0b.2. Expect USDT0 balance up by ≥ `minOut`.
- [ ] **Step 2b (no funded pool):** create an FXRP/USDT0 pair on the BlazeSwap factory, `addLiquidity` with faucet FXRP + USDT0 (2–3 txs), then swap through it with `minOut`. (Self-deploy your own factory+pair only if BlazeSwap is unusable.)
- [ ] **Step 3: Record the DEX decision** (router address + pool) in `phase-0-findings.md` — this is what CopyVault whitelists in Phase 1.
- [ ] **Step 4: Commit.**

```bash
git add packages/contracts/script/spike docs/flare/reference/phase-0-findings.md
git commit -m "Phase 0b: FTSO-bounded FXRP/USDT0 swap on Coston2"
```

### GATE 0b
**Continue only if:** an FXRP↔USDT0 swap executes on Coston2 with an FTSO-derived `minOut`, through a router whose address is recorded (SparkDEX, BlazeSwap, or self-pool — any satisfies the gate).

---

## Phase 0 deliverable

`docs/flare/reference/phase-0-findings.md` must end with: the FCC round-trip result (+ extensionId/sender), the locked `SwapAuth[]` fan-out format + `status==1` rule, the real-TEE-sig verification result, the `teeAddress` provenance + setter decision, the Go-vs-TS decision, Coston2 FXRP/USDT0 addresses, the FTSO read, and the DEX decision (router + pool). These feed the Phase 1 plan.

---

## Roadmap — subsequent phases (each gets its own detailed plan after the spike it depends on)

*Task-level, not step-level: their "complete code" depends on Phase 0 outputs (router, the confirmed `SwapAuth[]`, Go-vs-TS, `teeAddress` source). Each becomes a full plan once Phase 0 unlocks the specifics.*

- **Phase 1 — Control plane (Coston2 Solidity/Foundry).** Port `SubscriptionRegistry` + `CopyVault` + `CopyVaultFactory`; add `executeSwapWithTeeSig(SwapAuth[], index, actionId, tag, status, sig)` (Task-0a.5 verifier + `status==1` + consumed-id/deadline/vault/chainId checks + owner-gated `setTeeAddress`; disable/scope the legacy `onlyExecutor` path); add `SignalRegistry` + `SigmaxInstructionSender`. TDD in Foundry: valid sig executes; wrong signer / replay / expiry / cross-vault / wrong-chain / status≠1 revert; only-owner-withdraws; whitelist + cap enforced. Deploy to Coston2.
- **Phase 2 — Confidential core.** `FlareEnclaveCdr` (client-side ECIES encrypt → in-enclave decrypt); extension `SIGNAL/EXECUTE` handler: decrypt → Zod-validate → read `isActive` → size (reuse `packages/agent`) → emit `SwapAuth[]`. Tests: encrypt/decrypt round-trip, decrypt-only-in-enclave, redaction, sizing.
- **Phase 3 — Flare-native execution.** DEX executor (router from 0b) + FTSO minOut; keeper submits per-vault `executeSwapWithTeeSig`. E2E on Coston2 for 2–3 followers; inactive/expired/cancelled skipped; tampered/replayed sig reverts.
- **Phase 3.5 — One real attested run.** GCP Confidential Space VM, `MODE=0`, real code hash whitelisted, `setTeeAddress` to the real machine; else label simulated mode honestly. *(TS is not bit-for-bit reproducible cross-machine — code-hash churn; Go is, if this blocks.)*
- **Phase 4 — Frontend + demo + submission.** Rewire `apps/web` to Coston2 + addresses; move encryption client-side; Flare venue + FTSO price; 2–3 pilot testers; demo video; old-vs-new write-up.
- **Phase 5 — Hyperliquid bonus (droppable).** Route `venue==="hyperliquid"` to the reused HL executor.

---

## Self-Review

- **Spec coverage:** Phase 0 covers spec §7 Phase 0a + 0b fully; the locked `SwapAuth[]` (0a.5) + `teeAddress` provenance cover the spec's "confirm TEE-signature scheme during spikes" item; the DEX decision (0b.3) covers the SparkDEX-on-Coston2 risk; the TS spike (0a) covers the "TS path — spike confirms" risk. Phases 1–5 mapped in the roadmap.
- **Placeholders:** code-producing tasks (0a.5 verifier, 0b.2 FTSO, 0b.3 swap) carry complete code/commands; bring-up steps are exact `fce-sign` commands. No "TBD".
- **Type consistency:** `SwapAuth` fields, the `executeSwapWithTeeSig(SwapAuth[], index, …)` shape, and `recoverActionSigner(...)` are the exact names Phase 1 consumes.
