/**
 * Pure geometry for the hero equity curve. Maps a series of values into SVG path strings and the
 * coordinate of the latest point, so the chart component stays a thin presentational shell and the
 * math is easy to reason about. No dependencies, no rounding surprises (coords are fixed to 2dp).
 */

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartGeometry {
  /** Mapped screen-space points, left→right. */
  points: ChartPoint[];
  /** `M…L…` polyline through every point. */
  line: string;
  /** `line` closed down to the baseline for the area fill (empty for <2 points). */
  area: string;
  /** The most recent point — where the "live" dot sits. */
  last: ChartPoint;
}

const round = (n: number) => Number(n.toFixed(2));

/**
 * Build the line/area geometry for `values` inside a `width`×`height` box with uniform `pad`.
 * The series is spread evenly across the x-axis; y is normalized so the min sits on the baseline
 * and the max at the top. A flat series is centered vertically; a single point sits mid-left.
 */
export function buildChartGeometry(
  values: number[],
  width: number,
  height: number,
  pad = 0,
): ChartGeometry {
  if (values.length === 0) {
    return { points: [], line: "", area: "", last: { x: 0, y: 0 } };
  }

  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const n = values.length;

  const points: ChartPoint[] = values.map((v, i) => {
    const x = n === 1 ? pad : pad + (i / (n - 1)) * innerW;
    const y = span === 0 ? pad + innerH / 2 : pad + (1 - (v - min) / span) * innerH;
    return { x: round(x), y: round(y) };
  });

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  const baseline = round(height - pad);
  const first = points[0];
  const last = points[points.length - 1];
  const area =
    points.length >= 2
      ? `${line} L${last.x},${baseline} L${first.x},${baseline} Z`
      : "";

  return { points, line, area, last };
}
