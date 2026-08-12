import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TxButton } from "./TxButton";
import { cn } from "@/lib/utils";
import { useHlMarkets } from "@/hooks/hyperliquid";
import { displayName, type MarketInfo } from "@/lib/hyperliquid/markets";
import type { SignalVenueT } from "@sigmax/shared";
import { VenueSummary, asBadgeVenue, type BadgeVenue } from "./VenueBadge";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  ExternalLink,
  Lock,
  ShieldCheck,
} from "lucide-react";

export interface PublishSignalFormProps {
  /** Tokens selectable for the on-chain venues; must be a subset of what the vault whitelists. */
  tokenOptions: { symbol: string; address: string }[];
  /** Symbol of the Flare quote leg (the Coston2 stablecoin); shown in the Quote box and market label. */
  flareQuoteSymbol?: string;
  publishing: boolean;
  lastPublished?: { signalId: string; at: string; proofs: { label: string; url: string }[] };
  onPublish: (v: {
    action: "ENTRY" | "EXIT";
    venue: SignalVenueT;
    token: string;
    quoteToken?: string;
    sizePercent: number;
    maxEntryPrice?: string;
    takeProfitPrice?: string;
    stopLossPrice?: string;
    slippagePercent: number;
    expiresInHours: number;
  }) => Promise<void>;
}

const initialState = {
  action: "ENTRY" as "ENTRY" | "EXIT",
  venue: "flare" as SignalVenueT,
  orderType: "MARKET" as "MARKET" | "LIMIT",
  token: "", // arbitrum: address; hyperliquid: raw base token name (e.g. "USOL")
  quoteToken: "", // hyperliquid: raw quote token name (e.g. "USDC"); arbitrum: defaults to USDC
  sizePercent: 5,
  maxEntryPrice: "",
  takeProfitPrice: "",
  stopLossPrice: "",
  slippagePercent: 1,
  expiresInHours: 24,
};

/**
 * The venues this extension actually executes. Arbitrum is deliberately absent: the enclave rejects it,
 * so offering it would let a leader publish a signal that can never fill. A venue list is a promise
 * about what will execute, not a menu of everything the schema can encode.
 */
const VENUES: { value: BadgeVenue; label: string }[] = [
  { value: "flare", label: "Flare (FXRP)" },
  { value: "hyperliquid", label: "Hyperliquid" },
];

const EXPIRY_PRESETS = [6, 24, 48] as const;

