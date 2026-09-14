import { auth } from "@/auth";
import { db } from "@/lib/db";
import { buildUsageSummary, parseRange } from "@/lib/usage-summary";

export const dynamic = "force-dynamic";

// The payload's shape lives in `@/lib/usage-summary` — re-exported here so the
// long-standing `import type { UsageSummary } from ".../summary/route"` keeps
// working, and because the operator console builds the identical structure
// against every portal's database from that same module.
export type {
  UsageBreakdownRow,
  UsagePoint,
  UsageRangeKey,
  UsageRecentRow,
  UsageSummary,
  UsageTotals,
} from "@/lib/usage-summary";

/**
 * GET /api/admin/usage/summary?range=hour|day|week|month|year|all — everything
 * the admin usage dashboard renders, in one consistent window: bucketed series
 * (tokens + cost + requests), window totals, previous-window totals (deltas),
 * breakdowns by role/provider/model/user, and the most recent calls. Admin only.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const range = parseRange(new URL(req.url).searchParams.get("range"));
  return Response.json(await buildUsageSummary(db, range));
}
