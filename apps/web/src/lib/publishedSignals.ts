/**
 * Local record of the signals THIS browser has published, per strategy. The leader's publishes are
 * real (each maps to a CDR vault uuid returned by the agent), but there is no on-chain enumeration of
 * a strategy's signals (and we must never expose TP/SL — CLAUDE.md rule 3). So we persist only
 * non-secret metadata (uuid, action, timestamp) in localStorage to show a real "published signals"
 * list + count instead of fabricated history. SSR-safe (no-ops without `window`).
 */
export interface PublishedSignal {
  signalId: string;
  uuid?: number;
  action: "ENTRY" | "EXIT";
  at: string; // ISO timestamp
  /** Story L1 tx hashes from the CDR publish (live mode): `write` commits the signal, `allocate` the vault. */
  txHashes?: { allocate: string; write: string };
}

const keyFor = (strategyId: string) => `sigmax:published:${strategyId.toLowerCase()}`;

/**
 * Explorer proof links for a published signal: the `write` tx (the on-chain commitment of the encrypted
 * signal) and the `allocate` tx (vault creation). Empty when there are no on-chain hashes (e.g. an
 * older record or the no-agent fallback), so callers render no link rather than a dead explorer root.
 */
export function signalProofs(
  s: Pick<PublishedSignal, "txHashes">,
  explorerBase: string,
): { label: string; url: string }[] {
  if (!s.txHashes) return [];
  const links: { label: string; url: string }[] = [];
  if (s.txHashes.write)
    links.push({ label: "signal", url: `${explorerBase}/tx/${s.txHashes.write}` });
  if (s.txHashes.allocate)
    links.push({ label: "vault", url: `${explorerBase}/tx/${s.txHashes.allocate}` });
  return links;
}

export function getPublishedSignals(strategyId: string | undefined): PublishedSignal[] {
  if (!strategyId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(strategyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PublishedSignal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addPublishedSignal(
  strategyId: string | undefined,
  sig: PublishedSignal,
): PublishedSignal[] {
  if (!strategyId || typeof window === "undefined") return [];
  const next = [sig, ...getPublishedSignals(strategyId)].slice(0, 50);
  try {
    window.localStorage.setItem(keyFor(strategyId), JSON.stringify(next));
  } catch {
    /* ignore quota / disabled storage */
  }
  return next;
}
