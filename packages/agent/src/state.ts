import { readFile, writeFile } from "node:fs/promises";
import type { Hex } from "viem";
import type { CdrPort } from "@sigmax/cdr";
import type { OpenPosition, SafePosition } from "./ports.js";

const key = (signalId: string, follower: Hex) => `${signalId}:${follower.toLowerCase()}`;

/**
 * In-memory position + idempotency store. TP/SL live ONLY in memory. Optional JSON persistence writes
 * the NON-secret subset (SafePosition — no TP/SL); on boot `reconcile` re-derives TP/SL by re-reading
 * the original CDR vault via `accessSignal(uuid)`, so the secret thresholds never touch disk (doc 32).
 */
export class PositionStore {
  private readonly positions = new Map<string, OpenPosition>();
  private readonly processed = new Set<string>(); // signalIds seen (idempotency)

  constructor(private readonly statePath?: string) {}

  // ----- idempotency -----
  isProcessed(signalId: string): boolean {
    return this.processed.has(signalId);
  }
  markProcessed(signalId: string): void {
    this.processed.add(signalId);
  }

  // ----- positions -----
  open(p: OpenPosition): void {
    this.positions.set(key(p.signalId, p.follower), p);
  }
  hasPosition(signalId: string, follower: Hex): boolean {
    return this.positions.has(key(signalId, follower));
  }
  close(signalId: string, follower: Hex): OpenPosition | undefined {
    const k = key(signalId, follower);
    const p = this.positions.get(k);
    if (p) this.positions.delete(k);
    return p;
  }
  all(): OpenPosition[] {
    return [...this.positions.values()];
  }
  /** Open positions grouped by token, so one price read serves every follower holding that token. */
  byToken(): Map<Hex, OpenPosition[]> {
    const m = new Map<Hex, OpenPosition[]>();
    for (const p of this.positions.values()) {
      const list = m.get(p.token) ?? [];
      list.push(p);
      m.set(p.token, list);
    }
    return m;
  }

  // ----- persistence (non-secret only) -----
  private toSafe(p: OpenPosition): SafePosition {
    const { takeProfitPrice: _tp, stopLossPrice: _sl, ...safe } = p;
    return safe;
  }

  /** Persist NON-secret position metadata + processed signalIds. TP/SL are deliberately excluded. */
  async persist(): Promise<void> {
    if (!this.statePath) return;
    const payload = {
      processed: [...this.processed],
      positions: this.all().map((p) => {
        const s = this.toSafe(p);
        return { ...s, amountIn: s.amountIn.toString(), received: s.received.toString() };
      }),
    };
    await writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
  }

  /**
   * Restore from disk and re-derive each position's secret TP/SL by re-reading its CDR vault. Positions
   * whose vault can no longer be decrypted (e.g. revoked) are dropped with a non-fatal skip count.
   */
  async reconcile(cdr: CdrPort): Promise<{ restored: number; dropped: number }> {
    if (!this.statePath) return { restored: 0, dropped: 0 };
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch {
      return { restored: 0, dropped: 0 }; // no prior state
    }
    const data = JSON.parse(raw) as {
      processed: string[];
      positions: (Omit<SafePosition, "amountIn" | "received"> & { amountIn: string; received: string })[];
    };
    for (const s of data.processed) this.processed.add(s);

    let restored = 0;
    let dropped = 0;
    for (const sp of data.positions) {
      try {
        const signal = await cdr.accessSignal(sp.uuid); // re-derive secret thresholds in memory only
        this.open({
          signalId: sp.signalId,
          uuid: sp.uuid,
          follower: sp.follower as Hex,
          vault: sp.vault as Hex,
          token: sp.token as Hex,
          quoteToken: sp.quoteToken as Hex,
          amountIn: BigInt(sp.amountIn),
          received: BigInt(sp.received),
          entryTxHash: sp.entryTxHash as Hex,
          takeProfitPrice: BigInt(signal.takeProfitPrice),
          stopLossPrice: BigInt(signal.stopLossPrice),
        });
        restored += 1;
      } catch {
        dropped += 1;
      }
    }
    return { restored, dropped };
  }
}
