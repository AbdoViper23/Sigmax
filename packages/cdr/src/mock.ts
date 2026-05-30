import { encodeSignal, decodeSignal, type Signal } from "@sigmax/shared";
import type { Hex } from "viem";
import { type CdrPort, ReadConditionDenied } from "./port.js";

/**
 * Deterministic, credential-free CDR. Stores the ABI-encoded signal and gates reads on a simulated
 * license check — mirroring the real LicenseReadCondition behaviour (revert when the caller lacks a
 * valid license) so tests and the demo can run without a funded Aeneid wallet. Clearly NOT confidential.
 */
export class MockCdr implements CdrPort {
  private vaults = new Map<number, Hex>();
  private nextUuid = 1;

  constructor(private readonly opts: { hasLicense: boolean } = { hasLicense: true }) {}

  async publishSignal(signal: Signal): Promise<{ uuid: number }> {
    const uuid = this.nextUuid++;
    this.vaults.set(uuid, encodeSignal(signal)); // validates on encode
    return { uuid };
  }

  async accessSignal(uuid: number): Promise<Signal> {
    if (!this.opts.hasLicense) throw new ReadConditionDenied();
    const data = this.vaults.get(uuid);
    if (!data) throw new Error(`vault ${uuid} not found`);
    return decodeSignal(data); // re-validates on decode
  }
}
