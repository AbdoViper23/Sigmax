import { useEffect, useState } from "react";

import { chain, deployment, fmt, relay } from "../env";
import { Addr, Card, Notice, Pill, Row } from "../ui";

interface RelayHealth {
  enclave: { signing_key?: string; error?: string };
}

interface Status {
  signingKey: string | null;
  relayKey: string | null;
  relayError: string | null;
  pool?: { usdc: bigint; xlm: bigint; feeBps: number };
  poolPrice?: number;
  oraclePrice?: number;
  error?: string;
}

export function Overview() {
  const [s, setS] = useState<Status | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const venue = deployment.venues[0]!;
        const [key, health, pool, oracle] = await Promise.all([
          chain.enclaveSigningKey(),
          relay<RelayHealth>("/health").catch((e: Error): RelayHealth => ({ enclave: { error: e.message } })),
          chain.poolState(venue.pool),
          chain.oracleState(["USDC", "XLM"]),
        ]);
        const [usdc, xlm] = pool.reserves as [bigint, bigint];
        setS({
          signingKey: key ? Buffer.from(key).toString("hex") : null,
          relayKey: health.enclave.signing_key ?? null,
          relayError: health.enclave.error ?? null,
          pool: { usdc, xlm, feeBps: pool.feeBps },
          poolPrice: Number(usdc) / Number(xlm),
          oraclePrice: Number(oracle.prices.XLM!.price) / Number(oracle.prices.USDC!.price),
        });
      } catch (e) {
        setS({ signingKey: null, relayKey: null, relayError: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  const keysMatch = s?.signingKey && s.signingKey === s.relayKey;
  const deviation = s?.poolPrice && s.oraclePrice ? ((s.poolPrice - s.oraclePrice) / s.oraclePrice) * 100 : undefined;

  return (
    <div className="grid">
      <section className="hero">
        <h1>Copy a trader without seeing their strategy</h1>
        <p>
          A leader&apos;s signal is sealed in their browser to a secure enclave. Only its hash goes on-chain. The enclave sizes each
          follower&apos;s trade, and every swap runs from the follower&apos;s own Soroban vault, inside limits only the follower can
          change.
        </p>
        <ol className="steps">
          <li>
            <b>Seal.</b> The leader encrypts the signal to the enclave key read from the Enclave Registry.
          </li>
          <li>
            <b>Commit.</b> The leader&apos;s wallet stores the signal&apos;s hash in the Signal Registry before any trade.
          </li>
          <li>
            <b>Copy.</b> The enclave signs one swap per vault; each vault re-checks the signature, its limits and the Reflector price
            on-chain, then trades on Aquarius.
          </li>
        </ol>
      </section>

      <Card title="Enclave" aside={s && (keysMatch ? <Pill tone="ok">registered</Pill> : <Pill tone="warn">check</Pill>)}>
        <Row k="Mode">
          <Pill tone="info">software, Testnet only</Pill>
        </Row>
        <Row k="Registry key">{s?.signingKey ? <span className="mono">{s.signingKey.slice(0, 16)}…</span> : "none registered"}</Row>
        <Row k="Relay reaches it">
          {s ? (s.relayKey ? (keysMatch ? "yes, same key" : "yes, but a different key") : `no (${s.relayError ?? "offline"})`) : "…"}
        </Row>
        <p className="muted small">
          Tranche 2 moves the enclave into an attested confidential VM. Until then, signals are confidential from the chain and the
          relay, not from the operator.
        </p>
      </Card>

      <Card title="Venue" aside={deviation !== undefined && (Math.abs(deviation) < 1 ? <Pill tone="ok">aligned</Pill> : <Pill tone="warn">drifted</Pill>)}>
        <Row k="Aquarius pool">
          <Addr value={deployment.venues[0]!.pool} />
        </Row>
        {s?.pool && (
          <>
            <Row k="Reserves">
              {fmt(s.pool.usdc, 0)} USDC / {fmt(s.pool.xlm, 0)} XLM
            </Row>
            <Row k="Fee">{s.pool.feeBps / 100}%</Row>
            <Row k="Pool price">{s.poolPrice?.toFixed(5)} USDC per XLM</Row>
            <Row k="Reflector price">{s.oraclePrice?.toFixed(5)} USDC per XLM</Row>
            <Row k="Difference">{deviation?.toFixed(2)}%</Row>
          </>
        )}
        <p className="muted small">Vaults refuse any swap whose minimum output is worse than the Reflector price minus their slippage limit.</p>
      </Card>

      <Card title="Contracts (Testnet)">
        <Row k="Signal Registry">
          <Addr value={deployment.contracts.signalRegistry} />
        </Row>
        <Row k="Enclave Registry">
          <Addr value={deployment.contracts.enclaveRegistry} />
        </Row>
        <Row k="Vault factory">
          <Addr value={deployment.contracts.vaultFactory} />
        </Row>
        <Row k="Oracle (Reflector)">
          <Addr value={deployment.oracle} />
        </Row>
        <Row k="USDC (Circle)">
          <Addr value={deployment.assets.USDC!.token} />
        </Row>
      </Card>

      {s?.error && <Notice tone="bad">Could not read Testnet: {s.error}</Notice>}
    </div>
  );
}
