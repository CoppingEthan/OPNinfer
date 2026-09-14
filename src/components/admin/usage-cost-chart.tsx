"use client";

import { useMemo, useState } from "react";
import { fmtBucketTime, type UsageRange } from "./usage-line-chart";

export interface CostPoint {
  t: string;
  cost: number;
  requests: number;
  /** Optional split of `cost` by series key. The operator console passes one
   *  key per portal; a portal's own dashboard has nothing to split by and
   *  leaves this undefined, which is why every stacking branch below is
   *  guarded rather than the default. */
  by?: Record<string, number>;
}

/** A band in a stacked bar: who it is, and what colour to draw it. */
export interface CostStackSeries {
  key: string;
  label: string;
  color: string;
}

const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 1 ? 4 : 2,
    maximumFractionDigits: 4,
  });
const num = (n: number) => n.toLocaleString();

/**
 * Cost-over-time bar chart with a hover tooltip (exact cost + request count
 * per bar). Purely presentational — the usage dashboard owns range + data.
 */
export function CostBarChart({
  points,
  range,
  loading = false,
  stack,
  title = "Cost",
}: {
  points: CostPoint[];
  range: UsageRange;
  loading?: boolean;
  /** Draw each bar as bands, one per series, instead of one solid bar. The
   *  bar's TOTAL height is unchanged, so the chart still answers "what did we
   *  spend" at a glance and the colour answers "on whom". */
  stack?: CostStackSeries[];
  title?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Only stack when there is something to stack AND more than one band —
  // a single-portal console would otherwise draw a legend for one colour.
  const bands = stack && stack.length > 1 ? stack : null;

  const n = points.length;
  const maxCost = useMemo(() => Math.max(...points.map((p) => p.cost), 1e-9), [points]);
  const totalCost = useMemo(() => points.reduce((s, p) => s + p.cost, 0), [points]);
  const totalReq = useMemo(() => points.reduce((s, p) => s + p.requests, 0), [points]);

  const hoverPoint = hover != null ? points[hover] : null;
  const hoverPct = hover != null && n > 1 ? (hover / (n - 1)) * 100 : 0;
  const tx = hoverPct > 85 ? "-100%" : hoverPct < 15 ? "0%" : "-50%";

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="text-xs text-muted">
          {usd(totalCost)} · {num(totalReq)} requests in range
        </div>
      </div>

      {bands ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {bands.map((b) => (
            <span key={b.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
              {b.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <div className="flex h-40 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
          {n > 0
            ? points.map((p, i) => (
                <div
                  key={i}
                  className="flex h-full flex-1 items-end"
                  onMouseEnter={() => setHover(i)}
                >
                  {bands ? (
                    // column-reverse so the first band sits at the BOTTOM and
                    // the stacking order matches the legend's reading order.
                    <div
                      className="flex w-full flex-col-reverse overflow-hidden rounded-t"
                      style={{
                        height: `${(p.cost / maxCost) * 100}%`,
                        minHeight: p.cost > 0 ? 2 : 0,
                        opacity: hover === null || hover === i ? 1 : 0.55,
                      }}
                    >
                      {bands.map((b) => {
                        const v = p.by?.[b.key] ?? 0;
                        if (v <= 0) return null;
                        return (
                          <div
                            key={b.key}
                            style={{ height: `${(v / p.cost) * 100}%`, background: b.color }}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div
                      className={`w-full rounded-t transition-colors ${
                        hover === i ? "bg-accent" : "bg-accent/70 hover:bg-accent"
                      }`}
                      style={{
                        height: `${(p.cost / maxCost) * 100}%`,
                        minHeight: p.cost > 0 ? 2 : 0,
                      }}
                    />
                  )}
                </div>
              ))
            : null}
        </div>

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
            className="pointer-events-none absolute bottom-full z-10 mb-2 min-w-[9rem] rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-lg"
            style={{ left: `${hoverPct}%`, transform: `translateX(${tx})` }}
          >
            <div className="mb-1 font-medium text-foreground">{fmtBucketTime(hoverPoint.t, range)}</div>
            {bands
              ? bands
                  // Only what actually spent anything in this bucket: four
                  // portals where three are idle should read as one line.
                  .filter((b) => (hoverPoint.by?.[b.key] ?? 0) > 0)
                  .map((b) => (
                    <div key={b.key} className="flex items-center gap-2 whitespace-nowrap">
                      <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
                      <span className="text-muted">{b.label}</span>
                      <span className="ml-auto font-medium text-foreground">
                        {usd(hoverPoint.by?.[b.key] ?? 0)}
                      </span>
                    </div>
                  ))
              : null}
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className={`h-2 w-2 rounded-full ${bands ? "bg-transparent" : "bg-accent"}`} />
              <span className="text-muted">{bands ? "Total" : "Cost"}</span>
              <span className="ml-auto font-medium text-foreground">{usd(hoverPoint.cost)}</span>
            </div>
            <div className="flex items-center gap-2 whitespace-nowrap text-muted">
              <span className="h-2 w-2 rounded-full bg-transparent" />
              <span>Requests</span>
              <span className="ml-auto font-medium text-foreground">{num(hoverPoint.requests)}</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>{points[0] ? fmtBucketTime(points[0].t, range) : ""}</span>
        <span>peak {usd(maxCost)}</span>
        <span>{n > 0 && points[n - 1] ? fmtBucketTime(points[n - 1].t, range) : "now"}</span>
      </div>
    </div>
  );
}
