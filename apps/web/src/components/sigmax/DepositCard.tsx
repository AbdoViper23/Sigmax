import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { TxButton } from "./TxButton";

export interface DepositCardProps {
  walletUsdc: string;
  vaultUsdc: string;
  status: "idle" | "depositing";
  onDeposit: (amountUsdc: string) => Promise<void>;
}

export function DepositCard({ walletUsdc, vaultUsdc, onDeposit }: DepositCardProps) {
  const [amount, setAmount] = useState("");
  const valid = Number(amount) > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deposit USDC</CardTitle>
        <CardDescription>One-click approve + deposit on Arbitrum.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">Wallet</div>
            <div className="font-mono tabular-nums">{walletUsdc} USDC</div>
          </div>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">Vault</div>
            <div className="font-mono tabular-nums">{vaultUsdc} USDC</div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount</Label>
          <Input
            id="amount"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <TxButton
          label="Deposit"
          pendingLabel="Approving & depositing…"
          disabled={!valid}
          onClick={async () => {
            await onDeposit(amount);
            setAmount("");
          }}
        />
      </CardContent>
    </Card>
  );
}
