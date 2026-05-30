import type { Hex } from "viem";
import type { CdrPort } from "@sigmax/cdr";
import { SignalSchema, type Signal } from "@sigmax/shared";
import type { Executor, SubscriberSource } from "./ports.js";
import { entryAmount } from "./executor.js";
import { PositionStore } from "./state.js";
import { AgentLogger } from "./logger.js";

export interface PipelineDeps {
  cdr: CdrPort;
  executor: Executor;
  subscribers: SubscriberSource;
  store: PositionStore;
  logger: AgentLogger;
  defaultSlippageBps: number;
  now?: () => number; // injectable clock (seconds); defaults to Date.now/1000
  persist?: () => Promise<void>; // called after each opened position so a crash mid-fan-out can't double-enter
}

/**
 * Core agent loop for one signal. Decrypts in memory, validates, dedupes by signalId, applies staleness
 * + eligibility, then fans out per-follower with isolated error handling. ENTRY opens a position (sized
 * from the vault balance, clamped to the cap) and records the SECRET TP/SL in memory only; EXIT closes
 * every open position for the strategy. Confidentiality: only non-secret fields are ever logged.
 */
export class SignalPipeline {
  constructor(private readonly d: PipelineDeps) {}

  private nowSec(): number {
    return this.d.now ? this.d.now() : Math.floor(Date.now() / 1000);
  }

  async processSignal(uuid: number): Promise<void> {
    // 1. decrypt (in memory). The raw signal is never logged.
    let decrypted: unknown;
    try {
      decrypted = await this.d.cdr.accessSignal(uuid);
    } catch (err) {
      this.d.logger.error({ event: "decrypt_failed", message: errMsg(err) });
      return;
    }
    // 2. validate. NEVER log the validation error — a zod message can echo decrypted field values
    // (including takeProfitPrice/stopLossPrice). Emit a fixed, content-free message instead.
    let signal: Signal;
    try {
      signal = SignalSchema.parse(decrypted);
    } catch {
      this.d.logger.error({ event: "signal_invalid", message: "schema validation failed" });
      return;
    }

    this.d.logger.signalReceived({
      uuid,
      strategyId: signal.strategyId,
      signalId: signal.signalId,
      action: signal.action,
    });

    // 3. idempotency: a signalId is processed at most once (survives restart via reconcile).
    if (this.d.store.isProcessed(signal.signalId)) {
      this.d.logger.skipped({ signalId: signal.signalId, follower: "*", reason: "duplicate" });
      return;
    }

    const strategyId = signal.strategyId as Hex;
    const followers = await this.d.subscribers.listFollowers(strategyId);

    if (signal.action === "EXIT") {
      // EXIT is naturally idempotent (a closed position won't reappear), so it is NOT deduped —
      // a failed exit can be safely retried by re-sending the signal instead of being stranded.
      await this.handleExit(signal, followers);
    } else {
      await this.handleEntry(signal, uuid, followers);
      // Mark processed after fan-out so a mid-run crash re-processes; per-follower double-entry is
      // separately guarded by `store.hasPosition` + per-follower persistence below.
      this.d.store.markProcessed(signal.signalId);
    }
  }

  private async handleEntry(signal: Signal, uuid: number, followers: Hex[]): Promise<void> {
    // 4. staleness: a stale ENTRY is dropped (EXIT always proceeds).
    if (signal.expiresAt !== 0 && this.nowSec() > signal.expiresAt) {
      this.d.logger.skipped({ signalId: signal.signalId, follower: "*", reason: "stale" });
      return;
    }

    const token = signal.token as Hex;
    const quoteToken = signal.quoteToken as Hex;

    // 5+6. per-follower, isolated: eligibility → size → quote+swap → record position.
    for (const follower of followers) {
      try {
        // Per-follower idempotency: if this signal already opened a position for this follower
        // (e.g. a crash-restart re-processing the same signalId), don't enter again.
        if (this.d.store.hasPosition(signal.signalId, follower)) {
          this.d.logger.skipped({ signalId: signal.signalId, follower, reason: "already_open" });
          continue;
        }
        const active = await this.d.subscribers.isActive(follower, signal.strategyId as Hex);
        if (!active) {
          this.d.logger.skipped({ signalId: signal.signalId, follower, reason: "inactive" });
          continue;
        }
        const vault = await this.d.executor.vaultOf(follower);
        const balance = await this.d.executor.balanceOf(vault, quoteToken);
        const cap = await this.d.executor.perTradeCap(vault);
        const amountIn = entryAmount(balance, signal.sizeBps, cap);
        if (amountIn === 0n) {
          this.d.logger.skipped({ signalId: signal.signalId, follower, reason: "zero_size" });
          continue;
        }
        const { txHash, received } = await this.d.executor.quoteAndSwap({
          vault,
          tokenIn: quoteToken,
          tokenOut: token,
          amountIn,
          slippageBps: this.d.defaultSlippageBps,
        });
        this.d.store.open({
          signalId: signal.signalId,
          uuid,
          follower,
          vault,
          token,
          quoteToken,
          amountIn,
          received,
          entryTxHash: txHash,
          takeProfitPrice: BigInt(signal.takeProfitPrice),
          stopLossPrice: BigInt(signal.stopLossPrice),
        });
        // Persist immediately so a crash before the next follower can't replay this entry on restart.
        await this.d.persist?.();
        this.d.logger.swapExecuted({
          signalId: signal.signalId,
          follower,
          tokenIn: quoteToken,
          tokenOut: token,
          amountIn,
          received,
          txHash,
          kind: "ENTRY",
        });
      } catch (err) {
        // one follower's failure never blocks the others
        this.d.logger.error({ event: "entry_failed", message: errMsg(err), follower, signalId: signal.signalId });
      }
    }
  }

  private async handleExit(signal: Signal, followers: Hex[]): Promise<void> {
    // A manual EXIT carries its own signalId (won't match the entry's), so positions are resolved by
    // follower + token. Closes every matching open position — even for followers whose subscription
    // expired (never strand someone mid-trade, doc 31).
    const token = signal.token as Hex;
    const followerSet = new Set(followers.map((f) => f.toLowerCase()));
    for (const p of this.d.store.all()) {
      if (p.token.toLowerCase() !== token.toLowerCase()) continue;
      if (!followerSet.has(p.follower.toLowerCase())) continue;
      try {
        const { txHash, received } = await this.d.executor.quoteAndSwap({
          vault: p.vault,
          tokenIn: p.token,
          tokenOut: p.quoteToken,
          amountIn: p.received,
          slippageBps: this.d.defaultSlippageBps,
        });
        this.d.store.close(p.signalId, p.follower);
        this.d.logger.swapExecuted({
          signalId: signal.signalId,
          follower: p.follower,
          tokenIn: p.token,
          tokenOut: p.quoteToken,
          amountIn: p.received,
          received,
          txHash,
          kind: "EXIT",
          reason: "SIGNAL",
        });
      } catch (err) {
        this.d.logger.error({ event: "exit_failed", message: errMsg(err), follower: p.follower, signalId: signal.signalId });
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
