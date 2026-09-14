"use client";

import { useEffect, useRef, useState } from "react";
import { CostBarChart } from "@/components/admin/usage-cost-chart";
import { TokenLineChart } from "@/components/admin/usage-line-chart";
import type { UsageSummary } from "@/lib/usage-summary";

/**
 * The overview's graphs: spend over time split by portal, and throughput.
 *
 * Deliberately fed by `/api/console/usage` — the SAME endpoint the Usage page
 * renders — rather than by widening the overview's own read. Two reasons: the
 * numbers on the two pages then cannot disagree (they are one query on one
 * bucket grid), and building a second series per portal on a page that
 * already fans out to four databases would double its cost for a picture of
 * data it is about to fetch anyway.
 *
 * It follows the overview's range selector rather than owning one: two range
 * controls on one screen, each governing half of it, is the kind of thing
 * that gets misread once and then distrusted for ever.
 */
export function OverviewCharts({ range }: { range: "day" | "week" | "month" }) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/console/usage?range=${rangeRef.current}`);
        if (!res.ok) return;
        const d = (await res.json()) as UsageSummary;
        // A slow answer for a range the operator has already moved on from
        // must not overwrite a newer one.
        if (!cancelled && d.range === rangeRef.current) setData(d);
      } catch {
        /* the cards above report portals that cannot be read */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range]);

  // While a new range is in flight the old points belong to a different
  // window: show the chart empty rather than briefly wrong.
  const stale = data !== null && data.range !== range;
  const points = stale ? [] : (data?.points ?? []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CostBarChart
        points={points}
        range={range}
        loading={loading || stale}
        stack={stale ? undefined : data?.stack}
        title={data?.stack && !stale ? "Spend by portal" : "Spend"}
      />
      <TokenLineChart points={points} range={range} loading={loading || stale} />
    </div>
  );
}
