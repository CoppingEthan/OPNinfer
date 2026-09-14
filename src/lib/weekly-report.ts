import "server-only";
import { db } from "@/lib/db";
import { getAgentLimits, getRateLimitHits } from "@/lib/agent/limits-store";
import { WINDOW_LABELS, WINDOW_ORDER, isStale } from "@/lib/agent/limits";
import { topPackageUses } from "@/lib/agent/packages-store";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { sendMail } from "@/lib/mailer";
import { weeklyReportEmail } from "@/lib/emails";
import { devLog } from "@/lib/dev-log";

/**
 * The Friday afternoon report.
 *
 * Chosen over hard spend caps (owner call): with a handful of client instances
 * on a ~£200/month budget, a weekly email that says what was spent, what broke,
 * and whether the plumbing is alive is more useful than a cap that cuts someone
 * off mid-conversation. It also closes the gap that let the ingestion worker sit
 * dead for eight days — nobody was being told anything.
 *
 * Timezone note: the schedule is real LOCAL time, not a stored UTC hour. The
 * backup scheduler stores `hourUtc`, which is fine for a backup but would make
 * this land at 17:00 in winter and 18:00 in summer. Wall-clock fields are read
 * through `Intl` in the configured zone, so 5pm Friday stays 5pm Friday.
 */

export interface WeeklyReportConfig {
  enabled: boolean;
  /** Where the report goes. Any address — not necessarily a portal user. */
  email: string;
  /** IANA zone the schedule is expressed in. */
  timeZone: string;
  /** Local weekday, "Mon".."Sun". */
  weekday: Weekday;
  /** Local hour, 0–23. The report goes out at or after this hour. */
  hourLocal: number;
  /** Local date (YYYY-MM-DD) of the last send — one report per local day. */
  lastRunLocalDate?: string;
  lastRunAt?: string;
}

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const DEFAULT_WEEKLY_REPORT_CONFIG: WeeklyReportConfig = {
  enabled: false,
  email: "",
  timeZone: "Europe/London",
  weekday: "Fri",
  hourLocal: 17,
};

// ---------------------------------------------------------------------------
// Scheduling (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface LocalParts {
  /** YYYY-MM-DD in the target zone. */
  date: string;
  weekday: Weekday;
  hour: number;
}

/** Wall-clock fields for an instant in a zone. DST-correct by construction:
 *  the zone database does the work, we never do arithmetic on offsets. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) got[p.type] = p.value;
  // en-GB gives "24" for midnight in some ICU versions; normalise to 0.
  const hour = Number(got.hour) % 24;
  return {
    date: `${got.year}-${got.month}-${got.day}`,
    weekday: got.weekday as Weekday,
    hour: Number.isFinite(hour) ? hour : 0,
  };
}

/**
 * Is a report due now?
 *
 * True on the configured weekday at or after the configured local hour, unless
 * one already went out on that same local date. Deliberately "at or after"
 * rather than "at": the tick is every few minutes and the box may be asleep or
 * mid-deploy at 17:00, and a report that silently skips a week is worse than
 * one that arrives at 17:20.
 */
