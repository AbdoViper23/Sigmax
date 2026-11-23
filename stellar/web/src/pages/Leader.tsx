import { prepareSignal, type SignalInput } from "@sigmax/stellar-client";
import { Address, xdr } from "@stellar/stellar-sdk";
import { useState } from "react";

import { chain, deployment, loadList, relay, saveList, short, symbolFor, type RelayJob } from "../env";
import { Card, Field, Notice, Pill, TxLink, WalletBar } from "../ui";
import type { Wallet } from "../wallet";

/** What this browser remembers about a published signal: never the sealed contents. */
interface SentSignal {
  commitment: string;
  kind: "entry" | "close";
  at: number;
  commitTx?: string;
}

const historyKey = (leader: string) => `sigmax.signals.${leader}`;

type Step = "idle" | "sealing" | "relay" | "signing" | "executing";

export function Leader({ wallet }: { wallet: Wallet }) {
  const assets = Object.keys(deployment.assets);
  const [kind, setKind] = useState<"entry" | "close">("entry");
  const [base, setBase] = useState("XLM");
  const [quote, setQuote] = useState("USDC");
  const [sizePct, setSizePct] = useState("25");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [entryRef, setEntryRef] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<RelayJob | null>(null);
  const [history, setHistory] = useState<SentSignal[]>(() => (wallet.address ? loadList(historyKey(wallet.address)) : []));

  const entries = history.filter((h) => h.kind === "entry");

  async function publish() {
    if (!wallet.address) return;
    setError(null);
    setJob(null);
    try {
      const input: SignalInput = {
        kind,
        leader: wallet.address,
        base,
        quote,
        sizeBps: Math.round(Number(sizePct) * 100),
        takeProfit: takeProfit.trim() || undefined,
        stopLoss: stopLoss.trim() || undefined,
        entryRef: kind === "close" ? entryRef : undefined,
      };
      setStep("sealing");
      const key = await chain.enclaveEncryptionKey();
      if (!key) throw new Error("No enclave key is registered in the Enclave Registry.");
      const sealed = prepareSignal(input, key);

      setStep("relay");
      await relay("/signals", { commitment: sealed.commitmentHex, ciphertext: sealed.ciphertextHex });

      setStep("signing");
      const sent = await chain.invoke(wallet.address, wallet.signer, deployment.contracts.signalRegistry, "commit", [
        new Address(wallet.address).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(sealed.commitment)),
      ]);
      const entry: SentSignal = { commitment: sealed.commitmentHex, kind, at: Date.now(), commitTx: sent.hash };
      const next = [entry, ...history].slice(0, 50);
      setHistory(next);
      saveList(historyKey(wallet.address), next);

      setStep("executing");
      for (let i = 0; i < 120; i++) {
        const j = await relay<RelayJob>(`/signals/${sealed.commitmentHex}`);
        setJob(j);
        if (j.status === "done" || j.status === "failed") break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep("idle");
      setTakeProfit("");
      setStopLoss("");
    }
  }

  const busy = step !== "idle";
  const stepLabel: Record<Step, string> = {
    idle: "",
    sealing: "Sealing in your browser…",
    relay: "Sending ciphertext to the relay…",
    signing: "Sign the commitment in your wallet…",
    executing: "Enclave is executing for each follower vault…",
  };

  return (
    <div className="grid">
      <WalletBar address={wallet.address} error={wallet.error} connect={wallet.connect} />

      <Card title="Publish a signal">
        <div className="seg">
          {(["entry", "close"] as const).map((k) => (
            <button key={k} className={kind === k ? "seg-on" : ""} onClick={() => setKind(k)} disabled={busy}>
              {k === "entry" ? "Entry (buy)" : "Close (sell)"}
            </button>
          ))}
        </div>
        <div className="form">
          <Field label="Asset traded">
            <select value={base} onChange={(e) => setBase(e.target.value)} disabled={busy}>
              {assets.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field label="Funding asset">
            <select value={quote} onChange={(e) => setQuote(e.target.value)} disabled={busy}>
              {assets.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </Field>
          <Field
            label={kind === "entry" ? "Size: % of each vault's funding balance" : "Size: % of each vault's position to sell"}
            hint="Each vault caps this further with its own limits."
          >
            <input type="number" min="0.01" max="100" step="0.01" value={sizePct} onChange={(e) => setSizePct(e.target.value)} disabled={busy} />
          </Field>
          {kind === "close" && (
            <Field label="Closes entry">
              <select value={entryRef} onChange={(e) => setEntryRef(e.target.value)} disabled={busy}>
                <option value="">Choose an entry signal</option>
                {entries.map((h) => (
                  <option key={h.commitment} value={h.commitment}>
                    {short(h.commitment, 8)} · {new Date(h.at).toLocaleString()}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Take profit (sealed)" hint="Encrypted with the signal. Never on-chain.">
            <input placeholder="optional, e.g. 0.16" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Stop loss (sealed)" hint="Encrypted with the signal. Never on-chain.">
            <input placeholder="optional, e.g. 0.12" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} disabled={busy} />
          </Field>
        </div>
        <button className="btn btn-primary" onClick={publish} disabled={!wallet.address || busy || (kind === "close" && !entryRef)}>
          Seal and publish
        </button>
        {busy && <p className="muted">{stepLabel[step]}</p>}
        {error && <Notice tone="bad">{error}</Notice>}
        <p className="muted small">
          Tranche 1 executes entries and closes. Take-profit and stop-loss travel sealed now; the enclave starts acting on them in
          Tranche 2.
        </p>
      </Card>

      {job && (
        <Card title="Execution" aside={<Pill tone={job.status === "done" ? "ok" : job.status === "failed" ? "bad" : "info"}>{job.status}</Pill>}>
          {job.error && <Notice tone="bad">{job.error}</Notice>}
          {job.results.length === 0 && job.status === "done" && <p className="muted">No vault follows this leader yet.</p>}
          <table className="table">
            <tbody>
              {job.results.map((r) => (
                <tr key={r.vault}>
                  <td className="mono">{short(r.vault)}</td>
                  <td>
                    <Pill tone={r.status === "submitted" ? "ok" : r.status === "skipped" ? "warn" : "bad"}>{r.status}</Pill>
                  </td>
                  <td>
                    {r.status === "submitted" ? (
                      <>
                        {r.amountIn && r.tokenIn ? `${(Number(r.amountIn) / 1e7).toFixed(4)} ${symbolFor(r.tokenIn)} in · ` : ""}
                        <TxLink hash={r.tx!} />
                      </>
                    ) : (
                      r.reason
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {history.length > 0 && (
        <Card title="Your signals (this browser)">
          <table className="table">
            <tbody>
              {history.map((h) => (
                <tr key={h.commitment}>
                  <td className="mono">{short(h.commitment, 8)}</td>
                  <td>{h.kind}</td>
                  <td>{new Date(h.at).toLocaleString()}</td>
                  <td>{h.commitTx && <TxLink hash={h.commitTx} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Only commitments are kept here. The sealed contents are never stored.</p>
        </Card>
      )}
    </div>
  );
}
