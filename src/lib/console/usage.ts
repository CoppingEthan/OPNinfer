import "server-only";
import { fanOut } from "./db";
import {
  RANGES,
  buildUsageSummary,
  type UsageRangeKey,
  type UsageSummary,
  type UsageWindow,
} from "@/lib/usage-summary";
import { mergeSummaries } from "./merge";

/**
 * The usage dashboard, run across every portal and merged.
 *
 * The merge only works because every portal is asked for the SAME bucket grid
 * (`UsageWindow`): the per-portal series then line up point for point and can
 * be summed. Left to itself each portal would pick its own grid for "all"
 * (derived from ITS first record), and four charts drawn on four different
 * time bases cannot be added together.
 *
 * Per-portal summaries are kept alongside the merged one — the combined view
 * answers "what are we spending", the split answers "on whom".
 */

export interface ConsoleUsage {
  range: UsageRangeKey;
  /** All portals summed — same shape the per-portal dashboard renders. */
  combined: UsageSummary;
  /** One row per portal, ordered by spend. */
  portals: { portal: string; label: string; summary: UsageSummary }[];
  errors: { portal: string; error: string }[];
}

const DAY = 86_400_000;

/**
 * One bucket grid for every portal.
 *
 * For "all" that means the earliest record ANYWHERE — asking each portal for
 * its own start would give a newer instance a coarser or finer bucket than
 * its neighbours.
 */
async function commonWindow(range: UsageRangeKey): Promise<UsageWindow> {
  if (range !== "all") return RANGES[range];
  const firsts = await fanOut(async (db) => {
    const row = await db.usageRecord.findFirst({
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    return row?.createdAt.getTime() ?? null;
  });
  const earliest = firsts
    .map((f) => f.data)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b)[0];
  const spanMs = Math.max(DAY, Date.now() - (earliest ?? Date.now()));
  const bucketMs = Math.max(DAY, Math.ceil(spanMs / 90 / DAY) * DAY);
  return { bucketMs, count: Math.min(120, Math.ceil(spanMs / bucketMs) + 1) };
}

export async function getConsoleUsage(range: UsageRangeKey): Promise<ConsoleUsage> {
  const window = await commonWindow(range);
  const results = await fanOut((db) => buildUsageSummary(db, range, window));

  const portals = results
    .filter((r) => r.data)
    .map((r) => ({ portal: r.instance.name, label: r.instance.label, summary: r.data! }))
    .sort((a, b) => b.summary.totals.cost - a.summary.totals.cost);

  return {
    range,
    combined: mergeSummaries(
      portals.map((p) => p.summary),
      range,
      window,
      portals.map((p) => p.label),
    ),
    portals,
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}
