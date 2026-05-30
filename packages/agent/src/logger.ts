/**
 * Allowlist logger. Confidentiality is enforced by CONSTRUCTION: every helper accepts only known-safe,
 * non-secret fields and emits a fixed shape. There is no code path here that accepts a `Signal` object,
 * `takeProfitPrice`, or `stopLossPrice` — so the strategy and its TP/SL levels can never be logged
 * (CLAUDE.md rule 3, doc 31 confidentiality table). bigints are stringified for JSON safety.
 *
 * A `sink` can be injected (tests capture lines; production prints JSON to stdout).
 */
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  // eslint-disable-next-line no-console
  console.log(line);
};

function emit(sink: LogSink, level: string, event: string, fields: Record<string, string>): void {
  sink(JSON.stringify({ level, event, ...fields }));
}

export class AgentLogger {
  constructor(private readonly sink: LogSink = defaultSink) {}

  /** A signal was received for processing (all non-secret identifiers). */
  signalReceived(f: { uuid: number; strategyId: string; signalId: string; action: string }): void {
    emit(this.sink, "info", "signal_received", {
      uuid: String(f.uuid),
      strategyId: f.strategyId,
      signalId: f.signalId,
      action: f.action,
    });
  }

  /** A swap executed for a follower (public trade result only — token pair, amounts, tx hash). */
  swapExecuted(f: {
    signalId: string;
    follower: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    received: bigint;
    txHash: string;
    kind: "ENTRY" | "EXIT";
    reason?: "TP" | "SL" | "SIGNAL";
  }): void {
    emit(this.sink, "info", "swap_executed", {
      signalId: f.signalId,
      follower: f.follower,
      tokenIn: f.tokenIn,
      tokenOut: f.tokenOut,
      amountIn: f.amountIn.toString(),
      received: f.received.toString(),
      txHash: f.txHash,
      kind: f.kind,
      reason: f.reason ?? "SIGNAL",
    });
  }

  /** A follower was skipped for a non-secret reason (cap, inactive, zero size, …). */
  skipped(f: { signalId: string; follower: string; reason: string }): void {
    emit(this.sink, "info", "skipped", { signalId: f.signalId, follower: f.follower, reason: f.reason });
  }

  /** A non-secret error (never includes signal contents). */
  error(f: { event: string; message: string; follower?: string; signalId?: string }): void {
    emit(this.sink, "error", f.event, {
      message: f.message,
      ...(f.follower ? { follower: f.follower } : {}),
      ...(f.signalId ? { signalId: f.signalId } : {}),
    });
  }

  /** A generic informational note (caller must pass only non-secret strings). */
  info(event: string, fields: Record<string, string> = {}): void {
    emit(this.sink, "info", event, fields);
  }
}
