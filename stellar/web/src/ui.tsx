import type { ReactNode } from "react";

import { EXPLORER, short } from "./env";

export function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className="row-v">{children}</span>
    </div>
  );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Addr({ value, kind = "contract" }: { value: string; kind?: "contract" | "account" }) {
  return (
    <a className="mono" href={`${EXPLORER}/${kind}/${value}`} target="_blank" rel="noreferrer" title={value}>
      {short(value)}
    </a>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="mono" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>
      {short(hash, 8)}
    </a>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function WalletBar({ address, error, connect }: { address: string | null; error: string | null; connect: () => void }) {
  return (
    <div className="walletbar">
      {address ? (
        <span>
          Connected <Addr value={address} kind="account" />
        </span>
      ) : (
        <button className="btn" onClick={connect}>
          Connect Varial (Freighter)
        </button>
      )}
      {error && <Notice tone="warn">{error}</Notice>}
    </div>
  );
}
