import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Lock, Eye, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sigmax — Confidential copy-trading" },
      {
        name: "description",
        content: "Copy verified traders. Your funds stay in your vault. The strategy stays secret.",
      },
      { property: "og:title", content: "Sigmax — Confidential copy-trading" },
      {
        property: "og:description",
        content: "Copy verified traders. Your funds stay in your vault. The strategy stays secret.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 py-20 md:py-28">
        <h1 className="max-w-3xl text-5xl font-semibold tracking-tight md:text-6xl">
          Copy verified traders.{" "}
          <span className="text-muted-foreground">Without trusting them.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
          Sigmax lets traders publish encrypted signals and followers auto-copy them inside their
          own vault. The strategy stays secret. Your funds never move out of your wallet's control.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/leaderboard">
              Browse leaders <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/leader">Become a leader</Link>
          </Button>
        </div>
      </section>

      {/* Trust pillars */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto grid max-w-6xl gap-px bg-border px-0 md:grid-cols-3">
          <Pillar
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Funds stay in your vault"
            body="The agent can only swap within your token list + caps. It can never withdraw. Revoke anytime."
          />
          <Pillar
            icon={<Lock className="h-5 w-5" />}
            title="Strategy stays secret"
            body="Signals are client-side encrypted before broadcast. Followers see results — never thresholds."
          />
          <Pillar
            icon={<Eye className="h-5 w-5" />}
            title="Track record is verifiable"
            body="Every signal is committed on-chain before its outcome is known. No cherry-picking."
          />
        </div>
      </section>
    </main>
  );
}

function Pillar({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-background p-8">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
        {icon}
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
