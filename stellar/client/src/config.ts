/**
 * Network and deployment configuration.
 *
 * `deployments/testnet.json` is written by `scripts/deploy-testnet.sh`; everything else
 * reads contract addresses from it instead of hard-coding them.
 */

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const TESTNET_FRIENDBOT = "https://friendbot.stellar.org";

export interface AssetInfo {
  /** Stellar Asset Contract (C...) of the asset. */
  token: string;
  /** Classic asset code, or `native` for XLM. */
  code: string;
  issuer?: string;
  decimals: number;
}

export interface VenueInfo {
  dex: "aquarius";
  pool: string;
  /** Pool tokens in pool index order. */
  tokens: string[];
  feeBps: number;
}

export interface Deployment {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  deployedAt?: string;
  admin: string;
  contracts: {
    signalRegistry: string;
    enclaveRegistry: string;
    vaultFactory: string;
  };
  wasm?: Record<string, string>;
  /** SEP-40 oracle (Reflector) vaults bound `min_amount_out` with. */
  oracle: string;
  /** Oracle ticker → asset. */
  assets: Record<string, AssetInfo>;
  venues: VenueInfo[];
}

/** Check a parsed deployment file has every field the client relies on. */
export function parseDeployment(raw: unknown): Deployment {
  const d = raw as Deployment;
  const contracts = d?.contracts;
  if (!d || typeof d !== "object" || !contracts?.signalRegistry || !contracts.enclaveRegistry || !contracts.vaultFactory) {
    throw new Error("deployment file is missing contract addresses");
  }
  if (!d.rpcUrl || !d.networkPassphrase || !d.oracle || !d.assets || !Array.isArray(d.venues)) {
    throw new Error("deployment file is missing network, oracle, asset or venue fields");
  }
  return d;
}

/** Ticker of the asset whose token contract is `token`, if listed. */
export function symbolOf(deployment: Deployment, token: string): string | undefined {
  return Object.entries(deployment.assets).find(([, a]) => a.token === token)?.[0];
}
