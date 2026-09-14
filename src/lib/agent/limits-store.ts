import "server-only";
import { getSetting, setSetting } from "@/lib/settings";
import { devLog } from "@/lib/dev-log";
import { appLog } from "@/lib/applog";
import {
  mergeLimitSnapshot,
  parseLimitState,
  parseRateLimitInfo,
  type AgentLimitState,
  parsePlanUsage,
  planAlerts,
  planUsageAge,
  WINDOW_LABELS,
  formatResetIn,
  PLAN_WARN_PERCENT,
  type PlanAlert,
} from "./limits";

/**
 * Where subscription limit snapshots live.
 *
 * A `settings` row, not a table: this is ONE current reading per window for
 * the instance's single subscription credential, overwritten as runs report
 * it — not a time series. (If a usage GRAPH is ever wanted, that wants its
 * own table and a retention policy; this deliberately isn't that.)
 *
 * Instance-wide rather than per-user on purpose: the limits belong to the
 * credential, and every agent run on a subscription draws from the same pool
 * regardless of which user triggered it. Showing a per-user split would imply
 * per-user allowances that do not exist.
 */
const SETTING_KEY = "agent_rate_limits";

export async function getAgentLimits(): Promise<AgentLimitState> {
  return parseLimitState(await getSetting<unknown>(SETTING_KEY));
}

/**
 * Record what a run just reported. Fire-and-forget from the stream reader:
 * a failed write must never disturb a live agent run, so this swallows and
 * logs rather than throwing.
 */
