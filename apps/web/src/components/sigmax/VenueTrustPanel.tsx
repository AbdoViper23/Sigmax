import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VenueBadge, VENUE_META, type BadgeVenue } from "./VenueBadge";
import { Ban, FileCheck2, Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What each venue actually guarantees — side by side, in the user's terms.
 *
 * Two venues with different trust models is a fact about the system, and hiding it would make the
 * stronger venue look no better than the weaker one. So this states the difference plainly: on Flare a
 * contract rejects an out-of-bounds trade; on Hyperliquid the enclave's own attested code is what
 * refuses. Both are far stronger than an unverifiable server, and they are not the same, and a user
 * choosing where to put money deserves to know which one they are getting.
 *
 * The one property that holds identically on both is the one that matters most, so it is stated once
 * and unqualified: nothing in either path can withdraw the user's funds.
 *
 * The two planned columns earn their place for the same reason: the claim being made about the
 * roadmap is that adding a venue does NOT weaken any of these guarantees, and a column that reads
 * identically to the live one is the only way to show that rather than assert it. They are rendered
 * unbranded, dimmed, and behind a dashed rule so no reader can mistake a design for a deployment.
 */

/** Venues that are live today — the ones with on-chain evidence behind every cell. */
type PlannedKey = "sui" | "arbitrum";
type ColumnKey = BadgeVenue | PlannedKey;

interface PlannedVenue {
  key: PlannedKey;
  label: string;
  /**
   * Position in the queue. Deliberately "Next" / "After that" rather than "Phase 2" / "Phase 3":
   * a numbered phase reads as a dated commitment and invites the question of which phase we are in
   * now, while the ordering is the only thing we actually want to convey.
   */
  when: string;
}

const PLANNED: PlannedVenue[] = [
  { key: "sui", label: "Sui DeepBook", when: "Next" },
  { key: "arbitrum", label: "Arbitrum Uniswap", when: "After that" },
];

interface Row {
  icon: typeof ShieldCheck;
  label: string;
  cells: Record<ColumnKey, string>;
}

const ROWS: Row[] = [
  {
    icon: Lock,
    label: "Who can read the strategy",
    cells: {
      flare: "Only the enclave",
      hyperliquid: "Only the enclave",
      sui: "Only the enclave",
      arbitrum: "Only the enclave",
    },
  },
  {
    icon: FileCheck2,
    label: "What enforces the limits",
    cells: {
      flare: "Your vault contract, on-chain",
      hyperliquid: "Attested enclave code",
      // Move has objects where the EVM has contracts; the guarantee is the same, the noun is not.
      sui: "Your vault object, on-chain",
      arbitrum: "Your vault contract, on-chain",
    },
  },
  {
    icon: ShieldCheck,
    label: "How you can verify it",
    cells: {
      flare: "Anyone can check the signature",
      hyperliquid: "Check the published code hash",
      sui: "Anyone can check the signature",
      arbitrum: "Anyone can check the signature",
    },
  },
  {
    icon: Ban,
    label: "Can anything withdraw your funds",
    cells: {
      flare: "No — only you",
      hyperliquid: "No — the exchange forbids it",
      sui: "No — only you",
      arbitrum: "No — only you",
    },
  },
];

/** Column header for a venue that is designed but not deployed. Unbranded on purpose. */
function PlannedHeader({ venue }: { venue: PlannedVenue }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {venue.label}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{venue.when}</span>
    </span>
  );
}

export function VenueTrustPanel({
  venues = ["flare", "hyperliquid"],
  /**
   * Drop the card's own title and description. Set this where the surrounding page already introduces
   * the comparison — on the landing page the section heading says the same thing, and repeating it two
   * lines later is the kind of duplication that makes a page feel machine-assembled.
   */
  bare = false,
}: {
  venues?: BadgeVenue[];
  bare?: boolean;
}) {
  /** The rule that separates shipped from planned. Applied to the first planned column only. */
  const splitCell = (i: number) =>
    cn("py-3 pr-4 align-top text-muted-foreground", i === 0 && "border-l border-dashed border-border pl-4");

  return (
    <Card>
      {!bare && (
        <CardHeader>
          <CardTitle>Where your trades run</CardTitle>
          <CardDescription>
            Two venues, one enclave. The strategy stays sealed on both — what differs is what stops a
            bad trade.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={bare ? "pt-6" : undefined}>
        {/* A table, because the whole point is a column-by-column comparison. Scrolls inside itself on
            narrow screens so the page body never scrolls sideways. */}
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <caption className="sr-only">
              Comparison of confidentiality, enforcement, verification and withdrawal guarantees per
              execution venue, for the two live venues and the two planned ones
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4 text-left font-medium text-muted-foreground">
                  Property
                </th>
                {venues.map((v) => (
                  <th key={v} scope="col" className="py-2 pr-4 text-left">
                    <VenueBadge venue={v} />
                  </th>
                ))}
                {PLANNED.map((p, i) => (
                  <th
                    key={p.key}
                    scope="col"
                    className={cn(
                      "py-2 pr-4 text-left",
                      i === 0 && "border-l border-dashed border-border pl-4",
                    )}
                  >
                    <PlannedHeader venue={p} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const Icon = row.icon;
                return (
                  <tr key={row.label} className="border-b border-border/60 last:border-0">
                    <th
                      scope="row"
                      className="py-3 pr-4 text-left font-normal text-muted-foreground align-top"
                    >
                      <span className="flex items-start gap-2">
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        {row.label}
                      </span>
                    </th>
                    {venues.map((v) => (
                      <td key={v} className="py-3 pr-4 align-top">
                        {row.cells[v]}
                      </td>
                    ))}
                    {PLANNED.map((p, i) => (
                      <td key={p.key} className={splitCell(i)}>
                        {row.cells[p.key]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          {venues.map((v) => VENUE_META[v].label).join(" and ")} share the same encrypted signal and the
          same enclave. Only settlement differs.
        </p>
        {/* The planned columns are a claim about the design, not about a deployment. Say which. */}
        <p className="mt-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {PLANNED.map((p) => p.label).join(" and ")}
          </span>{" "}
          are not deployed yet — their columns show the guarantees they inherit unchanged, which is the
          point: a new venue changes where a trade settles, never who can read it or who can move your
          funds.
        </p>
      </CardContent>
    </Card>
  );
}
