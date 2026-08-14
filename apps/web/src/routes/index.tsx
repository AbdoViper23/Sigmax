import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignalChart } from "@/components/sigmax/SignalChart";
import { VenueTrustPanel } from "@/components/sigmax/VenueTrustPanel";
import { EncryptionTheatre } from "@/components/sigmax/EncryptionTheatre";
import { useReveal, useRevealGroup } from "@/hooks/useReveal";
import { cn } from "@/lib/utils";

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
  // Scroll-reveal groups. Each ref staggers its own direct children; content stays visible without JS
  // and for reduced-motion users (see useReveal).
  const steps = useRevealGroup<HTMLOListElement>();
  const pillars = useRevealGroup();
  const audiences = useRevealGroup();
  const venuePanel = useReveal();

  return (
    <main>
      {/* ---------- Hero ---------- */}
      {/* `relative` + `isolate` so the aurora sits behind this section's content and cannot bleed over
          the next one. The colour in this design lives here, not in the semantic tokens. */}
      <section className="relative isolate overflow-hidden">
        <div className="aurora" aria-hidden>
          <div className="aurora-blob aurora-blob-1" />
          <div className="aurora-blob aurora-blob-2" />
          <div className="aurora-blob aurora-blob-3" />
        </div>

        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:grid-cols-[1.05fr_0.95fr] md:py-24">
        <div>
          {/* No eyebrow pill above the headline. "Confidential copy-trading on Flare" restated the
              tagline the nav and the <title> already carry, and a bordered capsule announcing your own
              category is the most generic thing a landing page can open with. The headline is stronger
              standing alone. */}
          <h1
            className="max-w-xl animate-enter text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl"
          >
            Copy verified traders.{" "}
            {/* The gradient lands on the clause that carries the whole proposition. */}
            <span className="text-gradient">Without trusting them.</span>
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
        </div>
      </section>

      {/* ---------- The path a signal takes ---------- */}
      {/*
        Rebuilt to stop reading like a template. What went: the "How it works" eyebrow, an alliterative
        title ("Confidential from signal to swap"), 01–04 counters, and a tinted icon chip per step —
        that exact combination is the house style of every generated landing page, and it says nothing.

        What replaced it: the actual handoffs, named. Real components (`InstructionSender`,
        `CopyVaultFlare`), the real oracle, the real DEX. A reader who knows the stack can check these;
        a reader who doesn't still learns where their money goes. Specificity is what generic copy
        cannot fake.
      */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
            The strategy is readable in exactly one place.
          </h2>
          <p className="mt-3 max-w-[65ch] text-muted-foreground">
            Follow a signal from the leader's keyboard to your balance. It is plaintext for the length of
            one function call, inside hardware neither of you controls.
          </p>

          <ol ref={steps} className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            <Stage
              where="the leader's browser"
              tint="primary"
              title="Encrypted before it leaves"
              body="The signal is sealed to the enclave's public key on the leader's own machine. No server receives the plaintext, because no server is in the path."
            />
            <Stage
              where="InstructionSender · Coston2"
              tint="flare"
              title="Published as ciphertext"
              body="One transaction the leader signs carries the opaque bytes and commits their hash — so the record exists before the outcome does."
            />
            <Stage
              where="the enclave"
              tint="hyperliquid"
              title="Opened once, to act"
              body="Attested code decrypts, sizes the trade against each subscriber's balance, bounds the price with the FTSO feed, and signs an authorization. Nothing else can open it."
            />
            <Stage
              where="CopyVaultFlare · your vault"
              tint="success"
              title="Verified on-chain, then swapped"
              body="Your vault checks the enclave's signature itself before moving a token. You get the fill; the thresholds behind it never existed outside the enclave."
            />
          </ol>
        </div>
      </section>

      {/* ---------- Guarantees ---------- */}
      {/* Same treatment as the section above: the eyebrow + "Three guarantees, enforced by design" +
          icon-chip pattern is dropped. Counting your own guarantees in the heading adds nothing the
          three cards below don't already show. */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:py-20">
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
          Each promise is kept by something other than us.
        </h2>
        <div ref={pillars} className="mt-10 grid gap-4 md:grid-cols-3">
          <Pillar
            kept="by your vault contract"
            title="Funds stay in your vault"
            body="Swaps are confined to your token list and your per-trade cap. Withdrawal is owner-only, so the enclave and the keeper both lack the ability — not merely the permission."
          />
          <Pillar
            kept="by encrypting client-side"
            title="Strategy stays secret"
            body="The signal is sealed on the leader's machine, so there is no server that could leak it, be subpoenaed for it, or be breached for it."
          />
          <Pillar
            kept="by publish order"
            title="Track record is verifiable"
            body="The commitment hash lands on-chain before the outcome is known. A losing signal cannot be quietly withdrawn from the history afterwards."
          />
        </div>
      </section>

      {/* ---------- Venues ---------- */}
      {/* The dual-venue story belongs on the landing page, not buried in the dashboard: "one enclave,
          two venues" is the architectural claim, and stating the difference in guarantee openly is more
          convincing than implying they are identical. */}
      <section className="border-t border-border">
        {/* max-w-6xl to match every other section — and because the venue table now has five columns,
            which do not fit a 3xl measure without a sideways scroll. The heading and lede keep their
            own narrower max-widths, so the reading measure is unchanged. */}
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-20">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">
            Two venues live. We'll tell you which one is stronger.
          </h2>
          <p className="mt-3 max-w-[65ch] text-muted-foreground">
            The same sealed signal and the same enclave settle either on-chain or on an order book. On
            Flare a contract refuses a bad trade; on Hyperliquid attested code does. Those are not equal,
            so the table below says so instead of implying they are — and it shows the two venues we're
            adding next, whose columns read the same because a new venue never touches the trust model.
          </p>
          <div ref={venuePanel} className="mt-10">
            <VenueTrustPanel bare />
          </div>
        </div>
      </section>

      {/* ---------- For leaders / followers ---------- */}
      <section className="border-t border-border bg-card/40">
        <div ref={audiences} className="mx-auto grid max-w-6xl gap-4 px-4 py-16 md:grid-cols-2 md:py-20">
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

/**
 * A leader's confidential track record over 90 days, as a normalized index (100 = start). The hero
 * curve is derived from this, and the headline return is computed from its ends so the number and
 * the line can never drift apart. Illustrative demo data — not a live feed.
 */
const TRACK = [100, 103, 101, 107, 112, 109, 118, 124, 121, 129, 135, 132, 139, 143, 141, 148];

/** Hero visual: a real-looking signal where the strategy is sealed — the product's thesis, shown. */
function SealedSignalCard() {
  const secretRows = ["Take profit", "Stop loss", "Entry rule"];
  const ret = Math.round((TRACK[TRACK.length - 1] / TRACK[0] - 1) * 100);
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

      {/* Verified performance: visible and animated — the result a follower copies. */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Verified return · 90d
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums text-success">+{ret}%</span>
        </div>
        <SignalChart values={TRACK} className="mt-2" />
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

      {/* Replaces three shimmering placeholder bars. Those said "something is hidden"; this shows the
          actual transformation — real values becoming ciphertext — which is the claim itself. */}
      <EncryptionTheatre className="mt-5" />
    </div>
  );
}


/**
 * One handoff in a signal's path.
 *
 * No counter and no icon chip, on purpose. `01 02 03 04` beside a rounded icon square is the visual
 * signature of filler content, and neither element carried information here — the ORDER is already
 * given by reading order, and a key glyph next to "encrypted" only restates the word beside it.
 *
 * What does the work instead is `where`: the actual component or machine the step happens on, in mono,
 * above a coloured rule. That is a fact a reader can verify, and it is the part a template could not
 * have written.
 */
function Stage({
  where,
  title,
  body,
  tint,
}: {
  where: string;
  title: string;
  body: string;
  tint: "primary" | "hyperliquid" | "flare" | "success";
}) {
  const rules = {
    primary: "bg-primary",
    hyperliquid: "bg-chain-hyperliquid",
    flare: "bg-chain-flare",
    success: "bg-success",
  } as const;
  const labels = {
    primary: "text-primary",
    hyperliquid: "text-chain-hyperliquid",
    flare: "text-chain-flare",
    success: "text-success",
  } as const;

  return (
    <li className="group">
      {/* The rule is the sequence marker: it grows on hover, which is the only motion here and the only
          thing standing in for the deleted counter. */}
      <span
        className={cn(
          "block h-px w-10 origin-left transition-transform duration-300 ease-out group-hover:scale-x-[2]",
          rules[tint],
        )}
        aria-hidden
      />
      <div className={cn("mt-3 font-mono text-[11px] tracking-tight", labels[tint])}>{where}</div>
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </li>
  );
}

/**
 * A guarantee, with the mechanism that enforces it in place of an icon.
 *
 * `kept` is doing what the icon chip was pretending to do. A shield glyph next to "funds stay in your
 * vault" is a mood; "by your vault contract" is the actual answer to the only question a sceptical
 * reader has — who is stopping you. That swap is the whole point of the change.
 */
function Pillar({ kept, title, body }: { kept: string; title: string; body: string }) {
  return (
    <div className="hover-lift rounded-xl border border-border bg-card p-6">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-1 font-mono text-[11px] text-primary">{kept}</div>
      <p className="mt-3 text-sm text-muted-foreground">{body}</p>
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
