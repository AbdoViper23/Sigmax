/**
 * HTTP client for the enclave service (`stellar/enclave`). Request and response shapes mirror
 * `stellar/enclave/src/api.rs`; 128-bit numbers travel as decimal strings.
 */

import type { OracleState, PoolState, SignalRecord, VaultState } from "@sigmax/stellar-client";

export interface EnclaveKeys {
  mode: string;
  signing_key: string;
  signing_key_strkey: string;
  encryption_key: string;
}

export interface EnclavePlan {
  pool: string;
  token_in: string;
  token_out: string;
  in_idx: number;
  out_idx: number;
  amount_in: string;
  min_out: string;
  usd_value: string;
}

export type AuthorizeResponse =
  | {
      status: "signed";
      plan: EnclavePlan;
      proof: { signal: string; expires_at_ledger: number; signature: string };
      auth_payload: string;
    }
  | { status: "skipped"; reason: string };

export interface AuthorizeInput {
  commitment: string;
  ledger: { sequence: number; timestamp: number };
  vault: VaultState;
  signalUsed: boolean;
  pools: PoolState[];
  oracle: OracleState;
  nonce: bigint;
  signatureExpirationLedger: number;
}

export class EnclaveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`enclave ${status}: ${message}`);
  }
}

export class EnclaveClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // keep the raw text
      }
      throw new EnclaveError(res.status, message);
    }
    return JSON.parse(text) as T;
  }

  keys(): Promise<EnclaveKeys> {
    return this.call("GET", "/keys");
  }

  async submitSignal(commitment: string, ciphertext: string, record: SignalRecord): Promise<void> {
    await this.call("POST", "/signals", {
      commitment,
      ciphertext,
      record: {
        leader: record.leader,
        seq: record.seq,
        ledger: record.ledger,
        timestamp: Number(record.timestamp),
      },
    });
  }

  authorize(input: AuthorizeInput): Promise<AuthorizeResponse> {
    const { vault, oracle } = input;
    const p = vault.policy;
    return this.call("POST", "/authorize", {
      commitment: input.commitment,
      ledger: input.ledger,
      vault: {
        vault: vault.vault,
        paused: vault.paused,
        policy: {
          leader: p.leader,
          assets: p.assets,
          venues: p.venues,
          max_trade_bps: p.maxTradeBps,
          max_trade_usd: p.maxTradeUsd.toString(),
          max_daily_usd: p.maxDailyUsd.toString(),
          max_daily_trades: p.maxDailyTrades,
          max_slippage_bps: p.maxSlippageBps,
          max_signal_age_secs: Number(p.maxSignalAgeSecs),
          max_oracle_age_secs: Number(p.maxOracleAgeSecs),
          expires_at: Number(p.expiresAt),
        },
        balances: Object.fromEntries(Object.entries(vault.balances).map(([k, v]) => [k, v.toString()])),
        recent: vault.recent.map((m) => ({ timestamp: Number(m.timestamp), usd: m.usd.toString() })),
        signal_used: input.signalUsed,
      },
      pools: input.pools.map((pool) => ({
        pool: pool.pool,
        tokens: pool.tokens,
        reserves: pool.reserves.map((r) => r.toString()),
        fee_bps: pool.feeBps,
      })),
      oracle: {
        decimals: oracle.decimals,
        prices: Object.fromEntries(
          Object.entries(oracle.prices).map(([s, v]) => [s, { price: v.price.toString(), timestamp: Number(v.timestamp) }]),
        ),
      },
      auth: { nonce: input.nonce.toString(), signature_expiration_ledger: input.signatureExpirationLedger },
    });
  }
}
