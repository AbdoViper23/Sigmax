import type { Signal } from "@sigmax/shared";

/**
 * The CDR boundary Sigmax depends on, implemented by `RealCdr` — a wrapper over @piplabs/cdr-sdk
 * (threshold encryption on Story Aeneid). Wrapping the SDK here means version churn touches one
 * file (doc 02 §3 / 20). Tests use an in-memory `FakeCdr` double (packages/agent/test/helpers.ts).
 */
/** The two Story L1 transactions a CDR publish produces: `allocate` (vault) + `write` (the ciphertext). */
export interface CdrPublishTxHashes {
  allocate: string;
  write: string;
}

export interface CdrPort {
  /**
   * Encrypt + publish a signal; returns the on-chain vault id and (when written on-chain) the two
   * Story tx hashes the publish produced. `txHashes` is optional so in-memory doubles can omit it.
   */
  publishSignal(signal: Signal): Promise<{ uuid: number; txHashes?: CdrPublishTxHashes }>;
  /** Decrypt a signal — only succeeds if the caller satisfies the read condition. */
  accessSignal(uuid: number): Promise<Signal>;
}

export class ReadConditionDenied extends Error {
  constructor(message = "read condition not satisfied (no valid license)") {
    super(message);
    this.name = "ReadConditionDenied";
  }
}
