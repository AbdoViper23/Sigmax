# 20 — CDR SDK (@piplabs/cdr-sdk)

> How Sigmax encrypts a signal and how the agent decrypts it. Grounded in Story's official CDR
> SDK Overview and the `cdr-skill` examples. This is the core confidentiality machinery.
> Pairs with `contracts/11-cdr-conditions.md` (the access gates) and `cdr-story/22-signal-template.md`
> (what we put inside the vault).

> ⚠️ **VERIFY THE VERSION FIRST.** Story docs say `@piplabs/cdr-sdk` **v0.2.1**; GitHub release tags
> showed 0.1.1. Run `npm view @piplabs/cdr-sdk version` and check the installed package's `.d.ts`
> before trusting any signature below. (Tracked in `94-risks-and-unknowns.md`.)

---

## 1. What CDR gives us (the guarantee)

CDR is Story's application layer for **threshold-encrypted data on Story L1**. It uses the validator
network's DKG public key so **no single party holds the full decryption key**; data decrypts only
when a **threshold of validators** provide partial decryptions, **and** the on-chain read condition
passes. The validator-side DKG + partial-decryption run inside `story-kernel` **Intel SGX TEEs**.
Plaintext encryption and final decryption happen **client-side** — neither the CDR contract nor the
validators ever see plaintext.

**What this buys Sigmax:** we can publish a signal that is unreadable to everyone (including us
and the validators individually) until our agent, satisfying the read condition, reconstructs it
client-side inside its own TEE. (See `00-overview §3`.)

### Limits we must design around (from the security model)
- **Metadata is NOT hidden** — vault UUIDs, condition addresses, and any storage pointers are public.
  → Never put anything sensitive in metadata; only the ciphertext payload is protected.
- **Availability** — reads can fail if too few validators respond before `timeoutMs`; retry / raise it.
- **No native revocation / forward secrecy** — ciphertext is bound to the access rules + validator
  set at encryption time. To change who can read, **rotate/re-encrypt** at the app layer (publish a
  new signal). Fine for us: each signal is a fresh short-lived vault.
- **Testnet posture** — Aeneid is **not a production confidentiality environment**. For the demo,
  that's acceptable; for launch, track CDR mainnet readiness (`94-risks-and-unknowns.md`).

## 2. Two workflows — we use the on-chain secret one

| Workflow | API | Use |
|---|---|---|
| **Data key vault** (on-chain secret) | `uploadCDR` / `accessCDR` | small secrets stored directly on-chain |
| **Encrypted file** (off-chain blob) | `uploadFile` / `downloadFile` | large files; key on-chain, ciphertext in IPFS/Storacha/Synapse/Supabase |

**Sigmax uses the data-key vault path** (`uploadCDR`/`accessCDR`): a signal is a tiny JSON
object (see `22`), so there's no need for off-chain file storage. Simpler, fewer moving parts.

## 3. Client setup

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";

await initWasm(); // MUST be called before any encryption/decryption

const account = privateKeyToAccount(process.env.CDR_KEY as `0x${string}`);
const transport = http(process.env.STORY_RPC_URL); // https://aeneid.storyrpc.io (testnet)
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ account, transport });

export const cdr = new CDRClient({ network: "testnet", publicClient, walletClient });
```
The client exposes three sub-clients: **`observer`** (read DKG/vault state), **`uploader`**
(allocate + write), **`consumer`** (read/decrypt). DKG state is read over the Story-API REST
endpoint (`apiUrl`); advanced config can switch DKG backends for speed (see `advanced-configuration`).

> Wrap all of this in `packages/cdr` (see `03-repo-structure §2`) so version churn touches one file.

## 4. Publish a signal (leader side, runs client-side in the browser)

We model a subscription as a Story License Token (Option A in `contracts/11`), so we use the
deployed `LicenseReadCondition` + `OwnerWriteCondition`.

```ts
import { encodeAbiParameters } from "viem";

// readConditionData = (licenseTokenContract, strategyIpId)
const readCondData = encodeAbiParameters(
  [{ type: "address" }, { type: "address" }],
  [LICENSE_TOKEN_CONTRACT, STRATEGY_IP_ID]
);
// writeConditionData = (leaderAddress)
const writeCondData = encodeAbiParameters([{ type: "address" }], [leaderAddress]);

const payload = encodeSignal(signalObject); // 32-byte data key OR small bytes (see §6 and doc 22)

