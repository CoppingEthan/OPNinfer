/**
 * Subscription usage tracking — the pure core.
 *
 * On a subscription there is no bill to watch, so the thing that actually
 * constrains you is your PLAN'S LIMITS: a rolling five-hour session window and
 * a seven-day window, which is what claude.ai shows as "Current session" and
 * "Weekly limits". The Agent SDK reports both on every run, unprompted, as
 * `rate_limit_event` messages carrying an `SDKRateLimitInfo`.
 *
 * This module normalises those into something storable and renderable, and is
 * deliberately dependency-free so the rules (which window is which, how to
 * express utilisation, when a snapshot is stale) are unit-tested rather than
 * trusted. Mirrors the ask.ts / tool-run.ts pattern: pure core here, the
 * persistence and UI around it.
 */

/** The windows a plan is metered on. `five_hour` is the session window;
 *  the `seven_day*` family is the weekly one, sometimes split per model. */
export type AgentLimitWindow =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "seven_day_overage_included"
  | "overage";

/** How the plan is currently answering: fine, close to the line, or refusing. */
export type AgentLimitStatus = "allowed" | "allowed_warning" | "rejected";

/** One window's state at a moment in time. */
export interface AgentLimitSnapshot {
  window: AgentLimitWindow;
  status: AgentLimitStatus;
  /** 0–100. Absent when the provider didn't say. */
  percentUsed?: number;
  /** Epoch ms when this window resets. */
  resetsAt?: number;
  /** Epoch ms this snapshot was taken (ours, not the provider's). */
  observedAt: number;
  /** Epoch ms each alert was raised for this window (owner ask 2026-09-02:
   *  an email at 90% and when the limit is hit). Cleared when the window
   *  rolls over, so each window alerts once per threshold. */
  alerted?: { warn?: number; limit?: number };
}

/** Human labels, matching what claude.ai calls these windows so the admin
 *  panel and the Anthropic usage screen agree. */
export const WINDOW_LABELS: Record<AgentLimitWindow, string> = {
  five_hour: "Current session",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · included overage",
  overage: "Overage",
};

/** Order to render in: session first, then the weekly family. */
export const WINDOW_ORDER: AgentLimitWindow[] = [
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_overage_included",
  "overage",
];

const VALID_WINDOWS = new Set<string>(WINDOW_ORDER);
const VALID_STATUS = new Set<string>(["allowed", "allowed_warning", "rejected"]);

/**
 * Normalise one `rate_limit_event`'s payload.
 *
 * Returns null for anything unusable rather than guessing — an unknown window
 * name from a future plan type is better dropped than rendered as a mystery
 * bar. Two shape questions the provider leaves open and we settle here:
 * `utilization` may arrive as a FRACTION (0–1) or a PERCENTAGE (0–100), and
 * `resetsAt` may be epoch SECONDS or MILLISECONDS.
 */
export function parseRateLimitInfo(
  info: unknown,
  observedAt: number = Date.now(),
): AgentLimitSnapshot | null {
  if (!info || typeof info !== "object") return null;
  const r = info as Record<string, unknown>;

  const window = typeof r.rateLimitType === "string" ? r.rateLimitType : null;
  if (!window || !VALID_WINDOWS.has(window)) return null;

  const status = typeof r.status === "string" && VALID_STATUS.has(r.status) ? r.status : "allowed";

  const snap: AgentLimitSnapshot = {
    window: window as AgentLimitWindow,
    status: status as AgentLimitStatus,
    observedAt,
  };

  if (typeof r.utilization === "number" && Number.isFinite(r.utilization)) {
    // A value at or below 1 is ambiguous — 1 could be "1%" or "100%". Treat
    // <= 1 as a fraction, which is the documented shape; the only cost of
    // being wrong is that a genuine 1% reads as 100% for one snapshot, and
    // erring toward "you are near the limit" is the safer direction.
    const raw = r.utilization <= 1 ? r.utilization * 100 : r.utilization;
    snap.percentUsed = Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
  }

  if (typeof r.resetsAt === "number" && Number.isFinite(r.resetsAt) && r.resetsAt > 0) {
    // Anything below this is far too small to be milliseconds (it would be
    // 1970), so it is seconds.
    snap.resetsAt = r.resetsAt < 1e12 ? Math.round(r.resetsAt * 1000) : Math.round(r.resetsAt);
  }

  return snap;
}