export function isReportDue(
  now: Date,
  config: Pick<WeeklyReportConfig, "enabled" | "email" | "timeZone" | "weekday" | "hourLocal" | "lastRunLocalDate">,
): boolean {
  if (!config.enabled || !config.email) return false;
  const parts = localParts(now, config.timeZone);
  if (parts.weekday !== config.weekday) return false;
  if (parts.hour < config.hourLocal) return false;
  return config.lastRunLocalDate !== parts.date;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getWeeklyReportConfig(): Promise<WeeklyReportConfig> {
  const s = await getSetting<Partial<WeeklyReportConfig>>(SETTING_KEYS.weeklyReport);
  const hour = Number(s?.hourLocal);
  return {
    enabled: s?.enabled === true && !!s?.email,
    email: typeof s?.email === "string" ? s.email : "",
    timeZone: s?.timeZone || DEFAULT_WEEKLY_REPORT_CONFIG.timeZone,
    weekday: WEEKDAYS.includes(s?.weekday as Weekday)
      ? (s!.weekday as Weekday)
      : DEFAULT_WEEKLY_REPORT_CONFIG.weekday,
    hourLocal: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_WEEKLY_REPORT_CONFIG.hourLocal,
    lastRunLocalDate: s?.lastRunLocalDate,
    lastRunAt: s?.lastRunAt,
  };
}

export async function setWeeklyReportConfig(config: WeeklyReportConfig): Promise<void> {
  await setSetting(SETTING_KEYS.weeklyReport, config);
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

export interface SpendRow {
  label: string;
  cost: number;
  requests: number;
}

export interface ErrorRow {
  category: string;
  message: string;
  count: number;
  lastAt: Date;
}

export interface EngineProbe {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WeeklyReport {
  from: Date;
  to: Date;
  spend: {
    cost: number;
    previousCost: number;
    requests: number;
    activeUsers: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
  /** Sandbox agent runs on the operator's Claude plan: real tokens, no
   *  bill, and their API-rate value ("saved"). Owner ask, 2026-08-24. */
  subscription: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    notionalCost: number;
    previousNotionalCost: number;
    /** Runs that had to wait for the plan's limit this week. */
    rateLimitWaits: number;
    /** Distinct agent sessions (chats that used the Sandbox on the plan). */
    sessions: number;
    /** Distinct people whose Sandbox work ran on the plan. */
    users: number;
    /** Agent runs that fell back to the organisation's API key (billed). */
    apiFallback: { requests: number; cost: number };
    /** The plan's windows as last read (current session / weekly). */
    planUsage: { window: string; label: string; percentUsed?: number; resetsAt?: number }[];
    /** What the agent installed most this week (Admin → Sandbox has the full table). */
    topPackages: { name: string; kind: string; uses: number }[];
  };
  byUser: SpendRow[];
  byModel: SpendRow[];
  errors: ErrorRow[];
  errorTotal: number;
  health: {
    pendingFiles: number;
    stuckFiles: number;
    failedFiles: number;
    ingestedFiles: number;
    engines: EngineProbe[];
  };
}

/** Reachable = it answered at all. A 404 from a service still proves the
 *  process is up and routable, which is the question being asked. */
async function probe(name: string, url: string | undefined, path = ""): Promise<EngineProbe | null> {
  if (!url) return null;
  const target = `${url.replace(/\/+$/, "")}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    return { name, ok: true, detail: `HTTP ${res.status} in ${Date.now() - started}ms` };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : "unreachable" };
  }
}

/** Files claimed by the worker but never finished. The single clearest signal
 *  that ingestion has stopped: uploads pile up in `processing` forever. */
const STUCK_AFTER_MS = 15 * 60_000;

export async function collectWeeklyReport(now = new Date()): Promise<WeeklyReport> {
  const to = now;
  const from = new Date(to.getTime() - 7 * 24 * 3_600_000);
  const prevFrom = new Date(from.getTime() - 7 * 24 * 3_600_000);
  const stuckBefore = new Date(to.getTime() - STUCK_AFTER_MS);

  const [rows, prevAgg, logs, users, pendingFiles, stuckFiles, failedFiles, ingestedFiles] =
    await Promise.all([
      db.usageRecord.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: {
          userId: true,
          model: true,
          costEstimate: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          billingSource: true,
          notionalCost: true,
          agentSessionId: true,
          role: true,
        },
      }),
      db.usageRecord.aggregate({
        where: { createdAt: { gte: prevFrom, lt: from } },
        _sum: { costEstimate: true, notionalCost: true },
      }),
      db.appLog.findMany({
        where: { level: "error", createdAt: { gte: from, lte: to } },
        select: { category: true, message: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 2_000,
      }),
      db.user.findMany({ select: { id: true, name: true, email: true } }),
      db.file.count({ where: { status: "pending" } }),
      db.file.count({
        where: { status: "processing", claimedAt: { lt: stuckBefore } },
      }),
      db.file.count({ where: { status: "failed", createdAt: { gte: from } } }),
      db.file.count({
        where: { status: { in: ["ready", "unsupported"] }, createdAt: { gte: from } },
      }),
    ]);

  const userLabel = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));

  const spend = {
    cost: 0,
    previousCost: Number(prevAgg._sum.costEstimate ?? 0),
    requests: rows.length,
    activeUsers: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };
  const perUser = new Map<string, SpendRow>();
  const perModel = new Map<string, SpendRow>();
  const seenUsers = new Set<string>();
  const subscription = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    notionalCost: 0,
    previousNotionalCost: Number(prevAgg._sum.notionalCost ?? 0),
    rateLimitWaits: 0,
    sessions: 0,
    users: 0,
    apiFallback: { requests: 0, cost: 0 },
    planUsage: [] as { window: string; label: string; percentUsed?: number; resetsAt?: number }[],
    topPackages: [] as { name: string; kind: string; uses: number }[],
  };
  const planSessions = new Set<string>();
  const planUsers = new Set<string>();

  for (const r of rows) {
    const cost = Number(r.costEstimate);
    spend.cost += cost;
    spend.inputTokens += r.inputTokens;
    spend.outputTokens += r.outputTokens;
    spend.cachedTokens += r.cacheReadTokens + r.cacheWriteTokens;
    if (r.userId) seenUsers.add(r.userId);
    if (r.billingSource === "subscription") {
      subscription.requests++;
      subscription.inputTokens += r.inputTokens;
      subscription.outputTokens += r.outputTokens;
      subscription.cachedTokens += r.cacheReadTokens + r.cacheWriteTokens;
      subscription.notionalCost += Number(r.notionalCost ?? 0);
      if (r.agentSessionId) planSessions.add(r.agentSessionId);
      if (r.userId) planUsers.add(r.userId);
    } else if (r.role === "agent") {
      // A Sandbox run billed to the org key — the fallback path.
      subscription.apiFallback.requests++;
      subscription.apiFallback.cost += cost;
    }

    const uKey = r.userId ? (userLabel.get(r.userId) ?? "(deleted account)") : "(deleted account)";
    const u = perUser.get(uKey) ?? { label: uKey, cost: 0, requests: 0 };
    u.cost += cost;
    u.requests++;
    perUser.set(uKey, u);

    const m = perModel.get(r.model) ?? { label: r.model, cost: 0, requests: 0 };
    m.cost += cost;
    m.requests++;
    perModel.set(r.model, m);
  }
  spend.activeUsers = seenUsers.size;

  // Group errors the same way the alert throttle does, so the weekly digest
  // and the live alerts agree on what counts as "the same error".
  const grouped = new Map<string, ErrorRow>();
  for (const l of logs) {
    const key = `${l.category}:${l.message.slice(0, 120)}`;
    const row = grouped.get(key) ?? {
      category: l.category,
      message: l.message.slice(0, 200),
      count: 0,
      lastAt: l.createdAt,
    };
    row.count++;
    if (l.createdAt > row.lastAt) row.lastAt = l.createdAt;
    grouped.set(key, row);
  }

  const engines = (
    await Promise.all([
      probe("Speech-to-text (Whisper)", process.env.WHISPER_URL),
      probe("Text-to-speech (Kokoro)", process.env.TTS_URL),
      probe("Sandbox broker", process.env.SANDBOX_BROKER_URL, "/health"),
    ])
  ).filter((p): p is EngineProbe => p !== null);

  subscription.rateLimitWaits = (await getRateLimitHits(to)).week;
  subscription.sessions = planSessions.size;
  subscription.users = planUsers.size;
  // The plan's windows as last read — a window whose reset time has passed
  // is skipped (its percentage no longer means anything).
  const limits = await getAgentLimits();
  subscription.planUsage = WINDOW_ORDER.filter((w) => limits[w] && !isStale(limits[w]!, to.getTime())).map((w) => ({
    window: w,
    label: WINDOW_LABELS[w],
    percentUsed: limits[w]!.percentUsed,
    resetsAt: limits[w]!.resetsAt,
  }));
  subscription.topPackages = (await topPackageUses({ days: 7, limit: 5 }))
    .filter((t) => t.kind !== "download" && t.kind !== "git")
    .map((t) => ({ name: t.name, kind: t.kind, uses: t.uses }));

  const byCost = (a: SpendRow, b: SpendRow) => b.cost - a.cost;
  return {
    from,
    to,
    spend,
    subscription,
    byUser: [...perUser.values()].sort(byCost).slice(0, 20),
    byModel: [...perModel.values()].sort(byCost).slice(0, 20),
    errors: [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    errorTotal: logs.length,
    health: { pendingFiles, stuckFiles, failedFiles, ingestedFiles, engines },
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Build and send the report now, regardless of schedule. Used by the
 *  scheduler and by the admin "Send one now" button. */
export async function sendWeeklyReport(to: string, now = new Date(), opts: { test?: boolean } = {}): Promise<void> {
  const report = await collectWeeklyReport(now);
  const mail = await weeklyReportEmail(report, opts);
  await sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
}

const TICK_MS = 5 * 60_000;
const globalForScheduler = globalThis as {
  __oiWeeklyReportTimer?: ReturnType<typeof setInterval>;
};

async function tick(): Promise<void> {
  try {
    const config = await getWeeklyReportConfig();
    const now = new Date();
    if (!isReportDue(now, config)) return;

    // Stamp BEFORE sending: a send that throws must not leave the job due, or
    // a persistently failing relay would retry every tick for the rest of the
    // day. The failure is logged instead — and error alerts pick that up.
    const date = localParts(now, config.timeZone).date;
    await setWeeklyReportConfig({
      ...config,
      lastRunLocalDate: date,
      lastRunAt: now.toISOString(),
    });
    await sendWeeklyReport(config.email, now);
    devLog("info", "report", "weekly report sent", { to: config.email, localDate: date });
  } catch (e) {
    // Console + dev log only, deliberately: routing this through appLog("error")
    // would trip the error-alert email, so a broken report would generate mail
    // about itself. Same rule as alerts.ts.
    console.error(
      "[weekly-report] could not send:",
      e instanceof Error ? e.message : String(e),
    );
    devLog("error", "report", "weekly report failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Start the in-process scheduler (no-op unless enabled in Admin → SMTP). */
export function startWeeklyReportScheduler(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalForScheduler.__oiWeeklyReportTimer) return; // survive dev hot-reload
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  globalForScheduler.__oiWeeklyReportTimer = timer;
  // A delayed first check so a report missed while the box was down still goes
  // out shortly after boot (same shape as the backup scheduler).
  setTimeout(() => void tick(), 45_000).unref?.();
}
