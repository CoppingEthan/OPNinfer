import { auth } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Time ranges → fixed bucket size + count (window = bucketMs × count). */
const RANGES = {
  hour: { bucketMs: 60_000, count: 60 }, // 60 × 1 min
  day: { bucketMs: 3_600_000, count: 24 }, // 24 × 1 hour
  week: { bucketMs: 21_600_000, count: 28 }, // 28 × 6 hours
  month: { bucketMs: 86_400_000, count: 30 }, // 30 × 1 day
  year: { bucketMs: 604_800_000, count: 52 }, // 52 × 1 week
} as const;
type RangeKey = keyof typeof RANGES;

/**
 * GET /api/admin/usage/series?range=hour|day|week|month|year — token throughput
 * over time, bucketed for a line chart. Returns a continuous series (empty
 * buckets filled with zeros) of input / output / cached token sums. Admin only.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const param = new URL(req.url).searchParams.get("range") as RangeKey | null;
  const range: RangeKey = param && param in RANGES ? param : "day";
  const { bucketMs, count } = RANGES[range];
  const bucketSec = bucketMs / 1000;

  const nowBucket = Math.floor(Date.now() / bucketMs);
  const startBucket = nowBucket - (count - 1);
  const startDate = new Date(startBucket * bucketMs);

  const rows = await db.$queryRaw<
    { bucket: bigint; tin: bigint; tout: bigint; tcached: bigint; cost: number; requests: bigint }[]
  >`
    select floor(extract(epoch from created_at) / ${bucketSec})::bigint as bucket,
           coalesce(sum(input_tokens), 0)::bigint as tin,
           coalesce(sum(output_tokens), 0)::bigint as tout,
           coalesce(sum(cache_read_tokens), 0)::bigint as tcached,
           coalesce(sum(cost_estimate), 0)::float8 as cost,
           count(*)::bigint as requests
    from usage_records
    where created_at >= ${startDate}
    group by 1
  `;

  const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
  const points = [];
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

  return Response.json({ range, bucketMs, points });
}
