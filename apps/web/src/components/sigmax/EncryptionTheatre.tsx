import { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The hero's centrepiece: a strategy's secret values visibly turning into ciphertext.
 *
 * This is deliberately not decoration. The single hardest thing about this product to convey in words
 * is that the take-profit and stop-loss *become unreadable bytes before they leave the page* — so the
 * animation shows exactly that, on a loop: real values, then a scramble, then a sealed payload with a
 * byte count. Motion that carries the argument earns its place; a spinning gradient would not.
 *
 * Constraints it respects:
 *  - Fixed row heights and a `tabular-nums` mono font, so swapping characters never reflows anything
 *    (no layout shift, and the block does not visibly jitter).
 *  - `prefers-reduced-motion` skips straight to the sealed end state — which is also the state that
 *    makes the point, so nothing is lost.
 *  - One interval, cleared on unmount. No per-character timers.
 */

const HEX = "0123456789abcdef";

interface SecretRow {
  label: string;
  /** The plaintext a leader would actually type. Illustrative — not a real signal. */
  value: string;
}

const ROWS: SecretRow[] = [
  { label: "Take profit", value: "$2.4180" },
  { label: "Stop loss", value: "$1.9725" },
  { label: "Entry rule", value: "break > 24h" },
];

type Phase = "plain" | "scrambling" | "sealed";

/** Deterministic-length scramble: same character count as the plaintext, so the row never resizes. */
function scramble(length: number, seed: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    // A cheap LCG keyed on (seed, i) — avoids Math.random so successive frames differ visibly rather
    // than shimmering randomly, and keeps the output stable within a frame.
    const n = (seed * 1103515245 + i * 12345) >>> 8;
    out += HEX[n % 16];
  }
  return out;
}

export function EncryptionTheatre({ className }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>("plain");
  const [tick, setTick] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    if (reduced.current) {
      setPhase("sealed");
      return;
    }

    // One timer drives the whole cycle: read for a beat, scramble, hold sealed, repeat.
    let elapsed = 0;
    const id = window.setInterval(() => {
      elapsed += 120;
      setTick((t) => t + 1);
      if (elapsed < 1600) setPhase("plain");
      else if (elapsed < 3000) setPhase("scrambling");
      else if (elapsed < 5200) setPhase("sealed");
      else elapsed = 0;
    }, 120);

    return () => window.clearInterval(id);
  }, []);

  const sealed = phase === "sealed";
  const scrambling = phase === "scrambling";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors duration-300",
        sealed ? "border-primary/40 bg-primary/5" : "border-dashed border-border bg-muted/30",
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-1.5 text-xs font-medium">
        {sealed ? (
          <>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="text-primary">Sealed to the enclave · 753 bytes</span>
          </>
        ) : (
          <>
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              {scrambling ? "Encrypting in your browser…" : "Your strategy, before it leaves"}
            </span>
          </>
        )}
      </div>

      {/*
        aria-live is deliberately absent: this loops forever, and announcing every cycle would make a
        screen reader unusable. The static description below carries the meaning instead.
      */}
      <div className="space-y-2.5" aria-hidden>
        {ROWS.map((row, i) => (
          <div key={row.label} className="flex h-5 items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-muted-foreground">{row.label}</span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-right font-mono tabular-nums",
                phase === "plain" ? "text-foreground" : "text-primary/80",
                scrambling && "cipher-flicker",
              )}
            >
              {phase === "plain"
                ? row.value
                : scramble(row.value.length, tick + i * 7)}
            </span>
          </div>
        ))}
      </div>

      <p className="sr-only">
        A demonstration: a leader's take-profit, stop-loss and entry rule are encrypted in their own
        browser into an opaque 753-byte payload before publication. Only the secure enclave can read
        them.
      </p>

      <div
        className={cn(
          "mt-3 rounded-md border border-transparent px-2 py-1.5 text-center font-mono text-[10px] transition-opacity duration-300",
          sealed ? "seal-glow bg-card text-primary opacity-100" : "opacity-0",
        )}
        aria-hidden
      >
        {sealed ? `0x${scramble(46, 99)}…` : " "}
      </div>
    </div>
  );
}
