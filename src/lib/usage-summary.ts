import type { PrismaClient } from "@prisma/client";
import type { SubscriptionTotals } from "@/lib/usage-math";

/**
 * The usage dashboard's whole payload, built from ONE bucket-aligned window so
 * every number on the page agrees to the penny.
 *
 * Extracted from `GET /api/admin/usage/summary` (2026-09-07) so the operator
 * console can run the SAME query set against every portal's database and merge
 * the results. Deliberately takes its Prisma client as an argument and imports
 * no `db` of its own — that is what lets it run against a portal other than
 * the one it is deployed in, and it keeps this file free of `server-only` so
 * the client dashboard can go on importing the types from here.
 */

/** Fixed ranges → bucket size + count (window = bucketMs x count, bucket-aligned). */
export const RANGES = {
  hour: { bucketMs: 60_000, count: 60 }, // 60 x 1 min
  day: { bucketMs: 3_600_000, count: 24 }, // 24 x 1 hour
  week: { bucketMs: 21_600_000, count: 28 }, // 28 x 6 hours
  month: { bucketMs: 86_400_000, count: 30 }, // 30 x 1 day
  year: { bucketMs: 604_800_000, count: 52 }, // 52 x 1 week
} as const;
export type UsageRangeKey = keyof typeof RANGES | "all";

const DAY = 86_400_000;

export interface UsagePoint {
  t: string;
  in: number;
  out: number;
  cached: number;
  cost: number;
  requests: number;
  /** Where this bucket's cost came from, keyed by portal. Set only by the
   *  operator console when it merges several portals into one series;
   *  `buildUsageSummary` itself never has more than one source to split by. */
  by?: Record<string, number>;
}
export interface UsageTotals {
  cost: number;
  requests: number;
  /** Requests billed to an API key — the denominator for average cost. A
   *  subscription-billed call is a real request but $0.00, and must not
   *  drag the average down. */
  billableRequests: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  users: number;
  /** Calls made on the operator's Claude plan (Sandbox agent runs):
   *  real tokens, $0.00 cost, and what they WOULD have cost — "saved". */
  subscription: SubscriptionTotals;
}
export interface UsageBreakdownRow {
  key: string;
  sub?: string;
  requests: number;
  in: number;
  out: number;
  cached: number;
  cost: number;
}
export interface UsageRecentRow {
  t: string;
  user: string;
  role: string;
  provider: string;
  model: string;
  in: number;
  out: number;
  cached: number;
  cost: number;
  /** "subscription" rows show as "plan" rather than a misleading $0.00. */
  billing: string;
}
export interface UsageSummary {
  range: UsageRangeKey;
  bucketMs: number;
  points: UsagePoint[];
  totals: UsageTotals;
  /** Same-length window immediately before this one (null for "all"). */
  prev: { cost: number; requests: number; in: number; out: number; notionalCost: number } | null;
  byRole: UsageBreakdownRow[];
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byUser: UsageBreakdownRow[];
  recent: UsageRecentRow[];
  /** The bands to draw in the cost chart, in order. Console only — a single
   *  portal has nothing to stack. */
  stack?: { key: string; label: string; color: string }[];
}

/** Coerce an untrusted `?range=` value to a supported one. */
export function parseRange(param: string | null | undefined): UsageRangeKey {
  return param === "all" || (param && param in RANGES) ? (param as UsageRangeKey) : "day";
}

/** The bucket grid a window is measured on. */
export interface UsageWindow {
  bucketMs: number;
  count: number;
}

/**
 * Resolve the bucket grid for a range.
 *
 * "all" has to look at the data (it spans from the first record ever), which
 * is why it is a query rather than a constant — bucketed to keep ~<=90 points,
 * day granularity minimum so short-lived instances still chart.
 */
