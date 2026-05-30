import type { Signal } from "@sigmax/shared";

/**
 * The CDR boundary Sigmax depends on. One interface, two implementations:
 * - `RealCdr`  — wraps @piplabs/cdr-sdk (threshold encryption on Story Aeneid).
 * - `MockCdr`  — deterministic, no creds; simulates the license read-gate for tests/demo continuity.
 *
 * Wrapping the SDK here means version churn touches one file (doc 02 §3 / 20).
 */
export interface CdrPort {
  /** Encrypt + publish a signal; returns the on-chain vault id. */
  publishSignal(signal: Signal): Promise<{ uuid: number }>;
  /** Decrypt a signal — only succeeds if the caller satisfies the read condition. */
  accessSignal(uuid: number): Promise<Signal>;
}

export class ReadConditionDenied extends Error {
  constructor(message = "read condition not satisfied (no valid license)") {
    super(message);
    this.name = "ReadConditionDenied";
  }
}
