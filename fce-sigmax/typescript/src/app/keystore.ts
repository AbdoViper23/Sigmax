/**
 * In-enclave custody of the operator key injected via `KEY/UPDATE`.
 *
 * Extracted from `handlers.ts` so the SIGNAL handler can reach the same key without importing
 * `handlers.ts` (which imports it back — a cycle). It is a module-level variable on purpose: the key
 * lives in enclave memory and nowhere else. It is never written to disk, never logged, and never
 * included in a handler's returned data.
 *
 * On the Hyperliquid venue this key is the **agent key** each follower has approved. It can place
 * orders on their behalf and provably cannot withdraw — Hyperliquid rejects withdrawals signed by an
 * agent key — so the worst an attacker with enclave code execution could do is trade, not steal.
 *
 * Restart clears it, by design: an ephemeral secret that must be re-injected is strictly safer than a
 * persisted one. See `docs/flare/02-hyperliquid-venue.md` for the key-provenance ladder (injected
 * today; derived in-enclave from sealed material once that capability is verified).
 */

let privateKey: Uint8Array | null = null;

/** Store the injected key. Pass `null` to clear it (shutdown / tests). */
export function setStoredKey(key: Uint8Array | null): void {
  privateKey = key;
}

/** The stored key, or `null` if none has been injected since boot. */
export function getStoredKey(): Uint8Array | null {
  return privateKey;
}

/** Whether a key is available — safe to report publicly, unlike the key itself. */
export function hasStoredKey(): boolean {
  return privateKey !== null;
}
