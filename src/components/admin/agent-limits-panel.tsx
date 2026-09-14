"use client";

import {
  WINDOW_LABELS,
  formatResetIn,
  visibleLimits,
  type AgentLimitState,
} from "@/lib/agent/limits";

/**
 * Subscription usage, in the shape claude.ai shows it: a bar per metered
 * window with the percentage used and when it resets.
 *
 * Why this exists at all: on a subscription there is no bill to watch, so a
 * cost dashboard says nothing useful (every agent row is $0.00). What
 * genuinely constrains the instance is the plan's own session and weekly
 * windows — and hitting one mid-task looks, from the chat, like the assistant
 * silently stopped working. This is the subscription's equivalent of a spend
 * chart.
 *
 * The numbers come from the runs themselves (the SDK reports them on every
 * agent run), so the panel is honest about being a LAST-SEEN reading rather
 * than a live poll: nothing here calls Anthropic.
 */
export function AgentLimitsPanel({
  state,
  hits,
}: {
  state: AgentLimitState;
  /** Runs that stalled on the plan's limit — the number that actually hurts. */
  hits?: { today: number; week: number };
}) {
  // Rendered client-side against the viewer's clock: "in 2h 15m" computed on
  // the server would be wrong by however long the page sat open, and would
  // also mismatch between SSR and hydration.
  const now = Date.now();
  const limits = visibleLimits(state, now);

  const waits =
    hits && (hits.today > 0 || hits.week > 0) ? (
      <p className={`text-xs ${hits.today > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted"}`}>
        Runs waited for the plan&apos;s limit {hits.today} time{hits.today === 1 ? "" : "s"} today ·{" "}
        {hits.week} this week
        {hits.week >= 5 ? " — consider an organisation API key for busy periods." : ""}
      </p>
    ) : null;

  if (limits.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">
          No usage reported yet — this fills in the first time the Sandbox runs on a
          subscription.
        </p>
        {waits}
      </div>
    );
  }

  const lastSeen = Math.max(...limits.map((l) => l.observedAt));

  return (
    <div className="space-y-4">
      {limits.map((l) => {
        const pct = l.percentUsed;
        const known = typeof pct === "number";
        // Amber from 75%, red once the plan is warning or refusing — the point
        // is to notice BEFORE a task dies mid-run.
        const tone =
          l.status === "rejected"
            ? "bg-red-500"
            : l.status === "allowed_warning" || (known && pct >= 90)
              ? "bg-red-400"
              : known && pct >= 75
                ? "bg-amber-400"
                : "bg-accent";
        return (
          <div key={l.window}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-foreground">
                {WINDOW_LABELS[l.window]}
              </span>
              {/* A plan only reports a percentage once there is usage to
                  report — at zero it sends the window and its reset time and
                  nothing else. "Nothing used yet" is the honest reading of
                  that, and far better than a bare dash that looks broken. */}
              <span className="text-sm tabular-nums text-muted">
                {known ? `${pct}% used` : "no percentage reported"}
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface-hover"
              role="progressbar"
              aria-valuenow={known ? pct : undefined}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={WINDOW_LABELS[l.window]}
            >
              <div
                className={`h-full rounded-full transition-[width] ${tone}`}
                style={{ width: `${known ? Math.max(pct, 1) : 0}%` }}
              />
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-muted">
              <span>
                {l.status === "rejected"
                  ? "Limit reached — runs are being refused"
                  : l.status === "allowed_warning"
                    ? "Approaching the limit"
                    : ""}
              </span>
              <span>{l.resetsAt ? `Resets ${formatResetIn(l.resetsAt, now)}` : ""}</span>
            </div>
          </div>
        );
      })}
      {waits}
      <p className="text-xs text-muted">
        Last reported {formatAgo(lastSeen, now)} — updated each time the Sandbox runs.
      </p>
    </div>
  );
}

function formatAgo(then: number, now: number): string {
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
