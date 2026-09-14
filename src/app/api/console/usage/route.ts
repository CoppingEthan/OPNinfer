import { refuseNonOperator } from "@/lib/console/guard";
import { getConsoleUsage } from "@/lib/console/usage";
import { stackCostByPortal } from "@/lib/console/merge";
import { parseRange } from "@/lib/usage-summary";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/usage?range=… — the same payload the per-portal usage
 * dashboard renders, but summed across every portal, so one component can
 * draw either. The per-portal split rides along for the breakdown table.
 */
export async function GET(req: Request) {
  const refusal = await refuseNonOperator();
  if (refusal) return refusal;

  const range = parseRange(new URL(req.url).searchParams.get("range"));
  const data = await getConsoleUsage(range);
  // The cost chart is drawn as bands, one per portal (owner ask 2026-09-07):
  // the bar's total height still answers "what did we spend", and the colour
  // answers "on whom" without a second chart.
  return Response.json({
    ...stackCostByPortal(data.combined, data.portals),
    portals: data.portals.map((p) => ({
      portal: p.portal,
      label: p.label,
      cost: p.summary.totals.cost,
      requests: p.summary.totals.requests,
      in: p.summary.totals.in,
      out: p.summary.totals.out,
      cached: p.summary.totals.cacheRead,
      users: p.summary.totals.users,
      planSaved: p.summary.totals.subscription.notionalCost,
    })),
    unreachable: data.errors,
  });
}
