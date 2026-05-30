import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TxButtonProps {
  label: string;
  pendingLabel?: string;
  onClick: () => Promise<void>;
  disabled?: boolean;
  variant?: "primary" | "destructive";
  className?: string;
}

type State = "idle" | "pending" | "success" | "error";

export function TxButton({
  label,
  pendingLabel = "Confirming…",
  onClick,
  disabled,
  variant = "primary",
  className,
}: TxButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setState("pending");
    setError(null);
    try {
      await onClick();
      setState("success");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Transaction failed");
    }
  }

  return (
    <div className={cn("space-y-2", className)}>
      <Button
        type="button"
        onClick={handle}
        disabled={disabled || state === "pending"}
        variant={variant === "destructive" ? "destructive" : "default"}
        className="w-full"
      >
        {state === "pending" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {state === "success" && <Check className="mr-2 h-4 w-4" />}
        {state === "pending" ? pendingLabel : state === "success" ? "Confirmed" : label}
      </Button>
      {state === "error" && error && (
        <div className="flex items-start gap-1.5 text-xs text-danger">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {error}{" "}
            <button onClick={handle} className="underline underline-offset-2">
              Retry
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
