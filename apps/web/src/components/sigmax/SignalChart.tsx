import { buildChartGeometry } from "@/lib/chart";
import { cn } from "@/lib/utils";

const W = 300;
const H = 84;
const PAD = 8;

/**
 * Bespoke SVG equity/track-record curve for the hero. Zero deps so the motion is ours to shape:
 * the line draws itself in, the fill rises behind it, and a "live" dot settles at the latest
 * point — a real trading feel without a charting library's weight or a 3D scene's off-brand gloss.
 *
 * Motion is purely additive and lives in styles.css behind `prefers-reduced-motion: no-preference`;
 * with motion reduced, the finished curve simply renders as-is. Colors come from CSS classes (not
 * `stroke=`/`stopColor=` attributes) because `var()` isn't reliable inside SVG presentation
 * attributes — gradient stops get the color via inline style for the same reason.
 */
export function SignalChart({ values, className }: { values: number[]; className?: string }) {
  const geo = buildChartGeometry(values, W, H, PAD);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("h-auto w-full", className)}
      role="img"
      aria-label="Verified track record, trending upward"
    >
      <defs>
        <linearGradient id="signal-chart-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--color-success)", stopOpacity: 0.22 }} />
          <stop offset="100%" style={{ stopColor: "var(--color-success)", stopOpacity: 0 }} />
        </linearGradient>
      </defs>

      <path className="signal-chart-area" d={geo.area} fill="url(#signal-chart-grad)" />
      <path
        className="signal-chart-line"
        d={geo.line}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
      />
      {/* Two stacked dots: a solid marker plus a ring that pings outward to read as "live". */}
      <circle className="signal-chart-pulse" cx={geo.last.x} cy={geo.last.y} r={3} />
      <circle className="signal-chart-dot" cx={geo.last.x} cy={geo.last.y} r={3} />
    </svg>
  );
}
