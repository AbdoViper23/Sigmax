import type { SignalVenueT } from "@sigmax/shared";
import type { Executor, PriceSource, OpenPosition } from "./ports.js";
import type { PositionStore } from "./state.js";
import type { AgentLogger } from "./logger.js";

export interface TpSlDeps {
  executorFor: (venue: SignalVenueT) => Executor;
  priceFor: (venue: SignalVenueT) => PriceSource;
  store: PositionStore;
  logger: AgentLogger;
  pollMs: number;
  defaultSlippageBps: number;
}

/**
 * Polls the (public) price of each open position's token and exits when the SECRET takeProfit or
 * stopLoss is crossed. The thresholds live in memory only and are never logged — only the resulting
 * trade is visible (doc 32). Groups positions by token so one price read serves every holder. Exits
 * fire regardless of subscription status (a follower mid-trade is never stranded).
 */
export class TpSlMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly d: TpSlDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Skip if the previous tick is still in flight, so a slow tick can't overlap and double-exit.
      if (this.running) return;
      this.running = true;
      void this.tick().finally(() => {
        this.running = false;
      });
    }, this.d.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One monitoring pass. Safe to call directly (tests drive it without a timer). */
  async tick(): Promise<void> {
    for (const group of this.d.store.positionGroups()) {
      let price: bigint;
      try {
        // Price + executor are resolved per venue, priced in the position's own quote token.
        price = await this.d.priceFor(group.venue).getPrice(group.token, group.quoteToken);
      } catch (err) {
        this.d.logger.error({ event: "price_failed", message: errMsg(err) });
        continue; // a price failure for one market doesn't block others
      }
      for (const p of group.positions) {
        const reason = crossReason(p, price);
        if (reason) await this.exit(p, reason);
      }
    }
  }

  private async exit(p: OpenPosition, reason: "TP" | "SL"): Promise<void> {
    try {
      const { txHash, received } = await this.d.executorFor(p.venue).quoteAndSwap({
        vault: p.vault,
        tokenIn: p.token,
        tokenOut: p.quoteToken,
        amountIn: p.received,
        slippageBps: this.d.defaultSlippageBps,
      });
      this.d.store.close(p.signalId, p.follower);
      this.d.logger.swapExecuted({
        signalId: p.signalId,
        follower: p.follower,
        tokenIn: p.token,
        tokenOut: p.quoteToken,
        amountIn: p.received,
        received,
        txHash,
        kind: "EXIT",
        reason,
      });
    } catch (err) {
      this.d.logger.error({ event: "exit_failed", message: errMsg(err), follower: p.follower, signalId: p.signalId });
    }
  }
}

/** Returns "TP"/"SL" if the (public) price crossed a (secret) threshold, else undefined. */
export function crossReason(p: OpenPosition, price: bigint): "TP" | "SL" | undefined {
  if (p.takeProfitPrice > 0n && price >= p.takeProfitPrice) return "TP";
  if (p.stopLossPrice > 0n && price <= p.stopLossPrice) return "SL";
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
