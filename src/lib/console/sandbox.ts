import "server-only";
import { fanOut } from "./db";
import { parseLimitState, type AgentLimitState } from "@/lib/agent/limits";

/**
 * The Sandbox agent tier, seen across the whole estate.
 *
 * This is the view no single portal can produce. Every instance signs in to
 * the SAME Anthropic account for its agent runs, so the five-hour and weekly
 * plan windows are ONE shared pool that four portals draw on — and each
 * portal's own admin page can only ever show the reading it happened to
 * record last. Side by side, they say who is spending the plan.
 *
 * The other half is money: a run that cannot use the plan (spent, or a
 * sign-in Anthropic has rotated) falls back to the org API key and starts
 * costing real money quietly. `billing_source` makes that visible per portal
 * — the fallback billed $15.10 in one day on a live portal before anyone noticed.
 */

export interface PortalSandbox {
  plan: AgentLimitState | null;
  /** Distinct agent sessions in the window. */
  sessions: number;
  /** Calls attributable to an agent run. */
  requests: number;
  /** Runs that used the shared plan: $0 billed, this much saved. */
  planRequests: number;
  planSaved: number;
  /** Runs that fell back to the org API key: real money. */
  apiRequests: number;
  apiCost: number;
  /** People who triggered a run. */
  users: number;
  /** ERROR-level `agent` rows — a lost sign-in, a plan limit, a broken MCP. */
  errors: { message: string; count: number; last: string }[];
  /** What the agent reached for, so the next image bake-in can be decided. */
  packages: { kind: string; name: string; count: number }[];
}

export const SANDBOX_RANGES = {
  week: { label: "7 days", ms: 7 * 86_400_000 },
  month: { label: "30 days", ms: 30 * 86_400_000 },
} as const;
export type SandboxRangeKey = keyof typeof SANDBOX_RANGES;
export function parseSandboxRange(v: string | null | undefined): SandboxRangeKey {
  return v && v in SANDBOX_RANGES ? (v as SandboxRangeKey) : "week";
}

export interface SandboxView {
  range: SandboxRangeKey;
  portals: { portal: string; label: string; data: PortalSandbox }[];
  totals: { sessions: number; planSaved: number; apiCost: number; apiRequests: number };
  errors: { portal: string; error: string }[];
}

export async function getSandbox(range: SandboxRangeKey): Promise<SandboxView> {
  const since = new Date(Date.now() - SANDBOX_RANGES[range].ms);

  const results = await fanOut(async (db) => {
    const agentWindow = { createdAt: { gte: since }, agentSessionId: { not: null } };
    const [planRow, sessions, plan, api, packages, errorRows] = await Promise.all([
      db.setting.findUnique({ where: { key: "agent_rate_limits" }, select: { value: true } }),
      db.$queryRaw<{ sessions: bigint; users: bigint }[]>`
        select count(distinct agent_session_id)::bigint as sessions,
               count(distinct user_id)::bigint as users
        from usage_records
        where created_at >= ${since} and agent_session_id is not null
      `,
      db.usageRecord.aggregate({
        where: { ...agentWindow, billingSource: "subscription" },
        _sum: { notionalCost: true },
        _count: true,
      }),
      db.usageRecord.aggregate({
        where: { ...agentWindow, billingSource: "api" },
        _sum: { costEstimate: true },
        _count: true,
      }),
      db.agentPackageUse.groupBy({
        by: ["kind", "name"],
        where: { createdAt: { gte: since } },
        _count: true,
        orderBy: { _count: { name: "desc" } },
        take: 25,
      }),
      db.appLog.groupBy({
        by: ["message"],
        where: { category: "agent", level: "error", createdAt: { gte: since } },
        _count: true,
        _max: { createdAt: true },
      }),
    ]);

    const data: PortalSandbox = {
      plan: planRow ? parseLimitState(planRow.value) : null,
      sessions: Number(sessions[0]?.sessions ?? 0),
      users: Number(sessions[0]?.users ?? 0),
      requests: plan._count + api._count,
      planRequests: plan._count,
      planSaved: Number(plan._sum.notionalCost ?? 0),
      apiRequests: api._count,
      apiCost: Number(api._sum.costEstimate ?? 0),
      errors: errorRows
        .map((r) => ({
          message: r.message,
          count: r._count,
          last: r._max.createdAt?.toISOString() ?? "",
        }))
        .sort((a, b) => b.count - a.count),
      packages: packages.map((p) => ({ kind: p.kind, name: p.name, count: p._count })),
    };
    return data;
  });

  const portals = results
    .filter((r) => r.data)
    .map((r) => ({ portal: r.instance.name, label: r.instance.label, data: r.data! }));

  return {
    range,
    portals,
    totals: {
      sessions: portals.reduce((n, p) => n + p.data.sessions, 0),
      planSaved: portals.reduce((n, p) => n + p.data.planSaved, 0),
      apiCost: portals.reduce((n, p) => n + p.data.apiCost, 0),
      apiRequests: portals.reduce((n, p) => n + p.data.apiRequests, 0),
    },
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}
