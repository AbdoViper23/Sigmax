import { policyToScVal, type Policy, type VaultState } from "@sigmax/stellar-client";
import { Address, nativeToScVal, scValToNative, StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useState } from "react";

import { chain, deployment, fmt, loadList, parseAmount, saveList, symbolFor, USD } from "../env";
import { Addr, Card, Field, Notice, Pill, Row, TxLink, WalletBar } from "../ui";
import type { Wallet } from "../wallet";

const vaultsKey = (owner: string) => `sigmax.vaults.${owner}`;

function defaultPolicyForm() {
  return { leader: "", maxTradePct: "100", maxTradeUsd: "50", maxDailyUsd: "500", maxDailyTrades: "10", slippagePct: "5", days: "30" };
}

export function Follower({ wallet }: { wallet: Wallet }) {
  const owner = wallet.address;
  const [vaults, setVaults] = useState<string[]>(() => (owner ? loadList(vaultsKey(owner)) : []));
  const [selected, setSelected] = useState<string | null>(vaults[0] ?? null);
  const [state, setState] = useState<VaultState | null>(null);
  const [form, setForm] = useState(defaultPolicyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [amount, setAmount] = useState("10");
  const [asset, setAsset] = useState("USDC");

  useEffect(() => {
    if (!owner) return;
    const list = loadList<string>(vaultsKey(owner));
    setVaults(list);
    setSelected((s) => s ?? list[0] ?? null);
  }, [owner]);

  const refresh = useCallback(async () => {
    if (!selected) return setState(null);
    try {
      setState(await chain.vaultState(selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remember = (vault: string) => {
    if (!owner) return;
    const next = [vault, ...vaults.filter((v) => v !== vault)];
    setVaults(next);
    saveList(vaultsKey(owner), next);
    setSelected(vault);
  };

  async function run(label: string, f: () => Promise<{ hash: string }>) {
    setBusy(label);
    setError(null);
    try {
      const r = await f();
      setLastTx(r.hash);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function scan() {
    if (!owner) return;
    setBusy("Looking for your vaults…");
    try {
      const all = await chain.vaults();
      const mine: string[] = [];
      for (const v of all) {
        const o = scValToNative(await chain.read(v, "owner")) as string;
        if (o === owner) mine.push(v);
      }
      setVaults(mine);
      saveList(vaultsKey(owner), mine);
      setSelected(mine[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function buildPolicy(): Policy {
    if (!StrKey.isValidEd25519PublicKey(form.leader.trim())) throw new Error("Enter the leader's G... address.");
    const usdc = deployment.assets.USDC!;
    const xlm = deployment.assets.XLM!;
    const venue = deployment.venues[0]!;
    return {
      leader: form.leader.trim(),
      assets: [
        { token: usdc.token, symbol: "USDC", decimals: usdc.decimals },
        { token: xlm.token, symbol: "XLM", decimals: xlm.decimals },
      ],
      venues: [{ pool: venue.pool, tokens: venue.tokens }],
      maxTradeBps: Math.round(Number(form.maxTradePct) * 100),
      maxTradeUsd: parseAmount(form.maxTradeUsd),
      maxDailyUsd: parseAmount(form.maxDailyUsd),
      maxDailyTrades: Number(form.maxDailyTrades),
      maxSlippageBps: Math.round(Number(form.slippagePct) * 100),
      maxSignalAgeSecs: 3_600n,
      maxOracleAgeSecs: 900n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + Number(form.days) * 86_400),
    };
  }

  const create = () =>
    run("Creating your vault…", async () => {
      const policy = buildPolicy();
      const r = await chain.invoke(owner!, wallet.signer, deployment.contracts.vaultFactory, "create_vault", [
        new Address(owner!).toScVal(),
        policyToScVal(policy),
      ]);
      remember(scValToNative(r.returnValue!) as string);
      return r;
    });

  const token = () => deployment.assets[asset]!.token;
  const deposit = () =>
    run("Depositing…", () =>
      chain.invoke(owner!, wallet.signer, selected!, "deposit", [
        new Address(owner!).toScVal(),
        new Address(token()).toScVal(),
        nativeToScVal(parseAmount(amount), { type: "i128" }),
      ]),
    );
  const withdraw = () =>
    run("Withdrawing…", () =>
      chain.invoke(owner!, wallet.signer, selected!, "withdraw", [
        new Address(token()).toScVal(),
        nativeToScVal(parseAmount(amount), { type: "i128" }),
        new Address(owner!).toScVal(),
      ]),
    );
  const togglePause = () => run(state?.paused ? "Resuming…" : "Pausing…", () => chain.invoke(owner!, wallet.signer, selected!, state?.paused ? "unpause" : "pause"));

  const set = (k: keyof ReturnType<typeof defaultPolicyForm>) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid">
      <WalletBar address={wallet.address} error={wallet.error} connect={wallet.connect} />

      <Card title="Your vaults" aside={owner && <button className="btn btn-small" onClick={scan} disabled={!!busy}>Find on-chain</button>}>
        {vaults.length === 0 ? (
          <p className="muted">No vault yet. Create one below.</p>
        ) : (
          <div className="chips">
            {vaults.map((v) => (
              <button key={v} className={v === selected ? "chip chip-on" : "chip"} onClick={() => setSelected(v)}>
                {v.slice(0, 8)}…
              </button>
            ))}
          </div>
        )}
      </Card>

      {state && (
        <Card title="Vault" aside={state.paused ? <Pill tone="warn">paused</Pill> : <Pill tone="ok">copying</Pill>}>
          <Row k="Address">
            <Addr value={state.vault} />
          </Row>
          <Row k="Follows">
            <Addr value={state.policy.leader} kind="account" />
          </Row>
          {Object.entries(state.balances).map(([t, b]) => (
            <Row key={t} k={`${symbolFor(t)} balance`}>
              {fmt(b)}
            </Row>
          ))}
          <Row k="Per trade">
            up to {state.policy.maxTradeBps / 100}% of balance and ${fmt(state.policy.maxTradeUsd, 2)}
          </Row>
          <Row k="Per 24 hours">
            {state.policy.maxDailyTrades} trades, ${fmt(state.policy.maxDailyUsd, 2)}
          </Row>
          <Row k="Oracle band">{state.policy.maxSlippageBps / 100}% below the Reflector price</Row>
          <Row k="Delegation ends">{new Date(Number(state.policy.expiresAt) * 1000).toLocaleString()}</Row>
          <Row k="Trades in last 24h">
            {state.recent.length} (${fmt(state.recent.reduce((a, m) => a + m.usd, 0n), 2)})
          </Row>
          <div className="actions">
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              {Object.keys(deployment.assets).map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="amount" />
            <button className="btn" onClick={deposit} disabled={!!busy || !owner}>
              Deposit
            </button>
            <button className="btn" onClick={withdraw} disabled={!!busy || state.owner !== owner}>
              Withdraw
            </button>
            <button className="btn" onClick={togglePause} disabled={!!busy || state.owner !== owner}>
              {state.paused ? "Resume" : "Pause"}
            </button>
          </div>
          <p className="muted small">
            Only you can withdraw, change limits or pause. The enclave can only authorize a swap that fits these limits, on the
            allowlisted Aquarius pool. Test USDC: Circle&apos;s faucet (faucet.circle.com), Stellar Testnet.
          </p>
        </Card>
      )}

      <Card title="Create a vault">
        <div className="form">
          <Field label="Leader to follow" hint="The leader's G... account.">
            <input value={form.leader} onChange={set("leader")} placeholder="G..." />
          </Field>
          <Field label="Max per trade, % of balance">
            <input type="number" value={form.maxTradePct} onChange={set("maxTradePct")} />
          </Field>
          <Field label="Max per trade, USD">
            <input value={form.maxTradeUsd} onChange={set("maxTradeUsd")} />
          </Field>
          <Field label="Max per 24 hours, USD">
            <input value={form.maxDailyUsd} onChange={set("maxDailyUsd")} />
          </Field>
          <Field label="Max trades per 24 hours">
            <input type="number" value={form.maxDailyTrades} onChange={set("maxDailyTrades")} />
          </Field>
          <Field label="Oracle band, %" hint="How far below the Reflector price a trade may fill, fee included. The demo pool charges 1%.">
            <input type="number" value={form.slippagePct} onChange={set("slippagePct")} />
          </Field>
          <Field label="Delegation length, days">
            <input type="number" value={form.days} onChange={set("days")} />
          </Field>
        </div>
        <button className="btn btn-primary" onClick={create} disabled={!owner || !!busy}>
          Create vault
        </button>
        <p className="muted small">
          Assets: Circle USDC and XLM. Venue: Aquarius pool <Addr value={deployment.venues[0]!.pool} />. Limits are in USD at the
          Reflector price (1 USD = {USD.toString().length - 1} decimals on-chain).
        </p>
      </Card>

      {busy && <Notice tone="info">{busy}</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {lastTx && (
        <Notice tone="ok">
          Confirmed: <TxLink hash={lastTx} />
        </Notice>
      )}
    </div>
  );
}