/** The stored shape: the latest snapshot per window, newest wins. */
/**
 * The plan's OWN usage screen, via the SDK's (experimental) `/usage` data
 * (2026-09-02, owner: "the Claude app shows 10% but the panel shows
 * nothing"). The per-request rate-limit event only carries a percentage once
 * the plan is near its line — at 10% it sends the window and reset time and
 * nothing else — whereas this endpoint reports every window with a real
 * 0–100 figure, the same numbers claude.ai draws. Pure; tolerant of nulls.
 */
export function parsePlanUsage(raw: unknown, observedAt: number = Date.now()): AgentLimitSnapshot[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { rate_limits?: Record<string, unknown> | null };
  if (!r.rate_limits || typeof r.rate_limits !== "object") return [];
  const out: AgentLimitSnapshot[] = [];
  for (const w of ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"] as const) {
    const v = r.rate_limits[w];
    if (!v || typeof v !== "object") continue;
    const { utilization, resets_at } = v as { utilization?: unknown; resets_at?: unknown };
    const snap: AgentLimitSnapshot = { window: w, status: "allowed", observedAt };
    if (typeof utilization === "number" && Number.isFinite(utilization)) {
      const pct = Math.min(100, Math.max(0, Math.round(utilization * 10) / 10)); // documented 0–100
      snap.percentUsed = pct;
      snap.status = pct >= 100 ? "rejected" : pct >= 90 ? "allowed_warning" : "allowed";
    }
    if (typeof resets_at === "string") {
      const t = Date.parse(resets_at);
      if (Number.isFinite(t) && t > 0) snap.resetsAt = t;
    } else if (typeof resets_at === "number" && Number.isFinite(resets_at) && resets_at > 0) {
      snap.resetsAt = resets_at < 1e12 ? Math.round(resets_at * 1000) : Math.round(resets_at);
    }
    out.push(snap);
  }
  return out;
}

export type AgentLimitState = Partial<Record<AgentLimitWindow, AgentLimitSnapshot>>;

/**
 * Fold a new snapshot into the stored state.
 *
 * Out-of-order arrival is real (runs overlap, and a slow run's event can land
 * after a fast one's), so an OLDER observation never overwrites a newer one.
 */
export function mergeLimitSnapshot(
  state: AgentLimitState,
  snap: AgentLimitSnapshot,
): AgentLimitState {
  const existing = state[snap.window];
  if (existing && existing.observedAt > snap.observedAt) return state;
  // Alert flags belong to a WINDOW (same reset time): carry them across
  // readings of that window, drop them once it has rolled over.
  // "Same window" is a reset time within a few minutes: the per-request
  // event rounds to seconds and the usage screen gives an ISO string, and
  // they must not read as two windows (which re-raised every alert).
  const sameWindow =
    existing?.alerted &&
    (existing.resetsAt === undefined ||
      snap.resetsAt === undefined ||
      Math.abs(existing.resetsAt - snap.resetsAt) < SAME_WINDOW_TOLERANCE_MS);
  const merged: AgentLimitSnapshot = sameWindow ? { ...snap, alerted: { ...existing!.alerted, ...snap.alerted } } : snap;
  return { ...state, [snap.window]: merged };
}

/** Reset times this close together are one window (see mergeLimitSnapshot). */
export const SAME_WINDOW_TOLERANCE_MS = 5 * 60_000;

export interface PlanAlert {
  window: AgentLimitWindow;
  kind: "warn" | "limit";
  percentUsed?: number;
  resetsAt?: number;
}

/** Threshold for the "nearing the limit" alert. */
/**
 * How old the newest reading FROM THE PLAN'S USAGE SCREEN is, in ms — or
 * null if there has never been one.
 *
 * Told apart from the per-request `rate_limit_event` by the presence of a
 * percentage: the event reports a window's status and reset time but only
 * carries a number when the plan is near its limit, while the usage screen
 * gives a real 0-100 for every window. That distinction is what the panel
 * and the 90% alert email actually need, so it is what "fresh" has to mean.
 *
 * (An event that DOES carry a percentage counts as fresh here. Near the
 * limit that reading is the one that matters anyway; the only effect is to
 * postpone a screen read at exactly the moment its number would not change
 * the outcome.)
 */
