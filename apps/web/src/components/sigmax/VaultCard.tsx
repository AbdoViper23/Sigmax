import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { TxButton } from "./TxButton";
import { cn } from "@/lib/utils";
import type { VaultLeg } from "@/hooks/flareControlPlane";
import { AlertTriangle, Ban, ExternalLink, ShieldCheck, Wallet } from "lucide-react";

export interface VaultCardProps {
  /** The follower's vault address, or undefined when they have not created one yet. */
  vault?: string;
  fxrp: string;
  quote: string;
  quoteSymbol: string;
  /** FXRP in the follower's own wallet — the ceiling on what they can fund. */
  walletFxrp: string;
  /** The follower's quote-token balance — what an ENTRY signal spends. */
  walletQuote: string;
  explorerBase: string;
  busy?: boolean;
  /** True when this vault still trusts a retired enclave identity — every trade would revert. */
  teeStale?: boolean;
  onCreateAndFund: (amount: string, leg: VaultLeg) => Promise<void>;
  onDeposit: (amount: string, leg: VaultLeg) => Promise<void>;
  onWithdraw: (amount: string, leg: VaultLeg) => Promise<void>;
  onRepointTee?: () => Promise<void>;
  /** Top up the quote token from its public faucet (Coston2 has no other source). */
  onMintQuote?: () => Promise<void>;
}

// `VaultLeg` is defined by the hook that owns the leg→token mapping, and re-exported here so callers
// of this card do not need to import from two places.
export type { VaultLeg };

/**
 * The follower's vault — create it, fund it, take the money back out.
 *
 * The non-custodial claim is made by the shape of this card, not by a sentence in it: every control
 * moves funds either into the follower's own vault or back to their own wallet. There is deliberately
 * no "grant access" step and no allowance to a trading service. Execution is authorized by the
 * enclave's signature and verified by the vault on-chain, so nothing here needs the follower's trust.
 */
export function VaultCard({
  vault,
  fxrp,
  quote,
  quoteSymbol,
  walletFxrp,
  walletQuote,
  explorerBase,
  busy,
  teeStale,
  onCreateAndFund,
  onDeposit,
  onWithdraw,
  onRepointTee,
  onMintQuote,
}: VaultCardProps) {
  const [amount, setAmount] = useState("");
  /*
   * Which leg to fund. This exists because the two directions spend different tokens: an ENTRY buys
   * FXRP with the quote token, an EXIT sells FXRP back. A vault holding only FXRP therefore sizes every
   * ENTRY at zero and skips it — the follower sees no trade and no error, which is the worst possible
   * outcome. Funding both legs is the only way to be able to copy a leader's next signal whichever
   * direction it is.
   */
  const [leg, setLeg] = useState<VaultLeg>("fxrp");

  const exists = Boolean(vault);
  const walletBalance = leg === "fxrp" ? walletFxrp : walletQuote;
  const symbol = leg === "fxrp" ? "FXRP" : quoteSymbol;
  const canFund = Number(walletBalance) > 0;
  // Both legs funded ⇒ ready for a signal in either direction.
  const readyBothWays = Number(fxrp) > 0 && Number(quote) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4" aria-hidden />
          Your vault
        </CardTitle>
        <CardDescription>
          {exists
            ? "Your funds, in a contract only you can withdraw from."
            : "One transaction creates your vault and funds it. Copying starts from there."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              Trades execute inside this vault — the funds never leave it to be traded.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Ban className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              <span className="font-medium text-foreground">Only you can withdraw.</span> Not us, not
              the enclave, not the keeper.
            </span>
          </li>
        </ul>

        {/* The failure this prevents is a silent one: a re-attested enclave signs with a new key, the
            vault keeps checking the old one, and every trade reverts with no visible cause. */}
        {exists && teeStale && onRepointTee && (
          <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="text-sm">
                <p className="font-medium text-foreground">This vault trusts a retired enclave key.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Trades will be rejected until you point it at the current one. Your funds are not
                  affected, and only you can make this change.
                </p>
              </div>
            </div>
            <TxButton
              label="Trust the current enclave"
              pendingLabel="Updating…"
              disabled={busy}
              onClick={onRepointTee}
            />
          </div>
        )}

        {exists && (
          <div className="grid grid-cols-2 gap-4 rounded-md border border-border bg-muted/30 p-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">FXRP</div>
              <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{fxrp}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {quoteSymbol}
              </div>
              <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{quote}</div>
            </div>
          </div>
        )}

        {/* Fund both sides to copy either direction. Stated as guidance rather than left implicit,
            because the failure it prevents is invisible: an under-funded leg is skipped, not reported. */}
        {exists && !readyBothWays && (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Hold <span className="font-medium text-foreground">both</span> FXRP and {quoteSymbol} to copy
            in either direction — buys spend {quoteSymbol}, sells spend FXRP. A leg with no balance is
            skipped silently.
          </p>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="vault-amount">Amount</Label>
            <div role="radiogroup" aria-label="Token" className="inline-flex rounded-md border border-border p-0.5">
              {(["fxrp", "quote"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={leg === l}
                  onClick={() => setLeg(l)}
                  className={cn(
                    "rounded-sm px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    leg === l
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {l === "fxrp" ? "FXRP" : quoteSymbol}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              id="vault-amount"
              inputMode="decimal"
              placeholder="0.5"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => setAmount(walletBalance)}>
              Max
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {canFund ? `${walletBalance} ${symbol} in your wallet` : `No ${symbol} in your wallet yet`}
            </span>
            {leg === "quote" && onMintQuote && (
              <button
                type="button"
                onClick={onMintQuote}
                disabled={busy}
                className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
              >
                Get {quoteSymbol} from the faucet
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {exists ? (
            <>
              <TxButton
                label={`Deposit ${symbol}`}
                pendingLabel="Depositing…"
                disabled={busy || !amount}
                onClick={() => onDeposit(amount, leg).then(() => setAmount(""))}
              />
              <TxButton
                label="Withdraw"
                pendingLabel="Withdrawing…"
                disabled={busy || !amount}
                onClick={() => onWithdraw(amount, leg).then(() => setAmount(""))}
              />
            </>
          ) : (
            <TxButton
              label={`Create vault & fund ${symbol}`}
              pendingLabel="Creating…"
              disabled={busy || !amount || !canFund}
              onClick={() => onCreateAndFund(amount, leg).then(() => setAmount(""))}
            />
          )}
        </div>

        {vault && (
          <a
            href={`${explorerBase}/address/${vault}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
          >
            {vault.slice(0, 10)}…{vault.slice(-8)}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </CardContent>
    </Card>
  );
}
