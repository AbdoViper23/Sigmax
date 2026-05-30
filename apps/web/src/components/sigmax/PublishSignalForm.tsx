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
import { TxButton } from "./TxButton";
import { cn } from "@/lib/utils";
import { Lock, ExternalLink, Check } from "lucide-react";

export interface PublishSignalFormProps {
  tokenOptions: { symbol: string; address: string }[];
  publishing: boolean;
  lastPublished?: { signalId: string; txUrl: string; at: string };
  onPublish: (v: {
    action: "ENTRY" | "EXIT";
    token: string;
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
  token: "",
  sizePercent: 100,
  maxEntryPrice: "",
  takeProfitPrice: "",
  stopLossPrice: "",
  slippagePercent: 1,
  expiresInHours: 24,
};

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
    if (s.slippagePercent < 0.1 || s.slippagePercent > 5) e.slippagePercent = "0.1–5%";
    for (const k of ["maxEntryPrice", "takeProfitPrice", "stopLossPrice"] as const) {
      if (s[k] && Number(s[k]) < 0) e[k] = "Must be ≥ 0";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handle() {
    if (!validate()) throw new Error("Fix validation errors");
    await onPublish({
      action: s.action,
      token: s.token,
      sizePercent: s.sizePercent,
      maxEntryPrice: s.maxEntryPrice || undefined,
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

        {/* Tokens */}
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

        {/* Max entry */}
        <div className="space-y-1.5">
          <Label htmlFor="max-entry">Max entry price (USD) — optional</Label>
          <Input
            id="max-entry"
            type="number"
            min="0"
            step="0.01"
            value={s.maxEntryPrice}
            onChange={(e) => setS({ ...s, maxEntryPrice: e.target.value })}
            placeholder="—"
          />
        </div>

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
