import type { Signal } from "@sigmax/shared";

/**
 * The confidentiality boundary the Flare build depends on: a signal is sealed to one specific
 * enclave's public key, and nothing outside that enclave can open it.
 *
 * `accessSignal` exists to be *unimplementable*. Keeping it on the interface makes the guarantee
 * explicit at the type level — any implementation that could satisfy it would, by definition, have
 * broken confidentiality.
 */
export interface SealedSignalPort {
  /** Seal a signal for the enclave. Implementations never hold a wallet or send a transaction. */
  encryptSignal(signal: Signal): Promise<{ ciphertext: string; byteLength: number }>;
  /** Always rejects: only the enclave holds the decryption key. */
  accessSignal(uuid: number): Promise<Signal>;
}