export function planUsageAge(state: AgentLimitState, now: number = Date.now()): number | null {
  let newest: number | null = null;
  for (const snap of Object.values(state)) {
    if (!snap || typeof snap.percentUsed !== "number") continue;
    if (newest === null || snap.observedAt > newest) newest = snap.observedAt;
  }
  return newest === null ? null : Math.max(0, now - newest);
}

export const PLAN_WARN_PERCENT = 90;

/**
 * Which alerts to raise for the current state, and the state with them
 * marked as raised. Pure. One "warn" per window at ≥90%, one "limit" when
 * the plan refuses (status rejected, or 100%); the warn flag clears again
 * below 85% (hysteresis), the limit flag below 95%, and both clear when the
 * window rolls over (see mergeLimitSnapshot).
 */
export function planAlerts(state: AgentLimitState, now: number = Date.now()): { state: AgentLimitState; alerts: PlanAlert[] } {
  const alerts: PlanAlert[] = [];
  const next: AgentLimitState = { ...state };
  for (const snap of Object.values(state)) {
    if (!snap) continue;
    if (isStale(snap, now)) continue; // rolled over — nothing to say until a fresh reading
    const pct = snap.percentUsed;
    const atLimit = snap.status === "rejected" || (typeof pct === "number" && pct >= 100);
    const nearing = typeof pct === "number" && pct >= PLAN_WARN_PERCENT;
    const alerted = { ...(snap.alerted ?? {}) };
    if (typeof pct === "number" && pct < 85) delete alerted.warn;
    if (typeof pct === "number" && pct < 95 && snap.status !== "rejected") delete alerted.limit;
    if (atLimit && !alerted.limit) {
      alerted.limit = now;
      alerts.push({ window: snap.window, kind: "limit", ...(typeof pct === "number" ? { percentUsed: pct } : {}), ...(snap.resetsAt ? { resetsAt: snap.resetsAt } : {}) });
    } else if (nearing && !atLimit && !alerted.warn && !alerted.limit) {
      alerted.warn = now;
      alerts.push({ window: snap.window, kind: "warn", percentUsed: pct, ...(snap.resetsAt ? { resetsAt: snap.resetsAt } : {}) });
    }
    next[snap.window] = Object.keys(alerted).length ? { ...snap, alerted } : (({ alerted: _a, ...rest }) => rest)(snap);
  }
  return { state: next, alerts };
}

/** Read stored state defensively — a malformed row renders as "no data yet"
 *  rather than throwing on an admin page. */
export function parseLimitState(raw: unknown): AgentLimitState {
  if (!raw || typeof raw !== "object") return {};
  const out: AgentLimitState = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_WINDOWS.has(k) || !v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    if (typeof s.observedAt !== "number") continue;
    out[k as AgentLimitWindow] = {
      window: k as AgentLimitWindow,
      status: VALID_STATUS.has(String(s.status)) ? (s.status as AgentLimitStatus) : "allowed",
      observedAt: s.observedAt,
      ...(typeof s.percentUsed === "number" ? { percentUsed: s.percentUsed } : {}),
      ...(typeof s.resetsAt === "number" ? { resetsAt: s.resetsAt } : {}),
      ...(s.alerted && typeof s.alerted === "object"
        ? {
            alerted: {
              ...(typeof (s.alerted as { warn?: unknown }).warn === "number" ? { warn: (s.alerted as { warn: number }).warn } : {}),
              ...(typeof (s.alerted as { limit?: unknown }).limit === "number" ? { limit: (s.alerted as { limit: number }).limit } : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

/**
 * A window whose reset time has passed is spent information: the window has
 * rolled over and the real utilisation is now lower (usually zero), so
 * showing the old percentage would overstate how constrained you are.
 */
export function isStale(snap: AgentLimitSnapshot, now: number = Date.now()): boolean {
  return typeof snap.resetsAt === "number" && snap.resetsAt <= now;
}

/** "in 2h 15m" / "in 3 days" / "resetting" — for the panel's reset line. */
export function formatResetIn(resetsAt: number | undefined, now: number = Date.now()): string {
  if (typeof resetsAt !== "number") return "";
  const ms = resetsAt - now;
  if (ms <= 0) return "resetting";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** The windows worth showing, in order, with stale ones dropped. */
export function visibleLimits(
  state: AgentLimitState,
  now: number = Date.now(),
): AgentLimitSnapshot[] {
  return WINDOW_ORDER.map((w) => state[w]).filter(
    (s): s is AgentLimitSnapshot => !!s && !isStale(s, now),
  );
}
