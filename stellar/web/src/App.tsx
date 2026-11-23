import { useEffect, useState } from "react";

import { Follower } from "./pages/Follower";
import { Leader } from "./pages/Leader";
import { Overview } from "./pages/Overview";
import { useWallet } from "./wallet";

const TABS = { overview: "Overview", leader: "Leader", follower: "Follower" } as const;
type Tab = keyof typeof TABS;

const fromHash = (): Tab => {
  const h = window.location.hash.slice(1);
  return h in TABS ? (h as Tab) : "overview";
};

export default function App() {
  const [tab, setTab] = useState<Tab>(fromHash);
  const wallet = useWallet();

  useEffect(() => {
    const on = () => setTab(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#overview">
          <span className="brand-mark">Σ</span> Sigmax <span className="brand-net">Stellar Testnet</span>
        </a>
        <nav>
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <a key={t} href={`#${t}`} className={t === tab ? "nav-on" : ""}>
              {TABS[t]}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {tab === "overview" && <Overview />}
        {tab === "leader" && <Leader key={wallet.address ?? "none"} wallet={wallet} />}
        {tab === "follower" && <Follower key={wallet.address ?? "none"} wallet={wallet} />}
      </main>
      <footer className="foot muted small">
        Tranche 1 MVP on Stellar Testnet. Spot swaps only. The enclave runs in software mode; hardware attestation arrives in
        Tranche 2.
      </footer>
    </div>
  );
}
