"use client";

import { useEffect, useState } from "react";
import type { UsageSummary } from "@/lib/usage-summary";
import { TableWrap, Unreachable, compact, money, tdCls, thCls } from "./ui";

/**
 * Who the combined usage numbers belong to.
 *
 * The dashboard below this answers "what did we spend"; four clients share one
 * host, and the only question that can't be answered from a total is "whose".
 * Rides the SAME `/api/console/usage` response the dashboard fetches, so the
 * split and the total always come from one window and can be checked against
 * each other by eye.
 */
interface PortalRow {
  portal: string;
  label: string;
  cost: number;
  requests: number;
  in: number;
  out: number;
  cached: number;
  users: number;
  planSaved: number;
}
type Payload = UsageSummary & {
  portals: PortalRow[];
  unreachable: { portal: string; error: string }[];
};

const REFRESH_MS = 60_000;

export function PortalSpend() {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/console/usage?range=month");
        if (!res.ok) return;
        const d = (await res.json()) as Payload;
        if (!cancelled) setData(d);
      } catch {
        /* the dashboard below reports failures; this strip just stays empty */
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!data) return null;
  const total = data.portals.reduce((n, p) => n + p.cost, 0);

  return (
    <div className="space-y-3">
      <Unreachable errors={data.unreachable ?? []} />
      <div>
        <h2 className="text-sm font-semibold tracking-tight">By portal · last 30 days</h2>
        <p className="mb-3 mt-0.5 text-sm text-muted">
          A fixed 30-day window, so this stays comparable while you change the range below.
        </p>
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <th className={thCls}>Portal</th>
              <th className={`${thCls} text-right`}>Cost</th>
              <th className={`${thCls} text-right`}>Share</th>
              <th className={`${thCls} text-right`}>Requests</th>
              <th className={`${thCls} text-right`}>People</th>
              <th className={`${thCls} text-right`}>In</th>
              <th className={`${thCls} text-right`}>Out</th>
              <th className={`${thCls} text-right`}>Cached</th>
              <th className={`${thCls} text-right`}>Plan saved</th>
            </tr>
          </thead>
          <tbody>
            {data.portals.map((p) => {
              const share = total > 0 ? (p.cost / total) * 100 : 0;
              return (
                <tr key={p.portal} className="border-b border-border/60 last:border-0">
                  <td className={tdCls}>
                    <span className="font-medium">{p.label}</span>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{money(p.cost)}</td>
                  <td className={`${tdCls} text-right`}>
                    <div className="flex items-center justify-end gap-2">
                      <span className="tabular-nums text-muted">{share.toFixed(0)}%</span>
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover">
                        <span
                          className="block h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(2, share)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{compact(p.requests)}</td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>{p.users}</td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>{compact(p.in)}</td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>{compact(p.out)}</td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>
                    {compact(p.cached)}
                  </td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>
                    {p.planSaved > 0 ? money(p.planSaved) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </div>
    </div>
  );
}