const { uuid } = await cdr.uploader.uploadCDR({
  data: payload,
  updatable: true,                      // a strategy publishes repeatedly into one vault, or use a new vault per signal
  writeConditionAddr: "0x4C9bFC96d7092b590D497A191826C3dA2277c34B", // OwnerWriteCondition
  readConditionAddr:  "0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3", // LicenseReadCondition
  writeConditionData: writeCondData,
  readConditionData:  readCondData,
});
// publish `uuid` to the agent (event/registry) so it knows a new signal exists
```

> **Two vault strategies:** (a) one **updatable** vault per strategy, rewritten each signal — fewer
> allocations, but only the latest signal is readable; (b) a **fresh vault per signal** — full
> history, more allocations. For copy-trading, prefer **fresh vault per signal** so each trade is
> independently auditable and time-stamped. Decide and keep consistent.

## 5. Decrypt a signal (agent side, inside the TEE)

```ts
// caller must satisfy the read condition: hold a valid license token for STRATEGY_IP_ID
const accessAuxData = encodeAbiParameters(
  [{ type: "uint256[]" }],
  [[BigInt(operatorLicenseTokenId)]]   // the agent's operator license (see contracts/11 §5)
);

const { dataKey } = await cdr.consumer.accessCDR({
  uuid,
  accessAuxData,
  timeoutMs: 120_000,          // raise/retry if validators are slow
});

const signal = decodeSignal(dataKey);   // -> validate with zod (doc 22) BEFORE acting
```

The decryption flow under the hood: generate an ephemeral keypair → submit an on-chain read request
(validated against the read condition) → collect validator partials until threshold → combine
client-side. All of that is inside `accessCDR`; you just await it.

**TEE rule:** this call and the resulting `signal` object run **inside the agent's TEE** and must
never be logged, persisted, or sent to the frontend (`CLAUDE.md` rule 3; `agent/30`).

## 6. Encoding the signal into the data key

A signal (token, entry, TP, SL, size) is a few fields. Two encoding options:
- **Direct small-bytes:** ABI-encode the signal struct and store the bytes in the vault (works if it
  fits the data-key path). Simplest.
- **Key-then-blob:** store a 32-byte AES key in the vault and the (encrypted) signal blob off-chain.
  Overkill for a tiny signal — use only if signals grow large.

Use the **direct** path for the MVP. The exact struct and its zod schema are in
`cdr-story/22-signal-template.md`; the encoder/decoder live in `packages/shared/signal.ts` so the
publisher (web) and reader (agent) are guaranteed to match.

## 7. The `allocate` / `write` / `read` primitives (when you need them)

`uploadCDR` is a convenience over `allocate` + `write`. For custom conditions (Option B,
`SubscriptionReadCondition`) you may allocate directly:
```ts
const { uuid } = await cdr.uploader.allocate({
  updatable: false,
  writeConditionAddr: LEADER_WRITE_CONDITION,
  readConditionAddr:  SUBSCRIPTION_READ_CONDITION,
  writeConditionData: encodeAbiParameters([{type:"address"}], [leader]),
  readConditionData:  encodeAbiParameters([{type:"uint256"}], [strategyId]),
});
await cdr.uploader.write({ uuid, accessAuxData: "0x", encryptedData });
// reader:
await cdr.consumer.read({ uuid, accessAuxData: "0x", requesterPubKey });
```
> **EOA shortcut:** if `msg.sender == conditionAddr`, CDR bypasses the check (owner-only via your own
> EOA). To use it call `allocate({ ..., skipConditionValidation: true })`. We don't need this —
> we use real condition contracts — but know it exists for quick local tests.

## 8. The `cdr-skill` examples (fastest on-ramp)

`github.com/jacob-tucker/cdr-skill` ships runnable examples: **encrypt text**, **encrypt file via
IPFS**, **license-gated content**, and **file via Supabase**. The **license-gated** example is our
backbone — clone it first, get a round-trip working on Aeneid, then adapt it to the signal schema.

## 9. Acceptance (prove the hardest part first)
- ✅ `initWasm()` + client connect to Aeneid succeeds
- ✅ publish a signal with `uploadCDR` using `LicenseReadCondition` + `OwnerWriteCondition`
- ✅ a holder of the right license token decrypts it via `accessCDR` and recovers the exact signal
- ✅ a wallet **without** the license token **fails** to decrypt (condition rejects)
- ✅ decoded signal passes the zod schema (doc 22); malformed payload is rejected before any action
- ✅ wrong-version guard: a startup check logs the installed `@piplabs/cdr-sdk` version

## 10. Pitfalls
- Forgetting `initWasm()` → cryptic encryption errors.
- `ipId` is an **ERC-6551 address**, not a uint — encode as `address`.
- Encoding mismatch between publisher and reader → silent decrypt failure; keep encoders in `shared`.
- Treating a read timeout as a permanent failure → it's transient; retry / raise `timeoutMs`.
- Putting anything sensitive in metadata → metadata is public.

→ Next: `21-story-ip-royalty.md` (subscriptions + revenue) and `22-signal-template.md` (the schema).
