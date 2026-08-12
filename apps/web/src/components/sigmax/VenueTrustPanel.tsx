import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VenueBadge, VENUE_META, type BadgeVenue } from "./VenueBadge";
import { Ban, FileCheck2, Lock, ShieldCheck } from "lucide-react";

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
 */

interface Row {
  icon: typeof ShieldCheck;
  label: string;
  flare: string;
  hyperliquid: string;
}

const ROWS: Row[] = [
  {
    icon: Lock,
    label: "Who can read the strategy",
    flare: "Only the enclave",
    hyperliquid: "Only the enclave",
  },
  {
    icon: FileCheck2,
    label: "What enforces the limits",
    flare: "Your vault contract, on-chain",
    hyperliquid: "Attested enclave code",
  },
  {
    icon: ShieldCheck,
    label: "How you can verify it",
    flare: "Anyone can check the signature",
    hyperliquid: "Check the published code hash",
  },
  {
    icon: Ban,
    label: "Can anything withdraw your funds",
    flare: "No — only you",
    hyperliquid: "No — the exchange forbids it",
  },
];

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
          <table className="w-full min-w-[30rem] border-collapse text-sm">
            <caption className="sr-only">
              Comparison of confidentiality, enforcement, verification and withdrawal guarantees per
              execution venue
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
                        {row[v]}
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
      </CardContent>
    </Card>
  );
}
