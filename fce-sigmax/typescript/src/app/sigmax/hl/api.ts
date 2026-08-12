/**
 * Hyperliquid HTTP transport — the enclave's only outbound dependency for this venue.
 *
 * Two endpoints, deliberately: `/info` (public reads) and `/exchange` (signed writes). Keeping the
 * surface at the wire level rather than wrapping it in a typed client means the whole execute path
 * can be exercised offline against a two-method fake, and it is why no Hyperliquid SDK ships inside
 * the enclave.
 *
 * The enclave calls Hyperliquid **directly**. It does not hand a signed order to a relayer, because
 * an order that transits an untrusted hop is an order that can be read before it fills — the exact
 * front-running window the confidential design exists to close. Nothing about the strategy leaves
 * this module except the order itself, at the moment it executes.
 */

const MAINNET_API = "https://api.hyperliquid.xyz";
const TESTNET_API = "https://api.hyperliquid-testnet.xyz";

/** The two calls the execute path needs. Fakeable in tests without any network. */
export interface HlTransport {
  /** POST /info — public market and account reads. */
  info(payload: unknown): Promise<unknown>;
  /** POST /exchange — a signed action. */
  exchange(body: unknown): Promise<unknown>;
}

export function apiBaseUrl(isTestnet: boolean): string {
  return isTestnet ? TESTNET_API : MAINNET_API;
}

/**
 * A transport backed by global `fetch` (Node 22 — no dependency needed).
 *
 * `timeoutMs` is not optional in spirit: an FCC instruction has a time budget, and a hung request to
 * Hyperliquid would surface as a pending action rather than a clean failure — the same failure mode
 * that made a whole-history log rescan look like a broken authorization on the Flare path.
 */
export function httpTransport(isTestnet: boolean, timeoutMs = 10_000): HlTransport {
  const base = apiBaseUrl(isTestnet);

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // Include the status and body: Hyperliquid returns actionable errors (unapproved signer,
        // below minimum notional) as plain text that would otherwise be lost.
        throw new Error(`hyperliquid ${path} returned ${res.status}: ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    info: (payload) => post("/info", payload),
    exchange: (body) => post("/exchange", body),
  };
}

/** A spot balance entry from `spotClearinghouseState`. */
export interface SpotBalance {
  coin: string;
  total: string;
  hold: string;
}

/** Available (unheld) balance of `coin` for `user`, as a decimal quantity. Missing coin ⇒ 0. */
export async function readSpotBalance(
  transport: HlTransport,
  user: string,
  coin: string,
): Promise<number> {
  const state = (await transport.info({ type: "spotClearinghouseState", user })) as
    | { balances?: SpotBalance[] }
    | null;
  const entry = state?.balances?.find((b) => b.coin.toLowerCase() === coin.toLowerCase());
  if (!entry) return 0;
  const available = Number(entry.total) - Number(entry.hold);
  return available > 0 ? available : 0;
}

/**
 * Best ask (buy) or best bid (sell) — the price a marketable order must actually reach.
 *
 * Returns `null` rather than throwing when the book cannot be read or the relevant side is empty, so
 * the caller falls back to another reference instead of failing the whole signal on a transient
 * hiccup. Pricing off the touch rather than the mid matters on thin books: a wide spread around a
 * mid produces an IOC that never crosses and cancels unfilled.
 */
export async function readTouchPrice(
  transport: HlTransport,
  coin: string,
  isBuy: boolean,
): Promise<number | null> {
  try {
    const book = (await transport.info({ type: "l2Book", coin })) as
      | { levels?: [Array<{ px: string }>, Array<{ px: string }>] }
      | null;
    const levels = book?.levels;
    if (!levels) return null;
    const [bids, asks] = levels;
    const px = Number(isBuy ? asks?.[0]?.px : bids?.[0]?.px);
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

/** All mid prices, keyed by both `@index` and pair name. */
export async function readMids(transport: HlTransport): Promise<Record<string, string>> {
  return ((await transport.info({ type: "allMids" })) as Record<string, string> | null) ?? {};
}

/** The order fill Hyperliquid reports back, when one happened. */
export interface OrderFill {
  totalSz: string;
  avgPx: string;
  oid: number;
}

/**
 * Pull the fill out of an `/exchange` order response. `null` means nothing filled (an IOC that did
 * not cross), which the caller reports as a skip rather than an error — an unfilled limit is a normal
 * outcome, not a fault. An explicit Hyperliquid error still throws.
 */
export function extractFill(res: unknown): OrderFill | null {
  const status = (res as { response?: { data?: { statuses?: unknown[] } } })?.response?.data?.statuses?.[0];
  if (status && typeof status === "object") {
    if ("filled" in status) return (status as { filled: OrderFill }).filled;
    if ("error" in status) throw new Error(`hyperliquid order error: ${String((status as { error: unknown }).error)}`);
  }
  return null;
}
