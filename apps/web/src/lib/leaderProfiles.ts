/**
 * Off-chain leader profile (username + display name + bio), persisted in localStorage. PlanCreated
 * carries no name fields, so until there's a real profile source these live client-side. SSR-safe
 * (no-ops without `window`). Modeled on lib/publishedSignals.ts.
 *
 * WIRING SEAM: replace this with a real off-chain profile source — a profiles API/KV, an ENS text
 * record, or an on-chain `setProfile(strategyId, username, name)` registry extension. Consumers read
 * through `getLeaderProfile`, so only this file changes.
 */
export interface LeaderProfile {
  username: string;
  displayName: string;
  bio?: string;
  /** Monthly price entered at registration (mirrors plan.monthlyPrice once on-chain). */
  monthlyPrice?: string;
}

const keyFor = (strategyId: string) => `sigmax:leader-profile:${strategyId.toLowerCase()}`;

export function getLeaderProfile(strategyId: string | undefined): LeaderProfile | undefined {
  if (!strategyId || typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(keyFor(strategyId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LeaderProfile;
    return parsed && typeof parsed.username === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function setLeaderProfile(
  strategyId: string | undefined,
  profile: LeaderProfile,
): LeaderProfile | undefined {
  if (!strategyId || typeof window === "undefined") return undefined;
  try {
    window.localStorage.setItem(keyFor(strategyId), JSON.stringify(profile));
  } catch {
    /* ignore quota / disabled storage */
  }
  return profile;
}

/** Truncated address fallback for leaders without a stored profile (e.g. the live configured one). */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
