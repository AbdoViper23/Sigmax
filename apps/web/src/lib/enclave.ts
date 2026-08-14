import { PROXY_FETCH_HEADERS } from "@sigmax/enclave-crypto";
import { env } from "./env";

/**
 * Resilient access to the FCC proxy / enclave endpoints.
 *
 * There are two ways to reach the enclave and each fails in its own way: the same-origin `/enclave`
 * path exists only while the Vite dev server (or an equivalently configured reverse proxy) is in
 * front of the app, and the public tunnel URL answers browser requests with an HTML interstitial
 * unless the skip header is sent — and drops ~1 request in 10 under load. So every read tries the
 * configured URL first and falls through to the public one, and a fetch only counts as succeeded
 * when the body parses as JSON (the interstitial is a 200, so `res.ok` alone would accept it).
 */
const BASES: string[] = [env.flareProxyUrl, env.flareProxyFallbackUrl]
  .filter((b): b is string => Boolean(b))
  // strip trailing slashes so path concatenation cannot produce `//info`
  .map((b) => b.replace(/\/$/, ""))
  .filter((b, i, all) => all.indexOf(b) === i);

/** GET `path` from the first proxy base that answers valid JSON. Throws only when all fail. */
export async function enclaveFetchJson<T>(path: string, timeoutMs = 8_000): Promise<T> {
  let lastError: unknown = new Error("no proxy URL configured");
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: PROXY_FETCH_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${base}${path} → ${res.status}`);
      return (await res.json()) as T; // interstitial HTML fails here and falls through
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The state the extension reports (nested under `state` by the FCC node). */
export interface EnclaveState {
  hasKey: boolean;
  agentAddress: string | null;
  hlAgentMasterPubkey: string | null;
  version: string;
  sigmax?: {
    signalsProcessed: number;
    signalsRejected: number;
    authsIssued: number;
    hlOrdersFilled: number;
    duplicatesRejected: number;
  };
}

/** Read the enclave's live state; `null` means every route to it failed. */
export async function readEnclaveState(): Promise<EnclaveState | null> {
  try {
    const body = await enclaveFetchJson<{ state?: EnclaveState }>("/state");
    return body.state ?? null;
  } catch {
    return null;
  }
}

/**
 * A `fetch` for `ProxyEnclaveKeySource` that retries the request against every proxy base.
 * The sealer builds `${proxyUrl}/info` itself, so this strips the known bases back off and
 * re-tries the path on each — keeping the failover in one place instead of inside the crypto lib.
 */
export const proxyFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const base = BASES.find((b) => url.startsWith(b));
  if (!base) return fetch(input, { ...init, headers: { ...init?.headers, ...PROXY_FETCH_HEADERS } });

  const path = url.slice(base.length);
  let lastError: unknown;
  for (const b of BASES) {
    try {
      const res = await fetch(`${b}${path}`, {
        ...init,
        headers: { ...init?.headers, ...PROXY_FETCH_HEADERS },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${b}${path} → ${res.status}`);
      // The tunnel's interstitial is a 200 with an HTML body; only JSON counts as the proxy.
      const clone = res.clone();
      await clone.json();
      return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
