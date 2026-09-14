"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  UsageBreakdownRow,
  UsageRangeKey,
  UsageSummary,
} from "@/lib/usage-summary";
import { TokenLineChart } from "./usage-line-chart";
import { CostBarChart } from "./usage-cost-chart";

const RANGES: { key: UsageRangeKey; label: string }[] = [
  { key: "hour", label: "Hour" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "all", label: "All" },
];

const REFRESH_MS = 60_000;

const usd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 1 ? 4 : 2,
    maximumFractionDigits: 4,
  });
const num = (n: number) => n.toLocaleString();
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1_000).toFixed(1)}k` : num(n);

/** "▲ 12.4%" vs the previous window; null when it can't be computed. */
function delta(cur: number, prev: number | undefined | null): string | null {
  if (prev == null) return null;
  if (prev === 0) return cur > 0 ? "new" : null;
  const pct = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(pct)) return null;
  const arrow = pct >= 0 ? "▲" : "▼";
  return `${arrow} ${Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`;
}

function fmtRecentTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * The whole Admin → Usage dashboard: ONE range selector drives the KPI cards
 * (with vs-previous-window deltas), both charts, all four breakdowns, and the
 * recent-activity feed — a single summary fetch per range, silently refreshed
 * every minute.
 *
 * `endpoint` exists so the operator console can render the identical dashboard
 * over EVERY portal at once: same payload shape, built by the same
 * `buildUsageSummary` against each portal's database and merged. Anything
 * added here therefore lands on both pages, which is the point.
 */
export function UsageDashboard({
  endpoint = "/api/admin/usage/summary",
}: {
  endpoint?: string;
} = {}) {
  const [range, setRange] = useState<UsageRangeKey>("day");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    let cancelled = false;
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`${endpoint}?range=${rangeRef.current}`);
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as UsageSummary;
        if (!cancelled && d.range === rangeRef.current) {
          setData(d);
          setError(false);
        }
      } catch {
        if (!cancelled && !silent) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load(false);
    const timer = setInterval(() => void load(true), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range, endpoint]);

  const t = data?.totals;
  const cacheRate =
    t && t.in + t.cacheRead > 0 ? (t.cacheRead / (t.in + t.cacheRead)) * 100 : null;

  const stale = data != null && data.range !== range;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                range === r.key
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          auto-refreshes every minute
        </span>
      </div>

      {error && !data ? (
        <p className="rounded-2xl border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          Couldn&apos;t load usage data. Refresh to retry.
        </p>
      ) : null}

      {/* KPI cards */}
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 ${stale ? "opacity-60" : ""}`}>
        <Kpi
          label="Cost"
          value={t ? usd(t.cost) : "—"}
          sub={delta(t?.cost ?? 0, data?.prev?.cost) ?? "in range"}
          subTitle={data?.prev ? `previous window: ${usd(data.prev.cost)}` : undefined}
          loading={loading && !data}
        />
        <Kpi
          label="Requests"
          value={t ? num(t.requests) : "—"}
          sub={
            t
              ? `${delta(t.requests, data?.prev?.requests) ?? ""}${t.users > 0 ? `${data?.prev ? " · " : ""}${t.users} user${t.users === 1 ? "" : "s"}` : ""}` || "in range"
              : "…"
          }
          subTitle={data?.prev ? `previous window: ${num(data.prev.requests)}` : undefined}
          loading={loading && !data}
        />
        <Kpi
          label="Input tokens"
          value={t ? compact(t.in) : "—"}
          title={t ? num(t.in) : undefined}
          sub={delta(t?.in ?? 0, data?.prev?.in) ?? "full-price input"}
          loading={loading && !data}
        />
        <Kpi
          label="Output tokens"
          value={t ? compact(t.out) : "—"}
          title={t ? num(t.out) : undefined}
          sub={delta(t?.out ?? 0, data?.prev?.out) ?? "generated"}
          loading={loading && !data}
        />
        <Kpi
          label="Cache hit rate"
          value={cacheRate != null ? `${cacheRate.toFixed(1)}%` : "—"}
          sub={t ? `${compact(t.cacheRead)} cached reads` : "…"}
          subTitle="share of input served from provider prompt cache"
          loading={loading && !data}
        />
        <Kpi
          label="Avg cost / request"
          // Over BILLABLE requests only: a Sandbox call on the operator's
          // plan is a real request at $0.00, and would drag this down.
          value={t && t.billableRequests > 0 ? usd(t.cost / t.billableRequests) : "—"}
          sub={t ? `${compact(t.cacheWrite)} cache writes` : "…"}
          subTitle={t && t.subscription.requests > 0 ? `${num(t.billableRequests)} billable of ${num(t.requests)} requests` : undefined}
          loading={loading && !data}
        />
      </div>

      {/* Subscription usage — Sandbox runs on the operator's Claude plan.
          Real tokens, no bill, and what they would have cost: the plan's
          value, shown as "saved". Only appears once there is some. */}
      {t && t.subscription.requests > 0 ? (
        <div className={`rounded-2xl border border-border bg-surface px-4 py-3 text-sm ${stale ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <span className="font-medium text-foreground">
              On the Claude plan{" "}
              <span className="font-normal text-muted">(Sandbox agent runs — not billed)</span>
            </span>
            <span className="text-foreground">
              <span className="font-semibold">{usd(t.subscription.notionalCost)} saved</span>
              {data?.prev ? (
                <span className="text-muted"> · {delta(t.subscription.notionalCost, data.prev.notionalCost) ?? "—"}</span>
              ) : null}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {num(t.subscription.requests)} calls · {compact(t.subscription.in)} in · {compact(t.subscription.out)} out ·{" "}
            {compact(t.subscription.cacheRead)} cached reads — the API-rate value of work done on the subscription.
          </p>
        </div>
      ) : null}

      {/* While a range switch is in flight, blank the charts (old buckets under
          new labels would mislead); the minute-poll refresh swaps in place. */}
      <TokenLineChart points={stale ? [] : data?.points ?? []} range={range} loading={loading || stale} />
      {/* `stack` arrives only from the operator console, which splits the
          bars by portal. A portal's own dashboard sends no such field and
          gets exactly the chart it always had. */}
      <CostBarChart
        points={stale ? [] : data?.points ?? []}
        range={range}
        loading={loading || stale}
        stack={data?.stack}
        title={data?.stack ? "Cost by portal" : "Cost"}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <BreakdownTable title="By model" nameHeader="Model" rows={data?.byModel ?? []} loading={loading && !data} />
        <BreakdownTable title="By user" nameHeader="User" rows={data?.byUser ?? []} loading={loading && !data} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <BreakdownTable title="By role" nameHeader="Role" rows={data?.byRole ?? []} loading={loading && !data} />
        <BreakdownTable title="By provider" nameHeader="Provider" rows={data?.byProvider ?? []} loading={loading && !data} />
      </div>

      <RecentActivity rows={data?.recent ?? []} loading={loading && !data} />

      <p className="text-xs text-muted">
        Costs are estimates computed at request time from the pricing table. Input tokens are the
        full-price (uncached) count; cached reads are billed at each provider&apos;s reduced rate.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  subTitle,
  title,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  subTitle?: string;
  title?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      {loading ? (
        <div className="mt-2 h-6 w-20 animate-pulse rounded bg-surface-hover" />
      ) : (
        <div className="mt-1 truncate text-lg font-semibold text-foreground" title={title}>
          {value}
        </div>
      )}
      {sub && !loading ? (
        <div className="mt-0.5 truncate text-xs text-muted" title={subTitle}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function BreakdownTable({
  title,
  nameHeader,
  rows,
  loading,
}: {
  title: string;
  nameHeader: string;
  rows: UsageBreakdownRow[];
  loading?: boolean;
}) {
  const totalCost = useMemo(() => rows.reduce((s, r) => s + r.cost, 0), [rows]);
  const maxCost = useMemo(() => Math.max(...rows.map((r) => r.cost), 1e-9), [rows]);
  return (
    <div className="rounded-2xl border border-border bg-surface">
      <h2 className="border-b border-border px-5 py-3.5 text-sm font-semibold text-foreground">
        {title}
      </h2>
      {loading ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-surface-hover" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No usage in this range.</p>
      ) : (
        <div className="oi-scroll max-h-80 overflow-y-auto overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">{nameHeader}</th>
                <th className="px-3 py-2 text-right font-medium">Req</th>
                <th className="px-3 py-2 text-right font-medium">In</th>
                <th className="px-3 py-2 text-right font-medium">Out</th>
                <th className="px-3 py-2 text-right font-medium">Cached</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="w-24 px-5 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const share = totalCost > 0 ? (r.cost / totalCost) * 100 : 0;
                return (
                  <tr key={i}>
                    <td className="max-w-[14rem] px-5 py-2">
                      <div className="truncate font-medium text-foreground" title={r.key}>
                        {r.key}
                      </div>
                      {r.sub ? <div className="truncate text-xs text-muted">{r.sub}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">{num(r.requests)}</td>
                    <td className="px-3 py-2 text-right text-muted" title={num(r.in)}>{compact(r.in)}</td>
                    <td className="px-3 py-2 text-right text-muted" title={num(r.out)}>{compact(r.out)}</td>
                    <td className="px-3 py-2 text-right text-muted" title={num(r.cached)}>{compact(r.cached)}</td>
                    <td className="px-3 py-2 text-right font-medium text-foreground">{usd(r.cost)}</td>
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-background">
                          <div
                            className="h-full rounded-full bg-accent/70"
                            style={{ width: `${(r.cost / maxCost) * 100}%` }}
                          />
                        </div>
                        <span className="w-9 text-right text-xs text-muted">{share.toFixed(0)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecentActivity({
  rows,
  loading,
}: {
  rows: UsageSummary["recent"];
  loading?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface">
      <h2 className="border-b border-border px-5 py-3.5 text-sm font-semibold text-foreground">
        Recent activity
      </h2>
      {loading ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-surface-hover" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">No requests in this range.</p>
      ) : (
        <div className="oi-scroll max-h-96 overflow-y-auto overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">In</th>
                <th className="px-3 py-2 text-right font-medium">Out</th>
                <th className="px-3 py-2 text-right font-medium">Cached</th>
                <th className="px-5 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap px-5 py-2 text-muted">{fmtRecentTime(r.t)}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-foreground" title={r.user}>
                    {r.user}
                  </td>
                  <td className="px-3 py-2 text-muted">{r.role}</td>
                  <td className="max-w-[12rem] px-3 py-2">
                    <div className="truncate text-foreground" title={`${r.provider} / ${r.model}`}>
                      {r.model}
                    </div>
                    <div className="truncate text-xs text-muted">{r.provider}</div>
                  </td>
                  <td className="px-3 py-2 text-right text-muted" title={num(r.in)}>{compact(r.in)}</td>
                  <td className="px-3 py-2 text-right text-muted" title={num(r.out)}>{compact(r.out)}</td>
                  <td className="px-3 py-2 text-right text-muted" title={num(r.cached)}>{compact(r.cached)}</td>
                  <td className="whitespace-nowrap px-5 py-2 text-right font-medium text-foreground">
                    {usd(r.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
