import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export interface StepperProps {
  steps: string[];
  current: number; // 0-based; "current" step is highlighted; steps < current are done
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex items-center gap-3 overflow-x-auto pb-2 text-sm">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex shrink-0 items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full border text-xs font-medium",
                  done && "border-success bg-success text-success-foreground",
                  active && "border-foreground bg-foreground text-background",
                  !done && !active && "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{label}</span>
            </div>
            {i < steps.length - 1 && <span className="h-px w-8 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}
