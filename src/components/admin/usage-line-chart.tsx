"use client";

import { useCallback, useMemo, useState } from "react";

export interface TokenPoint {
  t: string;
  in: number;
  out: number;
  cached: number;
}
export type UsageRange = "hour" | "day" | "week" | "month" | "year" | "all";
type SeriesKey = "in" | "out" | "cached";

const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: "in", label: "Input", color: "#3b82f6" },
  { key: "out", label: "Output", color: "#10b981" },
  { key: "cached", label: "Cached", color: "#f59e0b" },
];

const W = 1000;
const H = 220;
const PAD_T = 12;
const PAD_B = 12;

export function fmtBucketTime(iso: string, range: UsageRange): string {
  const d = new Date(iso);
  if (range === "hour" || range === "day") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "year" || range === "all") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * Token-throughput line chart (dependency-free SVG): three series
 * (input / output / cached) with a hover guide + tooltip. Purely
 * presentational — the usage dashboard owns the range and the data.
 */
export function TokenLineChart({
  points,
  range,
  loading = false,
}: {
  points: TokenPoint[];
  range: UsageRange;
  loading?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const n = points.length;
  const maxY = useMemo(
    () => Math.max(1, ...points.flatMap((p) => [p.in, p.out, p.cached])),
    [points],
  );

  const x = useCallback((i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W), [n]);
  const y = useCallback(
    (v: number) => PAD_T + (1 - v / maxY) * (H - PAD_T - PAD_B),
    [maxY],
  );

  const linePath = (key: SeriesKey) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`)
      .join(" ");

  const onMove = (e: React.MouseEvent) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hoverPoint = hover != null ? points[hover] : null;
  const hoverPct = hover != null && n > 1 ? (hover / (n - 1)) * 100 : 0;
  const tx = hoverPct > 85 ? "-100%" : hoverPct < 15 ? "0%" : "-50%";

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Token throughput</h2>
        <div className="flex flex-wrap gap-3 text-xs text-muted">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <div
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-48 w-full">
          {[0.25, 0.5, 0.75].map((g) => {
            const gy = PAD_T + g * (H - PAD_T - PAD_B);
            return (
              <line
                key={g}
                x1={0}
                x2={W}
                y1={gy}
                y2={gy}
                className="text-border"
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {n > 0
            ? SERIES.map((s) => (
                <path
                  key={s.key}
                  d={linePath(s.key)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))
            : null}
          {hover != null && hoverPoint ? (
            <>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD_T}
                y2={H - PAD_B}
                className="text-muted"
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {SERIES.map((s) => (
                <circle
                  key={s.key}
                  cx={x(hover)}
                  cy={y(hoverPoint[s.key])}
                  r={3.5}
                  fill={s.color}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </>
          ) : null}
        </svg>

        {loading && n === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            Loading…
          </div>
        ) : n === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            No usage in this range.
          </div>
        ) : null}

        {hover != null && hoverPoint ? (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-[9rem] rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg"
            style={{ left: `${hoverPct}%`, transform: `translateX(${tx})` }}
          >
            <div className="mb-1 font-medium text-foreground">
              {fmtBucketTime(hoverPoint.t, range)}
            </div>
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2 whitespace-nowrap">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-muted">{s.label}</span>
                <span className="ml-auto font-medium text-foreground">
                  {fmtNum(hoverPoint[s.key])}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>{points[0] ? fmtBucketTime(points[0].t, range) : ""}</span>
        <span>{n > 0 && points[n - 1] ? fmtBucketTime(points[n - 1].t, range) : "now"}</span>
      </div>
    </div>
  );
}
