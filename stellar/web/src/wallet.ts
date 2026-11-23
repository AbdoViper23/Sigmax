/**
 * Varial (formerly Freighter) wallet connection. Tranche 1 ships with this wallet only; Tranche 2
 * moves to Stellar Wallets Kit for xBull, LOBSTR and Albedo.
 */

import { getAddress, getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import type { Signer } from "@sigmax/stellar-client";
import { useCallback, useEffect, useMemo, useState } from "react";

import { deployment } from "./env";

export interface Wallet {
  address: string | null;
  error: string | null;
  connect: () => Promise<void>;
  signer: Signer;
}

export function useWallet(): Wallet {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkNetwork = useCallback(async () => {
    const net = await getNetworkDetails();
    if (!net.error && net.networkPassphrase !== deployment.networkPassphrase) {
      setError("Your wallet is not on Testnet. Switch networks in the wallet.");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const c = await isConnected();
      if (!c.isConnected) return;
      const a = await getAddress();
      if (a.address) {
        setAddress(a.address);
        await checkNetwork();
      }
    })();
  }, [checkNetwork]);

  const connect = useCallback(async () => {
    setError(null);
    const c = await isConnected();
    if (!c.isConnected) {
      setError("No wallet found. Install Varial (formerly Freighter) and reload.");
      return;
    }
    const r = await requestAccess();
    if (r.error || !r.address) {
      setError(r.error?.message ?? "The wallet did not share an address.");
      return;
    }
    setAddress(r.address);
    await checkNetwork();
  }, [checkNetwork]);

  const signer = useMemo<Signer>(
    () => async (txXdr, networkPassphrase) => {
      const r = await signTransaction(txXdr, { networkPassphrase, address: address ?? undefined });
      if (r.error) throw new Error(r.error.message ?? "The wallet rejected the transaction.");
      return r.signedTxXdr;
    },
    [address],
  );

  return { address, error, connect, signer };
}
