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
import { Lock, ExternalLink, Check, ChevronsUpDown } from "lucide-react";

export interface PublishSignalFormProps {
  tokenOptions: { symbol: string; address: string }[];
  publishing: boolean;
  lastPublished?: { signalId: string; txUrl: string; at: string };
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
  venue: "hyperliquid" as SignalVenueT,
  orderType: "MARKET" as "MARKET" | "LIMIT",
  token: "", // arbitrum: address; hyperliquid: raw base token name (e.g. "USOL")
  quoteToken: "", // hyperliquid: raw quote token name (e.g. "USDC"); arbitrum: defaults to USDC
  sizePercent: 100,
  maxEntryPrice: "",
  takeProfitPrice: "",
  stopLossPrice: "",
  slippagePercent: 1,
  expiresInHours: 24,
};

const VENUES: { value: SignalVenueT; label: string }[] = [
  { value: "hyperliquid", label: "Hyperliquid" },
  { value: "arbitrum", label: "Arbitrum" },
];

export function PublishSignalForm({
  tokenOptions,
  lastPublished,
  onPublish,
}: PublishSignalFormProps) {
  const [s, setS] = useState(initialState);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    if (!s.token) e.token = "Pick a token";
    if (s.sizePercent < 1 || s.sizePercent > 100) e.sizePercent = "1–100%";
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Publish signal</CardTitle>
        <CardDescription>
          Spot-only. Encrypted before broadcast — followers can never see your TP/SL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Action */}
        <div className="space-y-1.5">
          <Label>Action</Label>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {(["ENTRY", "EXIT"] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setS({ ...s, action: a })}
                className={cn(
                  "rounded-sm px-4 py-1.5 text-sm font-medium transition-colors",
                  s.action === a
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* Venue — where this swap executes (per-signal). */}
        <div className="space-y-1.5">
          <Label>Execute on</Label>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {VENUES.map((v) => (
              <button
                key={v.value}
                type="button"
                // Switching venue clears the market: an Arbitrum address isn't a valid HL pair.
                onClick={() => setS({ ...s, venue: v.value, token: "", quoteToken: "" })}
                className={cn(
                  "rounded-sm px-4 py-1.5 text-sm font-medium transition-colors",
                  s.venue === v.value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {s.venue === "hyperliquid"
              ? "Hyperliquid spot — pick from every USDC market."
              : "Arbitrum — executes in each follower's CopyVault."}
          </p>
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
                USDC
              </div>
            </div>
          </div>
        )}

        {/* Size */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Size</Label>
            <span className="font-mono text-sm">{s.sizePercent}%</span>
          </div>
          <Slider
            value={[s.sizePercent]}
            onValueChange={(v) => setS({ ...s, sizePercent: v[0] })}
            min={1}
            max={100}
            step={1}
          />
        </div>

        {/* Order type — only relevant for entries */}
        {s.action === "ENTRY" && (
          <div className="space-y-1.5">
            <Label>Order type</Label>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(["MARKET", "LIMIT"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setS({ ...s, orderType: t })}
                  className={cn(
                    "rounded-sm px-4 py-1.5 text-sm font-medium transition-colors",
                    s.orderType === t
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "MARKET" ? "Market" : "Limit"}
                </button>
              ))}
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

        {/* Secret block */}
        <div className="space-y-3 rounded-md border border-dashed border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Lock className="h-3 w-3" /> Encrypted — never visible to followers
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
            <Input
              id="exp"
              type="number"
              min="1"
              value={s.expiresInHours}
              onChange={(e) => setS({ ...s, expiresInHours: Number(e.target.value) })}
            />
          </div>
        </div>

        <TxButton label="Publish signal" pendingLabel="Encrypting & publishing…" onClick={handle} />

        {lastPublished && (
          <div className="flex items-center justify-between rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-success">
              <Check className="h-4 w-4" /> Published
              <span className="text-muted-foreground">
                · {new Date(lastPublished.at).toLocaleTimeString()}
              </span>
            </span>
            <a
              href={lastPublished.txUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              proof <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </CardContent>
    </Card>
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
