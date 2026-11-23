/**
 * Retries for dropped connections. Only network-level failures are retried: contract errors,
 * failed simulations and rejected transactions are not, so a retry can never change an outcome.
 */

/** A dropped connection, timeout or reset (native fetch or stellar-sdk's axios client). */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { isAxiosError?: boolean; response?: unknown; code?: string };
  if (err.isAxiosError && !err.response) return true;
  if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_SOCKET"].includes(err.code ?? "");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `f`, retrying transient network errors with a growing backoff. */
export async function withRetry<T>(f: () => Promise<T>, attempts = 3, delayMs = 1_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      await sleep(delayMs * i);
    }
  }
}
