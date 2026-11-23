import { Chain, parseDeployment } from "@sigmax/stellar-client";

import deploymentJson from "../../deployments/testnet.json";

export const deployment = parseDeployment(deploymentJson);
export const chain = new Chain(deployment);
export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? "http://127.0.0.1:8788";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

export const ONE = 10_000_000n;
export const USD = 10_000_000n;

/** Format base units with 7 decimals. */
export function fmt(amount: bigint, digits = 4): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const whole = a / ONE;
  const frac = (a % ONE).toString().padStart(7, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Parse a decimal string into base units with 7 decimals. */
export function parseAmount(s: string): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(t)) throw new Error("enter a positive amount with at most 7 decimals");
  const [w, f = ""] = t.split(".");
  return BigInt(w!) * ONE + BigInt(f.padEnd(7, "0"));
}

export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

export function symbolFor(token: string): string {
  return Object.entries(deployment.assets).find(([, a]) => a.token === token)?.[0] ?? short(token);
}

export interface RelayJob {
  commitment: string;
  status: "waiting-for-commit" | "executing" | "done" | "failed";
  error?: string;
  results: { vault: string; status: string; reason?: string; tx?: string; tokenIn?: string; amountIn?: string; minOut?: string }[];
}

export async function relay<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${RELAY_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `relay HTTP ${res.status}`);
  return json;
}

/** Small per-browser lists (vault addresses, signal commitments). Never stores signal contents. */
export function loadList<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as T[];
  } catch {
    return [];
  }
}

export function saveList<T>(key: string, list: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // storage unavailable: lists are a convenience only
  }
}
