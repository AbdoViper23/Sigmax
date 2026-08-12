import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { TxButton } from "./TxButton";
import { Ban, ExternalLink, ShieldCheck, Wallet } from "lucide-react";

export interface VaultCardProps {
  /** The follower's vault address, or undefined when they have not created one yet. */
  vault?: string;
  fxrp: string;
  quote: string;
  quoteSymbol: string;
  /** FXRP in the follower's own wallet — the ceiling on what they can fund. */
  walletFxrp: string;
  explorerBase: string;
  busy?: boolean;
  onCreateAndFund: (amount: string) => Promise<void>;
  onDeposit: (amount: string) => Promise<void>;
  onWithdraw: (amount: string) => Promise<void>;
}

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
  explorerBase,
  busy,
  onCreateAndFund,
  onDeposit,
  onWithdraw,
}: VaultCardProps) {
  const [amount, setAmount] = useState("");
  const exists = Boolean(vault);
  const canFund = Number(walletFxrp) > 0;

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

        <div className="space-y-2">
          <Label htmlFor="vault-amount">Amount (FXRP)</Label>
          <div className="flex gap-2">
            <Input
              id="vault-amount"
              inputMode="decimal"
              placeholder="0.5"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setAmount(exists ? walletFxrp : walletFxrp)}
            >
              Max
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {canFund ? `${walletFxrp} FXRP in your wallet` : "No FXRP in your wallet yet"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {exists ? (
            <>
              <TxButton
                label="Deposit"
                pendingLabel="Depositing…"
                disabled={busy || !amount}
                onClick={() => onDeposit(amount).then(() => setAmount(""))}
              />
              <TxButton
                label="Withdraw"
                pendingLabel="Withdrawing…"
                disabled={busy || !amount}
                onClick={() => onWithdraw(amount).then(() => setAmount(""))}
              />
            </>
          ) : (
            <TxButton
              label="Create vault & fund"
              pendingLabel="Creating…"
              disabled={busy || !amount || !canFund}
              onClick={() => onCreateAndFund(amount).then(() => setAmount(""))}
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
