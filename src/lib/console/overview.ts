import "server-only";
import type { PrismaClient } from "@prisma/client";
import { fanOut, type InstanceResult } from "./db";
import { parseLimitState, type AgentLimitState } from "@/lib/agent/limits";

/**
 * The console's front page: one row per portal, plus the combined totals.
 *
 * Everything here is an indexed aggregate — no table scans over messages, no
 * per-row work — because this page auto-refreshes and runs against four live
 * client databases at once. The console must never be the reason a portal is
 * slow for the people actually using it.
 */

/** How far back "recent" reaches for the headline numbers. */
export const OVERVIEW_RANGES = {
  day: { label: "24 hours", ms: 86_400_000 },
  week: { label: "7 days", ms: 7 * 86_400_000 },
  month: { label: "30 days", ms: 30 * 86_400_000 },
} as const;
export type OverviewRangeKey = keyof typeof OVERVIEW_RANGES;

export function parseOverviewRange(v: string | null | undefined): OverviewRangeKey {
  return v && v in OVERVIEW_RANGES ? (v as OverviewRangeKey) : "week";
}

export interface PortalSnapshot {
  /** Spend and volume inside the selected window. */
  cost: number;
  requests: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  activeUsers: number;
  /** Sandbox runs on the operator's Claude plan: $0 billed, this much saved. */
  planRequests: number;
  planSaved: number;
  errors: number;
  warnings: number;

  /** Current state, not windowed. */
  users: number;
  disabledUsers: number;
  chats: number;
  messages: number;

  /** Ingestion health — a queue that stops draining is the classic silent
   *  failure here (a worker sat unable to reach its database for 8 days). */
  filesPending: number;
  filesProcessing: number;
  filesFailed: number;

  /** Newest message anywhere in the portal — "is anyone actually using it". */
  lastMessageAt: string | null;
  /** The plan reading this portal last recorded, if it runs the Sandbox. */
  plan: AgentLimitState | null;
}

export interface Overview {
  range: OverviewRangeKey;
  since: string;
  portals: InstanceResult<PortalSnapshot>[];
  totals: {
    cost: number;
    requests: number;
    inTokens: number;
    outTokens: number;
    activeUsers: number;
    planSaved: number;
    errors: number;
    users: number;
    chats: number;
    messages: number;
    /** Files waiting to be processed — a queue that is not draining. */
    filesPending: number;
    /** Files that will never process without intervention. Not a queue problem. */
    filesFailed: number;
  };
  /** Portals that could not be read at all. */
  unreachable: number;
}

export async function readSnapshot(db: PrismaClient, since: Date): Promise<PortalSnapshot> {
  const inWindow = { createdAt: { gte: since } };

  const [
    usage,
    sub,
    activeUsers,
    logLevels,
    users,
    disabledUsers,
    chats,
    messages,
    files,
    lastMessage,
    planRow,
  ] = await Promise.all([
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
    db.usageRecord.aggregate({
      where: { ...inWindow, billingSource: "subscription" },
      _sum: { notionalCost: true },
      _count: true,
    }),
    db.$queryRaw<{ n: bigint }[]>`
      select count(distinct user_id)::bigint as n
      from usage_records
      where created_at >= ${since} and user_id is not null
    `,
    db.appLog.groupBy({ by: ["level"], where: inWindow, _count: true }),
    db.user.count(),
    db.user.count({ where: { disabled: true } }),
    db.conversation.count(),
    db.message.count(),
    db.file.groupBy({ by: ["status"], _count: true }),
    db.message.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.setting.findUnique({ where: { key: "agent_rate_limits" }, select: { value: true } }),
  ]);

  const level = (l: string) => logLevels.find((r) => r.level === l)?._count ?? 0;
  const fileCount = (s: string) => files.find((r) => r.status === s)?._count ?? 0;

  return {
    cost: Number(usage._sum.costEstimate ?? 0),
    requests: usage._count,
    inTokens: usage._sum.inputTokens ?? 0,
    outTokens: usage._sum.outputTokens ?? 0,
    cacheReadTokens: usage._sum.cacheReadTokens ?? 0,
    cacheWriteTokens: usage._sum.cacheWriteTokens ?? 0,
    activeUsers: Number(activeUsers[0]?.n ?? 0),
    planRequests: sub._count,
    planSaved: Number(sub._sum.notionalCost ?? 0),
    errors: level("error"),
    warnings: level("warn"),
    users,
    disabledUsers,
    chats,
    messages,
    filesPending: fileCount("pending"),
    filesProcessing: fileCount("processing"),
    filesFailed: fileCount("failed"),
    lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
    // A portal that has never run the Sandbox has no row — null, not zeroes,
    // so the UI can say "not used here" instead of "0% of your plan".
    plan: planRow ? parseLimitState(planRow.value) : null,
  };
}

export async function getOverview(range: OverviewRangeKey): Promise<Overview> {
  const since = new Date(Date.now() - OVERVIEW_RANGES[range].ms);
  const portals = await fanOut((db) => readSnapshot(db, since));

  const totals = portals.reduce(
    (acc, p) => {
      const d = p.data;
      if (!d) return acc;
      acc.cost += d.cost;
      acc.requests += d.requests;
      acc.inTokens += d.inTokens;
      acc.outTokens += d.outTokens;
      // Summed, not de-duplicated: a person with accounts on two portals is
      // two users here, because they ARE two accounts on two systems.
      acc.activeUsers += d.activeUsers;
      acc.planSaved += d.planSaved;
      acc.errors += d.errors;
      acc.users += d.users;
      acc.chats += d.chats;
      acc.messages += d.messages;
      // Pending and failed are DIFFERENT problems and must not be added
      // together (2026-09-07): four PDFs that failed OCR weeks ago were
      // reported as "stuck in ingestion", which reads as a stalled queue and
      // would have sat on this page for ever. A pending file is a queue that
      // is not draining — worth alarm. A failed one is history — worth
      // knowing, not worth a red number.
      acc.filesPending += d.filesPending + d.filesProcessing;
      acc.filesFailed += d.filesFailed;
      return acc;
    },
    {
      cost: 0,
      requests: 0,
      inTokens: 0,
      outTokens: 0,
      activeUsers: 0,
      planSaved: 0,
      errors: 0,
      users: 0,
      chats: 0,
      messages: 0,
      filesPending: 0,
      filesFailed: 0,
    },
  );

  return {
    range,
    since: since.toISOString(),
    portals,
    totals,
    unreachable: portals.filter((p) => p.error).length,
  };
}