export async function resolveWindow(
  db: PrismaClient,
  range: UsageRangeKey,
): Promise<UsageWindow> {
  if (range !== "all") return RANGES[range];
  const first = await db.usageRecord.findFirst({
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const spanMs = Math.max(DAY, Date.now() - (first?.createdAt.getTime() ?? Date.now()));
  const bucketMs = Math.max(DAY, Math.ceil(spanMs / 90 / DAY) * DAY);
  return { bucketMs, count: Math.min(120, Math.ceil(spanMs / bucketMs) + 1) };
}

/**
 * Everything the usage dashboard renders, for one database.
 *
 * `window` may be supplied to force a grid — the console passes one common
 * grid to every portal so their series can be summed point for point.
 */
export async function buildUsageSummary(
  db: PrismaClient,
  range: UsageRangeKey,
  window?: UsageWindow,
): Promise<UsageSummary> {
  const { bucketMs, count } = window ?? (await resolveWindow(db, range));
  const bucketSec = bucketMs / 1000;
  const nowBucket = Math.floor(Date.now() / bucketMs);
  const startBucket = nowBucket - (count - 1);
  // Totals use the SAME bucket-aligned start as the series, so the KPI cards
  // and the charts always agree to the penny.
  const start = new Date(startBucket * bucketMs);
  const prevStart = new Date(start.getTime() - count * bucketMs);
  const inWindow = { createdAt: { gte: start } };

  const [seriesRows, totals, prevTotals, billableCount, subAgg, byRole, byProvider, byModel, byUser, recentRows] =
    await Promise.all([
      db.$queryRaw<
        { bucket: bigint; tin: bigint; tout: bigint; tcached: bigint; cost: number; requests: bigint }[]
      >`
        select floor(extract(epoch from created_at) / ${bucketSec})::bigint as bucket,
               coalesce(sum(input_tokens), 0)::bigint as tin,
               coalesce(sum(output_tokens), 0)::bigint as tout,
               coalesce(sum(cache_read_tokens), 0)::bigint as tcached,
               coalesce(sum(cost_estimate), 0)::float8 as cost,
               count(*)::bigint as requests
        from usage_records
        where created_at >= ${start}
        group by 1
      `,
      db.usageRecord.aggregate({
        where: inWindow,
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costEstimate: true,
        },
        _count: true,
      }),
      range === "all"
        ? Promise.resolve(null)
        : db.usageRecord.aggregate({
            where: { createdAt: { gte: prevStart, lt: start } },
            _sum: { inputTokens: true, outputTokens: true, costEstimate: true, notionalCost: true },
            _count: true,
          }),
      // Billable vs subscription, for the honest average and the "saved" card.
      db.usageRecord.count({ where: { ...inWindow, billingSource: "api" } }),
      db.usageRecord.aggregate({
        where: { ...inWindow, billingSource: "subscription" },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, notionalCost: true },
        _count: true,
      }),
      db.usageRecord.groupBy({
        by: ["role"],
        where: inWindow,
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costEstimate: true },
        _count: true,
      }),
      db.usageRecord.groupBy({
        by: ["provider"],
        where: inWindow,
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costEstimate: true },
        _count: true,
      }),
      db.usageRecord.groupBy({
        by: ["provider", "model"],
        where: inWindow,
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costEstimate: true },
        _count: true,
      }),
      db.usageRecord.groupBy({
        by: ["userId"],
        where: inWindow,
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costEstimate: true },
        _count: true,
      }),
      db.usageRecord.findMany({
        where: inWindow,
        orderBy: { createdAt: "desc" },
        take: 25,
        include: { user: { select: { email: true } } },
      }),
    ]);

  const byBucket = new Map(seriesRows.map((r) => [Number(r.bucket), r]));
  const points: UsagePoint[] = [];
  for (let i = 0; i < count; i++) {
    const b = startBucket + i;
    const r = byBucket.get(b);
    points.push({
      t: new Date(b * bucketMs).toISOString(),
      in: r ? Number(r.tin) : 0,
      out: r ? Number(r.tout) : 0,
      cached: r ? Number(r.tcached) : 0,
      cost: r ? Number(r.cost) : 0,
      requests: r ? Number(r.requests) : 0,
    });
  }

  // Resolve user emails for the by-user breakdown (deleted accounts -> null id).
  const userIds = byUser.map((g) => g.userId).filter((id): id is string => !!id);
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  type Grouped = {
    _sum: {
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      costEstimate: unknown;
    };
    _count: number;
  };
  const toRow = (key: string, g: Grouped, sub?: string): UsageBreakdownRow => ({
    key,
    ...(sub ? { sub } : {}),
    requests: g._count,
    in: g._sum.inputTokens ?? 0,
    out: g._sum.outputTokens ?? 0,
    cached: g._sum.cacheReadTokens ?? 0,
    cost: Number(g._sum.costEstimate ?? 0),
  });
  const byCost = (a: UsageBreakdownRow, b: UsageBreakdownRow) => b.cost - a.cost;

  return {
    range,
    bucketMs,
    points,
    totals: {
      cost: Number(totals._sum.costEstimate ?? 0),
      requests: totals._count,
      billableRequests: billableCount,
      in: totals._sum.inputTokens ?? 0,
      out: totals._sum.outputTokens ?? 0,
      cacheRead: totals._sum.cacheReadTokens ?? 0,
      cacheWrite: totals._sum.cacheWriteTokens ?? 0,
      users: userIds.length,
      subscription: {
        requests: subAgg._count,
        in: subAgg._sum.inputTokens ?? 0,
        out: subAgg._sum.outputTokens ?? 0,
        cacheRead: subAgg._sum.cacheReadTokens ?? 0,
        notionalCost: Number(subAgg._sum.notionalCost ?? 0),
      },
    },
    prev: prevTotals
      ? {
          cost: Number(prevTotals._sum.costEstimate ?? 0),
          requests: prevTotals._count,
          in: prevTotals._sum.inputTokens ?? 0,
          out: prevTotals._sum.outputTokens ?? 0,
          notionalCost: Number(prevTotals._sum.notionalCost ?? 0),
        }
      : null,
    byRole: byRole.map((g) => toRow(g.role ?? "—", g)).sort(byCost),
    byProvider: byProvider.map((g) => toRow(g.provider, g)).sort(byCost),
    byModel: byModel.map((g) => toRow(g.model, g, g.provider)).sort(byCost).slice(0, 30),
    byUser: byUser
      .map((g) =>
        toRow(g.userId ? emailById.get(g.userId) ?? "(deleted user)" : "(deleted user)", g),
      )
      .sort(byCost)
      .slice(0, 50),
    recent: recentRows.map((r) => ({
      t: r.createdAt.toISOString(),
      user: r.user?.email ?? "(deleted user)",
      role: r.role ?? "—",
      provider: r.provider,
      model: r.model,
      in: r.inputTokens,
      out: r.outputTokens,
      cached: r.cacheReadTokens,
      cost: Number(r.costEstimate),
      billing: r.billingSource,
    })),
  };
}
