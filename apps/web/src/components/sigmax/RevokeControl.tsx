import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, ShieldOff } from "lucide-react";

export interface RevokeControlProps {
  /** Revoke the copy-trading authorization (deregisters the agent). */
  onRevoke: () => Promise<void>;
}

/** "Stop & revoke" — destructive, confirmed. Separated from primary actions per UX guidance. */
export function RevokeControl({ onRevoke }: RevokeControlProps) {
  const [pending, setPending] = useState(false);

  async function handle() {
    setPending(true);
    try {
      await onRevoke();
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stop copy-trading</CardTitle>
        <CardDescription>Revoke the strategy's permission to trade for you.</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="destructive" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldOff className="mr-2 h-4 w-4" />}
              {pending ? "Revoking…" : "Stop & revoke access"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Stop copy-trading?</AlertDialogTitle>
              <AlertDialogDescription>
                The strategy will no longer place trades for you. Your funds stay in your account and
                any open positions remain — you can manage them yourself. You can re-authorize anytime.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep copying</AlertDialogCancel>
              <AlertDialogAction onClick={handle}>Stop & revoke</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
