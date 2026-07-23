import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  EyeOff,
  KeyRound,
  LineChart,
  Lock,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sigmax — Confidential copy-trading" },
      {
        name: "description",
        content:
          "Copy verified traders without seeing — or leaking — their strategy. Signals stay encrypted; execution runs in your own non-custodial vault.",
      },
      { property: "og:title", content: "Sigmax — Confidential copy-trading" },
      {
        property: "og:description",
        content:
          "Copy the result, never the recipe. Encrypted signals, non-custodial execution, verifiable track record — on Flare.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main>
      {/* ---------- Hero ---------- */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:grid-cols-[1.05fr_0.95fr] md:py-24">
        <div>
          <span className="inline-flex animate-enter items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Lock className="h-3 w-3 text-primary" aria-hidden /> Confidential copy-trading on Flare
          </span>
          <h1
            className="mt-5 max-w-xl animate-enter text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl"
            style={{ animationDelay: "60ms" }}
          >
            Copy verified traders.{" "}
            <span className="text-muted-foreground">Without trusting them.</span>
          </h1>
          <p
            className="mt-5 max-w-xl animate-enter text-lg text-muted-foreground"
            style={{ animationDelay: "140ms" }}
          >
            Traders publish <span className="font-medium text-foreground">encrypted</span> signals. A
            secure enclave copies each trade into{" "}
            <span className="font-medium text-foreground">your own vault</span> — you get the result,
            never the recipe, and your funds never leave your control.
          </p>
          <div
            className="mt-8 flex flex-wrap items-center gap-3 animate-enter"
            style={{ animationDelay: "220ms" }}
          >
            <Button asChild size="lg" className="group">
              <Link to="/leaderboard">
                Browse leaders
                <ArrowRight className="ml-1.5 h-4 w-4 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/leader">Become a leader</Link>
            </Button>
          </div>
          <ul
            className="mt-8 flex flex-wrap gap-x-5 gap-y-2 animate-enter text-sm text-muted-foreground"
            style={{ animationDelay: "300ms" }}
          >
            {["Non-custodial", "Strategy stays encrypted", "On-chain track record"].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> {t}
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-enter" style={{ animationDelay: "180ms" }}>
          <SealedSignalCard />
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <SectionHead eyebrow="How it works" title="Confidential from signal to swap" />
          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <Step
              n="01"
              icon={<KeyRound className="h-5 w-5" />}
              title="Publish, encrypted"
              body="The leader's signal is encrypted in the browser before it leaves. No server — not even ours — ever sees the strategy."
            />
            <Step
              n="02"
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Only the enclave decrypts"
              body="A TEE agent, attested on-chain, is the single thing that can open the signal — and only to place the trade."
            />
            <Step
              n="03"
              icon={<Wallet className="h-5 w-5" />}
              title="Executes in your vault"
              body="The swap runs in your own non-custodial vault, within your token list and caps. The agent can never withdraw."
            />
            <Step
              n="04"
              icon={<LineChart className="h-5 w-5" />}
              title="You copy the outcome"
              body="You get the result — never the take-profit, stop-loss, or entry rule. Nothing to screenshot, forward, or resell."
            />
          </ol>
        </div>
      </section>

      {/* ---------- Guarantees ---------- */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <SectionHead eyebrow="Why it holds" title="Three guarantees, enforced by design" />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <Pillar
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Funds stay in your vault"
            body="The agent can only swap within your token list and caps. It can never withdraw. Revoke access anytime."
          />
          <Pillar
            icon={<EyeOff className="h-5 w-5" />}
            title="Strategy stays secret"
            body="Signals are client-side encrypted before broadcast. Followers see results — never the thresholds behind them."
          />
          <Pillar
            icon={<TrendingUp className="h-5 w-5" />}
            title="Track record is verifiable"
            body="Every signal is committed on-chain before its outcome is known. No cherry-picking, no fake histories."
          />
        </div>
      </section>

      {/* ---------- For leaders / followers ---------- */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-16 md:grid-cols-2 md:py-20">
          <ValueCard
            title="For leaders"
            cta={{ to: "/leader", label: "Become a leader" }}
            points={[
              "Sell your signals without them leaking or getting resold.",
              "Build a track record no one can fake — committed on-chain before outcomes.",
              "Earn monthly subscription revenue, split automatically at pay time.",
            ]}
          />
          <ValueCard
            title="For followers"
            cta={{ to: "/leaderboard", label: "Browse leaders" }}
            points={[
              "Copy a verified trader automatically — every trade runs in your own vault.",
              "Never hand over funds, and never trade a strategy that already leaked to everyone.",
              "Non-custodial and revocable: you stay in control the entire time.",
            ]}
          />
        </div>
      </section>

      {/* ---------- Final CTA ---------- */}
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Copy the result. Keep the secret.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Confidential copy-trading, non-custodial by design, verifiable on-chain.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" className="group">
            <Link to="/leaderboard">
              Browse leaders
              <ArrowRight className="ml-1.5 h-4 w-4 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/leader">Become a leader</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

/** Hero visual: a real-looking signal where the strategy is sealed — the product's thesis, shown. */
function SealedSignalCard() {
  const secretRows = ["Take profit", "Stop loss", "Entry rule"];
  return (
    <div className="relative rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-foreground text-sm font-bold text-background">
          A
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            alpha_wolf <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />
          </div>
          <div className="text-xs text-muted-foreground">Verified · 142 signals</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden /> LIVE
        </span>
      </div>

      <div className="mt-5 flex items-end justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Signal</div>
          <div className="mt-1 font-mono text-lg font-semibold">
            BUY <span className="text-primary">$HYPE</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Size</div>
          <div className="mt-1 font-mono text-lg tabular-nums">5%</div>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-dashed border-border bg-muted/30 p-4">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lock className="h-3.5 w-3.5 text-primary" aria-hidden /> Encrypted — only the enclave can
          read this
        </div>
        <div className="space-y-2.5">
          {secretRows.map((label) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="h-2.5 w-28 rounded-full bg-muted-foreground/20" aria-hidden />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-primary">{eyebrow}</div>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
    </div>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="relative">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-accent text-accent-foreground">
          {icon}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{n}</span>
      </div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </li>
  );
}

function Pillar({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function ValueCard({
  title,
  points,
  cta,
}: {
  title: string;
  points: string[];
  cta: { to: "/leader" | "/leaderboard"; label: string };
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-background p-6">
      <h3 className="text-lg font-semibold">{title}</h3>
      <ul className="mt-4 flex-1 space-y-3">
        {points.map((p) => (
          <li key={p} className="flex gap-2.5 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <Button asChild variant="outline" className="group mt-6 self-start">
        <Link to={cta.to}>
          {cta.label}
          <ArrowRight className="ml-1.5 h-4 w-4 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
        </Link>
      </Button>
    </div>
  );
}
