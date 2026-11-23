/**
 * TypeScript mirrors of the contract types in `stellar/contracts/types` and their ScVal encoding.
 *
 * A `#[contracttype]` struct is an ScMap keyed by its field names as symbols, sorted. Field names
 * stay snake_case on the wire; the TypeScript shapes use camelCase.
 */

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface AssetConfig {
  token: string;
  symbol: string;
  decimals: number;
}

export interface Venue {
  pool: string;
  tokens: string[];
}

export interface Policy {
  leader: string;
  assets: AssetConfig[];
  venues: Venue[];
  maxTradeBps: number;
  /** USD, 7 decimals. */
  maxTradeUsd: bigint;
  /** USD, 7 decimals. */
  maxDailyUsd: bigint;
  maxDailyTrades: number;
  maxSlippageBps: number;
  maxSignalAgeSecs: bigint;
  maxOracleAgeSecs: bigint;
  /** Unix seconds. */
  expiresAt: bigint;
}

export interface VaultConfig {
  enclaveRegistry: string;
  signalRegistry: string;
  oracle: string;
}

export interface SignalRecord {
  leader: string;
  seq: number;
  ledger: number;
  timestamp: bigint;
}

export interface TradeMark {
  timestamp: bigint;
  usd: bigint;
}

export interface SwapProof {
  signal: Uint8Array;
  expiresAtLedger: number;
  signature: Uint8Array;
}

/** One USD in policy units. */
export const USD = 10_000_000n;

/** Encode a contracttype struct: an ScMap with symbol keys in sorted order. */
export function structToScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })),
  );
}

const addr = (s: string) => new Address(s).toScVal();
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

export function assetConfigToScVal(a: AssetConfig): xdr.ScVal {
  return structToScVal({ token: addr(a.token), symbol: xdr.ScVal.scvSymbol(a.symbol), decimals: u32(a.decimals) });
}

export function venueToScVal(v: Venue): xdr.ScVal {
  return structToScVal({ pool: addr(v.pool), tokens: xdr.ScVal.scvVec(v.tokens.map(addr)) });
}

export function policyToScVal(p: Policy): xdr.ScVal {
  return structToScVal({
    leader: addr(p.leader),
    assets: xdr.ScVal.scvVec(p.assets.map(assetConfigToScVal)),
    venues: xdr.ScVal.scvVec(p.venues.map(venueToScVal)),
    max_trade_bps: u32(p.maxTradeBps),
    max_trade_usd: i128(p.maxTradeUsd),
    max_daily_usd: i128(p.maxDailyUsd),
    max_daily_trades: u32(p.maxDailyTrades),
    max_slippage_bps: u32(p.maxSlippageBps),
    max_signal_age_secs: u64(p.maxSignalAgeSecs),
    max_oracle_age_secs: u64(p.maxOracleAgeSecs),
    expires_at: u64(p.expiresAt),
  });
}

export function vaultConfigToScVal(c: VaultConfig): xdr.ScVal {
  return structToScVal({
    enclave_registry: addr(c.enclaveRegistry),
    signal_registry: addr(c.signalRegistry),
    oracle: addr(c.oracle),
  });
}

export function swapProofToScVal(p: SwapProof): xdr.ScVal {
  if (p.signal.length !== 32 || p.signature.length !== 64) throw new Error("bad proof lengths");
  return structToScVal({
    signal: xdr.ScVal.scvBytes(Buffer.from(p.signal)),
    expires_at_ledger: u32(p.expiresAtLedger),
    signature: xdr.ScVal.scvBytes(Buffer.from(p.signature)),
  });
}

/** Symbol keys of an ScMap, in their encoded order. */
export function mapKeys(v: xdr.ScVal): string[] {
  if (v.type !== "scvMap") throw new Error("not a map");
  return (v as unknown as { map: { key: { sym: { toString(): string } } }[] }).map.map((e) => e.key.sym.toString());
}

/** SEP-40 asset `Other(symbol)`, as Reflector's off-chain feed expects. */
export function oracleOtherAsset(symbol: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(symbol)]);
}

type Native = Record<string, unknown>;

const big = (v: unknown) => BigInt(v as bigint | number | string);

export function policyFromScVal(v: xdr.ScVal): Policy {
  const n = scValToNative(v) as Native;
  return {
    leader: n.leader as string,
    assets: (n.assets as Native[]).map((a) => ({
      token: a.token as string,
      symbol: a.symbol as string,
      decimals: Number(a.decimals),
    })),
    venues: (n.venues as Native[]).map((w) => ({ pool: w.pool as string, tokens: w.tokens as string[] })),
    maxTradeBps: Number(n.max_trade_bps),
    maxTradeUsd: big(n.max_trade_usd),
    maxDailyUsd: big(n.max_daily_usd),
    maxDailyTrades: Number(n.max_daily_trades),
    maxSlippageBps: Number(n.max_slippage_bps),
    maxSignalAgeSecs: big(n.max_signal_age_secs),
    maxOracleAgeSecs: big(n.max_oracle_age_secs),
    expiresAt: big(n.expires_at),
  };
}

export function vaultConfigFromScVal(v: xdr.ScVal): VaultConfig {
  const n = scValToNative(v) as Native;
  return {
    enclaveRegistry: n.enclave_registry as string,
    signalRegistry: n.signal_registry as string,
    oracle: n.oracle as string,
  };
}

export function signalRecordFromScVal(v: xdr.ScVal): SignalRecord | null {
  if (v.type === "scvVoid") return null;
  const n = scValToNative(v) as Native;
  return {
    leader: n.leader as string,
    seq: Number(n.seq),
    ledger: Number(n.ledger),
    timestamp: big(n.timestamp),
  };
}

export function tradeMarksFromScVal(v: xdr.ScVal): TradeMark[] {
  return (scValToNative(v) as Native[]).map((m) => ({ timestamp: big(m.timestamp), usd: big(m.usd) }));
}

export function priceFromScVal(v: xdr.ScVal): { price: bigint; timestamp: bigint } | null {
  if (v.type === "scvVoid") return null;
  const n = scValToNative(v) as Native;
  return { price: big(n.price), timestamp: big(n.timestamp) };
}