export async function recordRateLimit(info: unknown): Promise<void> {
  try {
    const snap = parseRateLimitInfo(info);
    if (!snap) return;
    const merged = await raisePlanAlerts(mergeLimitSnapshot(await getAgentLimits(), snap));
    await setSetting(SETTING_KEY, merged as unknown as Record<string, unknown>);
    devLog("debug", "agent", "rate limit snapshot", {
      window: snap.window,
      percentUsed: snap.percentUsed,
      status: snap.status,
    });
  } catch (e) {
    devLog("warn", "agent", "could not record rate limit", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Ask a live SDK query for the plan's usage screen. The SDK's method is
 * marked experimental and WILL be renamed, so it is found by prefix, not
 * named; no method, timeout or error → null, never a throw into a run.
 */
export async function fetchPlanUsage(q: unknown, timeoutMs = 5_000): Promise<unknown> {
  if (!q || typeof q !== "object") return null;
  const obj = q as Record<string, unknown>;
  const names = new Set<string>(Object.keys(obj));
  for (let proto = Object.getPrototypeOf(obj); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Object.getOwnPropertyNames(proto)) names.add(k);
  }
  const name = [...names].find((k) => /^usage/i.test(k) && typeof obj[k] === "function");
  if (!name) return null;
  try {
    return await Promise.race([
      (obj[name] as () => Promise<unknown>).call(obj),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/** Record every window the usage screen reported (real percentages). */
export async function recordPlanUsage(raw: unknown): Promise<number> {
  try {
    const snaps = parsePlanUsage(raw);
    if (snaps.length === 0) return 0;
    let state = await getAgentLimits();
    for (const snap of snaps) state = mergeLimitSnapshot(state, snap);
    state = await raisePlanAlerts(state);
    await setSetting(SETTING_KEY, state as unknown as Record<string, unknown>);
    devLog("debug", "agent", "plan usage recorded", { windows: snaps.map((s) => `${s.window}=${s.percentUsed ?? "?"}%`) });
    return snaps.length;
  } catch (e) {
    devLog("warn", "agent", "could not record plan usage", { error: e instanceof Error ? e.message : String(e) });
    return 0;
  }
}

/** Fetch from the live query, then record. */
export async function recordPlanUsageFrom(q: unknown): Promise<number> {
  const raw = await fetchPlanUsage(q);
  return raw ? recordPlanUsage(raw) : 0;
}

/**
 * Take a plan-usage reading with the CONTAINER VOLUME login, not the run's
 * credential (2026-09-07).
 *
 * WHY THIS EXISTS. A long-lived token (`./deploy.sh agent-token`) stops the
 * eight-hourly sign-outs, but Claude Code limits such tokens to inference
 * only — measured the day it shipped, the plan's usage SCREEN comes back
 * empty on one, so the per-window percentages behind the Sandbox panel AND
 * the 90% alert email stop arriving. Runs are unaffected; the alert the
 * owner asked for is not, so the reading is taken separately, with the
 * sign-in still sitting in the credential volume (it stays there for the
 * connected services regardless).
 *
 * Safe now in a way it would not have been this morning: the refresh race
 * this whole change exists to kill needs TWO things refreshing one
 * credential, and after this there is exactly one — this probe — while every
 * real run goes on the token. A failed refresh can no longer wipe the shared
 * file either (sandboxd/credentials.mjs).
 *
 * Cheap by construction: it only runs when a token is configured (otherwise
 * the run's own query reads the screen perfectly well), and only when the
 * last screen reading has gone stale. Usage only moves when runs happen, so
 * "after a run, at most every 30 minutes" needs no scheduler.
 *
 * It does send ONE two-word prompt, which is not what the first version did
 * and not what you would guess. An idle session answers the usage request in
 * a second flat — with `rate_limits_available: true` and `rate_limits: null`.
 * The plan's windows only exist once the session has actually spoken to the
 * API, so a probe that carefully avoids spending anything learns nothing.
 * The cost is a handful of tokens on the plan, at most twice an hour.
 */
export const PLAN_USAGE_MAX_AGE_MS = 30 * 60_000;

/**
 * OFF BY DEFAULT since 2026-09-07, and the code is kept deliberately.
 *
 * This reads the plan through the container VOLUME LOGIN, and that login is
 * the deprecated path: it is the one that signs itself out (see
 * `./deploy.sh agent-login`, kept but no longer supported). Every instance
 * now runs on a long-lived token, so on a normal box there is no volume
 * sign-in for this to use — leaving it on would mean starting a ~1 GB
 * container after Sandbox runs, twice an hour, to be told there is nothing
 * to read.
 *
 * It is not deleted because it WORKS and the knowledge in it is expensive:
 * it is the only way to get per-window percentages while runs are on a
 * token, and it is proven live (`scripts/test-agent-token.ts` sets this
 * variable, so the path stays tested rather than rotting). If plan tracking
 * is ever wanted back, sign an instance's volume in with `agent-login` and
 * set AGENT_PLAN_USAGE_VIA_VOLUME=1 for that instance — nothing else needs
 * to change.
 */
export function planUsageViaVolumeEnabled(): boolean {
  return process.env.AGENT_PLAN_USAGE_VIA_VOLUME === "1";
}

/** One probe container id is shared with the admin checks, so these must not
 *  overlap: whoever holds this chain runs alone. */
const LOCK = "__opninferPlanUsageProbe" as const;
type LockHolder = { [LOCK]?: Promise<unknown> };

export async function refreshPlanUsageViaVolume(opts: { force?: boolean } = {}): Promise<number> {
  if (!planUsageViaVolumeEnabled()) return 0;
  const { agentTokenSource } = await import("./env");
  // No token → the run's own query already reads the screen. Nothing to do,
  // and spawning a container to duplicate that would be pure waste.
  if (agentTokenSource() !== "token") return 0;
  if (!opts.force) {
    const age = planUsageAge(await getAgentLimits());
    if (age !== null && age < PLAN_USAGE_MAX_AGE_MS) return 0;
  }
  const g = globalThis as unknown as LockHolder;
  const run = (g[LOCK] ?? Promise.resolve()).then(() => probeTwice(), () => probeTwice());
  g[LOCK] = run.catch(() => undefined);
  return run;
}

/**
 * One retry, because the probe container is torn down as soon as it is
 * finished and Docker's removal is not instant: a second probe started
 * within a second or two of the last one lands on a container that is
 * "marked for removal" and cannot be started, which reads as "the plan told
 * us nothing" (seen every time in the harness, and reachable in production
 * whenever Check sign-in is pressed just after a run). A genuine failure —
 * no sign-in in the volume — costs two attempts at most twice an hour.
 */
async function probeTwice(): Promise<number> {
  const first = await probePlanUsage();
  if (first > 0) return first;
  await new Promise((r) => setTimeout(r, 6_000));
  return probePlanUsage();
}

/** Resolve with null rather than hanging: every step here is best-effort. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

async function probePlanUsage(): Promise<number> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { buildAgentEnv } = await import("./env");
  const { makeAgentSpawner } = await import("./spawn");
  const { AGENT_USAGE_PROBE_CONVERSATION_ID } = await import("./config");
  const { ensureChatPool, ensureAgentStateDir } = await import("@/lib/storage");

  if (!process.env.SANDBOX_BROKER_URL || !process.env.SANDBOX_BROKER_TOKEN) return 0;
  const probeId = AGENT_USAGE_PROBE_CONVERSATION_ID;
  const abort = new AbortController();
  try {
    await ensureChatPool(probeId);
    await ensureAgentStateDir(probeId);
    // ONE tiny turn, then hold the stream open: an idle session reports
    // `rate_limits: null` (measured — see the note above), so the request is
    // what makes the numbers exist. The input stream must stay open after
    // it, or the control request below has nothing to ask.
    type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content: "Reply with exactly: OK" },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage;
      await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r(), { once: true }));
    }
    const q = query({
      prompt: input(),
      options: {
        cwd: "/workspace",
        env: buildAgentEnv({
          credential: "subscription",
          base: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/sandbox", LANG: "C.UTF-8" },
          configDir: "/home/sandbox/.claude",
          // NO oauthToken, deliberately: the volume login is the whole point.
        }),
        spawnClaudeCodeProcess: makeAgentSpawner(probeId) as never,
        abortController: abort,
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
      },
    });
    // Wait for the turn to FINISH before asking: that is what populates the
    // plan's windows.
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    void (async () => {
      try {
        for await (const m of q) {
          if ((m as { type?: string }).type === "result") settle();
        }
      } catch {
        /* the abort below lands here */
      } finally {
        settle();
      }
    })();
    // Generous: unlike a run, this container is cold and has to start first.
    await withTimeout(settled, 120_000);
    const raw = await fetchPlanUsage(q, 30_000);
    const n = raw ? await recordPlanUsage(raw) : 0;
    if (n === 0) {
      devLog("warn", "agent", "plan usage: the volume login returned nothing either", {});
    }
    return n;
  } catch (e) {
    // Never throws into a run: a missing sign-in here is a stale panel, not
    // a failed job. It is visible in dev.log and in the panel's own age.
    devLog("warn", "agent", "plan usage probe failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return 0;
  } finally {
    abort.abort();
    // The probe container holds ~1 GB — never leave it warm.
    const { destroyAgentContainer } = await import("./spawn");
    const { AGENT_USAGE_PROBE_CONVERSATION_ID: id } = await import("./config");
    destroyAgentContainer(id);
  }
}

/**
 * Email-worthy plan events (owner ask 2026-09-02): a window crossing 90%, and
 * a window the plan refuses. Logged at ERROR level in the `agent` category —
 * exactly what Admin → SMTP's error alerts mail (throttled by category +
 * message, so the message carries the window but not the moving number).
 * Returns the state with the alerts marked as raised, so each window alerts
 * once per threshold until it rolls over.
 */
/** The ONE place the alert wording lives — the real path and the admin's
 *  "send a test" button both use it, so the test shows the real email. */
export function planAlertEvent(a: PlanAlert): { message: string; details: Record<string, unknown> } {
  const label = WINDOW_LABELS[a.window];
  const resets = a.resetsAt ? ` — resets ${formatResetIn(a.resetsAt)}` : "";
  if (a.kind === "limit") {
    return {
      message: `Sandbox plan limit reached: ${label}`,
      details: {
        window: a.window,
        percentUsed: a.percentUsed,
        resetsAt: a.resetsAt,
        note: `The Claude plan is refusing new work in this window${resets}. Runs fail over to the organisation key if one is set on Admin → Sandbox, otherwise they wait or fail.`,
      },
    };
  }
  return {
    message: `Sandbox plan nearing its limit: ${label} (${PLAN_WARN_PERCENT}%+)`,
    details: {
      window: a.window,
      percentUsed: a.percentUsed,
      resetsAt: a.resetsAt,
      note: `${a.percentUsed}% of the window used${resets}. Sandbox runs will fail over or wait once it is spent.`,
    },
  };
}

async function raisePlanAlerts(state: AgentLimitState): Promise<AgentLimitState> {
  const { state: next, alerts } = planAlerts(state);
  for (const a of alerts) {
    const ev = planAlertEvent(a);
    await appLog("error", "agent", ev.message, { details: ev.details });
  }
  return next;
}

/** Wipe the stored snapshots (credential changed, or an admin wants a reset
 *  after switching plans — stale numbers are worse than none). */
export async function clearAgentLimits(): Promise<void> {
  await setSetting(SETTING_KEY, {});
  await setSetting(HITS_KEY, {});
}

/**
 * Rate-limit WAITS, counted per local day. On a subscription this is the
 * number that actually hurts: every hit is a run stalling until the plan's
 * window clears. Kept for 14 days, as {YYYY-MM-DD: count}.
 */
const HITS_KEY = "agent_rate_limit_hits";
const HITS_KEEP_DAYS = 14;

function dayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export async function recordRateLimitHit(at: Date = new Date()): Promise<void> {
  try {
    const stored = (await getSetting<Record<string, number>>(HITS_KEY)) ?? {};
    const key = dayKey(at);
    const next: Record<string, number> = { ...stored, [key]: (stored[key] ?? 0) + 1 };
    const cutoff = dayKey(new Date(at.getTime() - HITS_KEEP_DAYS * 86_400_000));
    for (const k of Object.keys(next)) if (k < cutoff) delete next[k];
    await setSetting(HITS_KEY, next);
  } catch (e) {
    devLog("warn", "agent", "could not record rate-limit hit", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Hits today and over the last 7 days. */
export async function getRateLimitHits(at: Date = new Date()): Promise<{ today: number; week: number }> {
  const stored = (await getSetting<Record<string, number>>(HITS_KEY)) ?? {};
  const today = stored[dayKey(at)] ?? 0;
  const weekCutoff = dayKey(new Date(at.getTime() - 7 * 86_400_000));
  let week = 0;
  for (const [k, v] of Object.entries(stored)) if (k > weekCutoff && typeof v === "number") week += v;
  return { today, week };
}
