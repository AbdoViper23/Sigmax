import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TxButton } from "./TxButton";
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
import { Button } from "@/components/ui/button";

export interface RevokePauseControlsProps {
  paused: boolean;
  agentAuthorized: boolean;
  onTogglePause: (next: boolean) => Promise<void>;
  onRevoke: () => Promise<void>;
}

export function RevokePauseControls({
  paused,
  agentAuthorized,
  onTogglePause,
  onRevoke,
}: RevokePauseControlsProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!agentAuthorized) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent revoked</CardTitle>
          <CardDescription>
            No more trades will execute. Your funds are untouched and remain in your vault.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Controls</CardTitle>
        <CardDescription>You stay in charge. Pause or revoke the agent anytime.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TxButton
          label={paused ? "Resume copying" : "Pause copying"}
          pendingLabel={paused ? "Resuming…" : "Pausing…"}
          onClick={() => onTogglePause(!paused)}
        />
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="w-full">
              Revoke agent
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke the agent?</AlertDialogTitle>
              <AlertDialogDescription>
                The agent will no longer be able to swap inside your vault. Your funds are not
                moved. You can re-authorize later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={async () => {
                  setConfirmOpen(false);
                  await onRevoke();
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Yes, revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