/** Accessible segmented control: radio semantics + visible focus, active option in solid ink. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === o.value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small uppercase rhythm marker separating the form's three concerns. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function PublishSignalForm({
  tokenOptions,
  flareQuoteSymbol = "USDT0",
  lastPublished,
  onPublish,
}: PublishSignalFormProps) {
  const [s, setS] = useState(initialState);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    if (!s.token) e.token = "Pick a token";
    if (s.sizePercent < 1 || s.sizePercent > 20) e.sizePercent = "1–20%";
    for (const k of ["maxEntryPrice", "takeProfitPrice", "stopLossPrice"] as const) {
      if (s[k] && Number(s[k]) < 0) e[k] = "Must be ≥ 0";
    }
    // A limit order needs a price; a market order fills at the current price.
    if (s.action === "ENTRY" && s.orderType === "LIMIT" && !(Number(s.maxEntryPrice) > 0)) {
      e.maxEntryPrice = "Enter a limit price";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handle() {
    if (!validate()) throw new Error("Fix validation errors");
    await onPublish({
      action: s.action,
      venue: s.venue,
      token: s.token,
      quoteToken: s.venue === "hyperliquid" ? s.quoteToken || undefined : undefined,
      sizePercent: s.sizePercent,
      // MARKET → no price cap (fills now); LIMIT → the entry price cap.
      maxEntryPrice:
        s.action === "ENTRY" && s.orderType === "LIMIT" ? s.maxEntryPrice || undefined : undefined,
      takeProfitPrice: s.takeProfitPrice || undefined,
      stopLossPrice: s.stopLossPrice || undefined,
      slippagePercent: s.slippagePercent,
      expiresInHours: s.expiresInHours,
    });
    // Clear secret fields immediately. Do NOT persist or log.
    setS((prev) => ({
      ...prev,
      maxEntryPrice: "",
      takeProfitPrice: "",
      stopLossPrice: "",
    }));
  }

  // The on-chain quote leg differs per venue: FXRP trades against the Coston2 stablecoin, Arbitrum
  // against USDC. Hyperliquid carries its own quote in the selected market.
  const quoteSymbol = s.venue === "flare" ? flareQuoteSymbol : "USDC";

  // Human market label for the preview/summary ("SOL/USDC"), from either venue's raw token fields.
  const marketLabel = s.token
    ? s.venue === "hyperliquid"
      ? `${displayName(s.token)}/${s.quoteToken ? displayName(s.quoteToken) : "?"}`
      : `${tokenOptions.find((t) => t.address === s.token)?.symbol ?? "?"}/${quoteSymbol}`
    : "";
  const limitRuleSet = s.action === "ENTRY" && s.orderType === "LIMIT" && Boolean(s.maxEntryPrice);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Publish signal</CardTitle>
        <CardDescription>
          Encrypted before broadcast — followers can never see your TP/SL.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="lg:grid lg:grid-cols-[1fr_264px] lg:gap-8">
          <div className="space-y-5">
            <SectionLabel>Trade</SectionLabel>

            {/* Action */}
            <div className="space-y-1.5">
              <Label>Action</Label>
              <div>
                <Segmented
                  label="Action"
                  value={s.action}
                  onChange={(action) => setS({ ...s, action })}
                  options={[
                    {
                      value: "ENTRY",
                      label: "ENTRY",
                      icon: <ArrowUpRight className="h-3.5 w-3.5 text-success" aria-hidden />,
                    },
                    {
                      value: "EXIT",
                      label: "EXIT",
                      icon: <ArrowDownRight className="h-3.5 w-3.5 text-danger" aria-hidden />,
                    },
                  ]}
                />
              </div>
            </div>

            {/* Venue — where this swap executes (per-signal). */}
            <div className="space-y-1.5">
              <Label>Execute on</Label>
              <div>
                <Segmented
                  label="Execution venue"
                  value={s.venue}
                  // Switching venue clears the market: an Arbitrum address isn't a valid HL pair.
                  onChange={(venue) => setS({ ...s, venue, token: "", quoteToken: "" })}
                  options={VENUES}
                />
              </div>
              {/* Restating where this settles and what enforces it, at the moment of choosing —
                  the two venues do not offer the same guarantee, so the choice is not cosmetic. */}
              {asBadgeVenue(s.venue) && <VenueSummary venue={asBadgeVenue(s.venue)!} />}
            </div>

            {/* Market / token */}
            {s.venue === "hyperliquid" ? (
              <div className="space-y-1.5">
                <Label>Market</Label>
                <HlPairCombobox
                  base={s.token}
                  quote={s.quoteToken}
                  onSelect={(m) => setS({ ...s, token: m.baseToken, quoteToken: m.quoteToken })}
                />
                {errors.token && <p className="text-xs text-danger">{errors.token}</p>}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Token</Label>
                  <Select value={s.token} onValueChange={(v) => setS({ ...s, token: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {tokenOptions.map((t) => (
                        <SelectItem key={t.address} value={t.address}>
                          {t.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.token && <p className="text-xs text-danger">{errors.token}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>Quote</Label>
                  <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
                    {quoteSymbol}
                  </div>
                </div>
              </div>
            )}

            {/* Size */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Size</Label>
                <span className="font-mono text-sm tabular-nums">{s.sizePercent}%</span>
              </div>
              <Slider
                value={[s.sizePercent]}
                onValueChange={(v) => setS({ ...s, sizePercent: v[0] })}
                min={1}
                max={20}
                step={1}
              />
              <p className="text-xs text-muted-foreground">
                {s.sizePercent}% of each follower's vault goes into this trade.
              </p>
            </div>

            {/* Order type — only relevant for entries */}
            {s.action === "ENTRY" && (
              <div className="space-y-1.5">
                <Label>Order type</Label>
                <div>
                  <Segmented
                    label="Order type"
                    value={s.orderType}
                    onChange={(orderType) => setS({ ...s, orderType })}
                    options={[
                      { value: "MARKET", label: "Market" },
                      { value: "LIMIT", label: "Limit" },
                    ]}
                  />
                </div>
                {s.orderType === "MARKET" ? (
                  <p className="text-xs text-muted-foreground">
                    Fills immediately at the current price.
                  </p>
                ) : (
                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="limit-price">Limit price (USD)</Label>
                    <Input
                      id="limit-price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={s.maxEntryPrice}
                      onChange={(e) => setS({ ...s, maxEntryPrice: e.target.value })}
                      placeholder="e.g. 70.00"
                    />
                    {errors.maxEntryPrice && (
                      <p className="text-xs text-danger">{errors.maxEntryPrice}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Secret block — the product's core: these fields never leave the browser in plaintext. */}
            <div className="space-y-3 rounded-lg border border-primary/25 bg-accent/30 p-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-accent-foreground">
                <Lock className="h-3.5 w-3.5 text-primary" aria-hidden />
                Confidential — encrypted in your browser, never visible to followers
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="tp">Take profit (USD)</Label>
                  <Input
                    id="tp"
                    type="number"
                    min="0"
                    step="0.01"
                    value={s.takeProfitPrice}
                    onChange={(e) => setS({ ...s, takeProfitPrice: e.target.value })}
                    placeholder="—"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sl">Stop loss (USD)</Label>
                  <Input
                    id="sl"
                    type="number"
                    min="0"
                    step="0.01"
                    value={s.stopLossPrice}
                    onChange={(e) => setS({ ...s, stopLossPrice: e.target.value })}
                    placeholder="—"
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>

            <SectionLabel>Execution</SectionLabel>

            {/* Slippage / expiry */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="slip">Slippage %</Label>
                <Input
                  id="slip"
                  type="number"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={s.slippagePercent}
                  onChange={(e) => setS({ ...s, slippagePercent: Number(e.target.value) })}
                />
                {errors.slippagePercent && (
                  <p className="text-xs text-danger">{errors.slippagePercent}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exp">Expires in (hours)</Label>
                <div className="flex items-center gap-1.5">
                  {EXPIRY_PRESETS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => setS({ ...s, expiresInHours: h })}
                      aria-pressed={s.expiresInHours === h}
                      className={cn(
                        "rounded-md border px-2 py-1.5 font-mono text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        s.expiresInHours === h
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {h}h
                    </button>
                  ))}
                  <Input
                    id="exp"
                    type="number"
                    min="1"
                    className="h-8 flex-1"
                    value={s.expiresInHours}
                    onChange={(e) => setS({ ...s, expiresInHours: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>

            {/* Pre-broadcast review — on lg the preview rail plays this role. */}
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground lg:hidden">
              Broadcasting <span className="font-medium text-foreground">{s.action}</span>
              {marketLabel && <> · <span className="font-mono">{marketLabel}</span></>} ·{" "}
              {s.sizePercent}% · expires {s.expiresInHours}h · TP/SL sealed
            </div>

            <TxButton
              label="Publish signal"
              pendingLabel="Encrypting & publishing…"
              onClick={handle}
            />

            {lastPublished && (
              <div className="flex items-center justify-between rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
                <span className="inline-flex items-center gap-1.5 text-success">
                  <Check className="h-4 w-4" /> Published
                  <span className="text-muted-foreground">
                    · {new Date(lastPublished.at).toLocaleTimeString()}
                  </span>
                </span>
                {lastPublished.proofs.length > 0 && (
                  <div className="flex items-center gap-3">
                    {lastPublished.proofs.map((p) => (
                      <a
                        key={p.url}
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {p.label} <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Live "what followers see" — the confidentiality guarantee, shown at the moment it matters.
              Mirrors the form state; aria-hidden because every value it shows is already in the form. */}
          <aside className="hidden lg:block" aria-hidden>
            <div className="sticky top-20">
              <FollowerPreview
                action={s.action}
                marketLabel={marketLabel}
                sizePercent={s.sizePercent}
                tpSet={Boolean(s.takeProfitPrice)}
                slSet={Boolean(s.stopLossPrice)}
                limitRuleSet={limitRuleSet}
              />
            </div>
          </aside>
        </div>
      </CardContent>
    </Card>
  );
}

/** The follower's view of this signal: outcome fields visible, strategy fields sealed. */
function FollowerPreview({
  action,
  marketLabel,
  sizePercent,
  tpSet,
  slSet,
  limitRuleSet,
}: {
  action: "ENTRY" | "EXIT";
  marketLabel: string;
  sizePercent: number;
  tpSet: boolean;
  slSet: boolean;
  limitRuleSet: boolean;
}) {
  const rows: { label: string; sealed: boolean }[] = [
    { label: "Take profit", sealed: tpSet },
    { label: "Stop loss", sealed: slSet },
    { label: "Entry rule", sealed: limitRuleSet },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" /> What followers see
      </div>
      <div className="rounded-xl border border-border bg-muted/20 p-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Signal</div>
            <div className="mt-1 font-mono text-base font-semibold">
              <span className={action === "ENTRY" ? "text-success" : "text-danger"}>
                {action === "ENTRY" ? "BUY" : "SELL"}
              </span>{" "}
              {marketLabel || "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Size</div>
            <div className="mt-1 font-mono text-base tabular-nums">{sizePercent}%</div>
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-dashed border-border bg-background/60 p-3">
          <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Lock className="h-3 w-3 text-primary" /> Sealed until the enclave opens it
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{r.label}</span>
                {r.sealed ? (
                  <span
                    className="encrypted-bar h-2 w-20 overflow-hidden rounded-full bg-muted-foreground/20"
                    style={{ animationDelay: `${i * 500}ms` }}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground/50">—</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Followers copy the trade in their own vaults. Your thresholds stay encrypted end-to-end.
        </p>
      </div>
    </div>
  );
}

const QUOTE_TABS: { id: string; label: string; matches: (q: string) => boolean }[] = [
  { id: "ALL", label: "All", matches: () => true },
  { id: "USDC", label: "USDC", matches: (q) => q === "USDC" },
  { id: "USDT", label: "USDT", matches: (q) => q === "USDT" || q === "USDT0" },
  { id: "USDH", label: "USDH", matches: (q) => q === "USDH" },
];

/**
 * Pair selector over EVERY Hyperliquid spot market, shown as "BASE/QUOTE" — a port of the reference's
 * PairSelectorModal: quote-token tabs, search, volume-sorted. Stores the selected market's raw base +
 * quote token names (what the signal carries and the agent resolves).
 */
function HlPairCombobox({
  base,
  quote,
  onSelect,
}: {
  base: string;
  quote: string;
  onSelect: (m: MarketInfo) => void;
}) {
  const { markets, loading } = useHlMarkets();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("ALL");

  const selected = markets.find((m) => m.baseToken === base && m.quoteToken === quote);
  const displayBase = selected?.displayBase ?? (base ? displayName(base) : "");
  const displayQuote = selected?.displayQuote ?? (quote ? displayName(quote) : "");
  const placeholder = loading ? "Loading markets…" : "Select market…";

  const list = markets
    .filter((m) => QUOTE_TABS.find((t) => t.id === tab)!.matches(m.quoteToken))
    .slice()
    .sort((a, b) =>
      b.dayNtlVlm !== a.dayNtlVlm
        ? b.dayNtlVlm - a.dayNtlVlm
        : a.displaySymbol.localeCompare(b.displaySymbol),
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between font-normal"
        >
          {base ? (
            <span className="flex items-baseline gap-0.5">
              <span className="font-medium text-foreground">{displayBase}</span>
              <span className="text-muted-foreground">/{displayQuote}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <div className="flex items-center gap-1 border-b border-border p-1.5">
          {QUOTE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === t.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Command
          filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Search pairs…" />
          <CommandList className="max-h-72">
            <CommandEmpty>{loading ? "Loading…" : "No pairs found."}</CommandEmpty>
            <CommandGroup>
              {list.map((m) => {
                const active = selected?.wsCoin === m.wsCoin;
                return (
                  <CommandItem
                    key={m.wsCoin}
                    value={`${m.displaySymbol} ${m.baseToken}`} // search by ticker or raw name
                    onSelect={() => {
                      onSelect(m);
                      setOpen(false);
                    }}
                    className="flex items-center gap-2 py-2"
                  >
                    <span className="flex flex-1 items-baseline gap-0.5">
                      <span className="font-medium text-foreground">{m.displayBase}</span>
                      <span className="text-muted-foreground">/{m.displayQuote}</span>
                    </span>
                    <Check
                      className={cn(
                        "h-4 w-4 text-foreground transition-opacity",
                        active ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
