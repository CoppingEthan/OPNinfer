"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Overview, OverviewRangeKey } from "@/lib/console/overview";
import { WINDOW_LABELS, visibleLimits } from "@/lib/agent/limits";
import { Empty, PortalTag, Stat, TableWrap, Unreachable, ago, compact, money, tdCls, thCls } from "./ui";
import { OverviewCharts } from "./spend-chart";

const RANGES: { key: OverviewRangeKey; label: string }[] = [
  { key: "day", label: "24 hours" },
  { key: "week", label: "7 days" },
  { key: "month", label: "30 days" },
];

/** Quiet background refresh — this is a wall-board as much as a page. */
const REFRESH_MS = 30_000;

/**
 * The console's front page: the whole estate on one screen.
 *
 * Everything is per portal AND summed, because the two questions are
 * different — "what are we spending" is a total, "who is spending it" never
 * is. Health lives here too (a stalled ingestion queue, errors in the window,
 * a portal nobody has used) since noticing those is the reason to keep the
 * tab open at all.
 */
export function OverviewView() {
  const [range, setRange] = useState<OverviewRangeKey>("week");
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    let cancelled = false;
    const load = async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/console/overview?range=${rangeRef.current}`);
        if (!res.ok) throw new Error(String(res.status));
        const d = (await res.json()) as Overview;
        if (!cancelled && d.range === rangeRef.current) {
          setData(d);
          setFailed(false);
        }
      } catch {
        if (!cancelled && !silent) setFailed(true);
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
  }, [range]);

  const t = data?.totals;
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? "";

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
        <p className="text-xs text-muted">
          {loading && !data ? "Reading every portal…" : `Refreshes every ${REFRESH_MS / 1000}s`}
        </p>
      </div>

      {failed && !data ? (
        <Empty>Could not reach the console API. Try reloading.</Empty>
      ) : null}

      {data ? (
        <>
          <Unreachable errors={data.portals.filter((p) => p.error).map((p) => ({ portal: p.instance.label, error: p.error! }))} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={`Spend · ${rangeLabel}`}
              value={money(t!.cost)}
              sub={`${compact(t!.requests)} requests`}
            />
            <Stat
              label="Active people"
              value={compact(t!.activeUsers)}
              sub={`of ${compact(t!.users)} accounts`}
            />
            <Stat
              label="Saved on the plan"
              value={money(t!.planSaved)}
              tone={t!.planSaved > 0 ? "good" : "default"}
              sub="Sandbox runs billed at $0"
            />
            <Stat
              label="Errors"
              value={compact(t!.errors)}
              tone={t!.errors > 0 ? "bad" : "good"}
              sub={
                // A file WAITING is a queue that is not draining, and is worth
                // alarm. A file that FAILED is history — four PDFs that failed
                // OCR weeks ago were reported as "stuck in ingestion", which
                // reads as a live outage and would never have cleared.
                t!.filesPending > 0 ? (
                  <span className="text-amber-500">
                    {t!.filesPending} file{t!.filesPending === 1 ? "" : "s"} waiting to be
                    processed
                  </span>
                ) : t!.filesFailed > 0 ? (
                  <span>
                    queue clear · {t!.filesFailed} never processed
                  </span>
                ) : (
                  "ingestion queue clear"
                )
              }
            />
          </div>

          {/* Graphs before the table (owner ask, 2026-09-07): the cards say
              what the totals are and the table says whose, but neither shows
              a trend — which is the thing you actually want from an overview.
              They follow the range selector above rather than owning one. */}
          {data.portals.length > 0 ? <OverviewCharts range={range} /> : null}

          {data.portals.length === 0 ? (
            <Empty>
              No portals are configured. deploy.sh writes them into the console&apos;s env file —
              re-run <code>./deploy.sh</code> on the host.
            </Empty>
          ) : (
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <th className={thCls}>Portal</th>
                  <th className={`${thCls} text-right`}>Spend</th>
                  <th className={`${thCls} text-right`}>Requests</th>
                  <th className={`${thCls} text-right`}>Active</th>
                  <th className={`${thCls} text-right`}>Tokens in / out</th>
                  <th className={`${thCls} text-right`}>Plan saved</th>
                  <th className={`${thCls} text-right`}>Errors</th>
                  <th className={`${thCls} text-right`}>Chats</th>
                  <th className={`${thCls} text-right`}>Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.portals.map(({ instance, data: s, error }) => (
                  <tr key={instance.name} className="border-b border-border/60 last:border-0">
                    <td className={tdCls}>
                      <span className="font-medium">{instance.label}</span>
                      <span className="ml-2 text-xs text-muted">{instance.name}</span>
                    </td>
                    {error || !s ? (
                      <td className={`${tdCls} text-amber-500`} colSpan={8}>
                        unreachable
                      </td>
                    ) : (
                      <>
                        <td className={`${tdCls} text-right tabular-nums`}>{money(s.cost)}</td>
                        <td className={`${tdCls} text-right tabular-nums`}>{compact(s.requests)}</td>
                        <td className={`${tdCls} text-right tabular-nums`}>
                          {s.activeUsers}
                          <span className="text-muted">/{s.users}</span>
                        </td>
                        <td className={`${tdCls} text-right tabular-nums text-muted`}>
                          {compact(s.inTokens)} / {compact(s.outTokens)}
                        </td>
                        <td className={`${tdCls} text-right tabular-nums`}>
                          {s.planSaved > 0 ? money(s.planSaved) : "—"}
                        </td>
                        <td
                          className={`${tdCls} text-right tabular-nums ${
                            s.errors > 0 ? "text-red-500" : "text-muted"
                          }`}
                        >
                          {s.errors || "—"}
                        </td>
                        <td className={`${tdCls} text-right tabular-nums text-muted`}>
                          {compact(s.chats)}
                        </td>
                        <td className={`${tdCls} text-right text-muted`}>{ago(s.lastMessageAt)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}

          <PlanStrip data={data} />

          <p className="text-xs text-muted">
            Read-only. To change anything, open that portal&apos;s own admin area.{" "}
            <Link href="/console/logs" className="underline underline-offset-2">
              Recent errors
            </Link>{" "}
            ·{" "}
            <Link href="/console/usage" className="underline underline-offset-2">
              Full usage
            </Link>
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The shared Claude plan.
 *
 * Every portal signs its Sandbox agent in to the same Anthropic account, so
 * these windows are ONE pool that four portals draw on — and no single
 * portal's admin page can show that. Each portal only knows the reading it
 * last recorded, so the honest thing is to show them side by side with their
 * age, not to average or pick one.
 */
function PlanStrip({ data }: { data: Overview }) {
  const now = Date.now();
  const rows = data.portals
    .map((p) => ({
      label: p.instance.label,
      limits: p.data?.plan ? visibleLimits(p.data.plan, now) : [],
    }))
    .filter((r) => r.limits.length > 0);
  if (rows.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold tracking-tight">Claude plan</h2>
      <p className="mb-3 mt-0.5 text-sm text-muted">
        One subscription shared by every portal&apos;s Sandbox. Each row is the last reading that
        portal recorded, so the freshest one is the truest.
      </p>
      <div className="space-y-3">
        {rows.map(({ label, limits }) => (
          <div key={label} className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <PortalTag label={label} />
            {limits.map((w) => (
              <span key={w.window} className="flex items-center gap-1.5">
                <span className="text-xs text-muted">{WINDOW_LABELS[w.window] ?? w.window}</span>
                <span
                  className={`text-xs font-medium tabular-nums ${
                    w.status === "rejected" || (w.percentUsed ?? 0) >= 90
                      ? "text-red-500"
                      : (w.percentUsed ?? 0) >= 75
                        ? "text-amber-500"
                        : "text-foreground"
                  }`}
                >
                  {w.percentUsed == null ? "—" : `${Math.round(w.percentUsed)}%`}
                </span>
              </span>
            ))}
            <span className="text-xs text-muted">
              read {ago(new Date(Math.max(...limits.map((l) => l.observedAt))).toISOString())}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

