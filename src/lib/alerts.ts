import "server-only";
import { subscribeLogs, type AppLogEvent } from "@/lib/applog";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { sendMail } from "@/lib/mailer";
import { errorAlertEmail } from "@/lib/emails";

/**
 * Error alert emails.
 *
 * Every `appLog("error", …)` event is offered to this module; when alerts are
 * switched on (Admin → SMTP) it emails the configured address. The point is
 * that nobody has to be watching Admin → Logs for a portal to tell you it's
 * unhealthy — the worker sat broken for eight days in production precisely
 * because nothing reached out.
 *
 * Three rules keep it from becoming noise (or a mail-loop):
 *   - THROTTLE: the same error (category + message) is only mailed once per
 *     window; repeats are counted and reported on the next one that gets out.
 *   - HOURLY CAP: a storm can send at most `MAX_PER_HOUR` emails, so a hot
 *     failure loop can't flood an inbox or the SMTP relay.
 *   - NEVER appLog FROM HERE: a failure while sending must not create another
 *     error event, which would try to send another email, forever. Failures go
 *     to the console only.
 *
 * State is in-process, matching the rest of the single-instance design.
 */

export interface AlertConfig {
  enabled: boolean;
  /** Where alerts go. Any address — not necessarily a portal user. */
  email: string;
  /** Minutes before the SAME error is worth emailing about again. */
  throttleMinutes: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: false,
  email: "",
  throttleMinutes: 15,
};

/** Hard ceiling on outbound alerts per rolling hour, whatever the throttle. */
const MAX_PER_HOUR = 12;
/** How long a read of the config is reused (an error storm must not hammer the DB). */
const CONFIG_TTL_MS = 30_000;

export async function getAlertConfig(): Promise<AlertConfig> {
  const stored = await getSetting<Partial<AlertConfig>>(SETTING_KEYS.alerts);
  return {
    enabled: stored?.enabled === true && !!stored?.email,
    email: typeof stored?.email === "string" ? stored.email : "",
    throttleMinutes:
      typeof stored?.throttleMinutes === "number" && stored.throttleMinutes > 0
        ? stored.throttleMinutes
        : DEFAULT_ALERT_CONFIG.throttleMinutes,
  };
}

export async function setAlertConfig(config: AlertConfig): Promise<void> {
  await setSetting(SETTING_KEYS.alerts, config);
  box.cached = null; // pick the change up immediately rather than after the TTL
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

interface Seen {
  /** When we last actually emailed about this error. */
  lastSentAt: number;
  /** How many identical errors happened since, that nobody was told about. */
  suppressed: number;
}

/** One entry per distinct error; pruned so a churn of unique messages can't
 *  grow the map without bound. */
const seen = new Map<string, Seen>();
const MAX_TRACKED = 500;

let sentThisHour = 0;
let hourStartedAt = 0;
// On globalThis (audit 2026-09-05): the subscriber that reads this lives in
// the instrumentation bundle, the admin action that invalidates it in another
// — a module-local variable meant a saved change waited out the TTL.
const box: { cached: { at: number; config: AlertConfig } | null } = ((
  globalThis as { __oiAlertConfigCache?: { cached: { at: number; config: AlertConfig } | null } }
).__oiAlertConfigCache ??= { cached: null });

/** Distinct-error key. The message is truncated so that errors differing only
 *  in a long tail (ids, paths) still collapse into one alert. */
export function alertKey(event: Pick<AppLogEvent, "category" | "message">): string {
  return `${event.category}:${event.message.slice(0, 120)}`;
}

/** Pure throttle decision, exported for tests.
 *  Returns the number of suppressed repeats to mention, or null to stay quiet. */
export function shouldSend(
  key: string,
  now: number,
  throttleMinutes: number,
): { suppressed: number } | null {
  // Rolling hourly cap.
  if (now - hourStartedAt >= 3_600_000) {
    hourStartedAt = now;
    sentThisHour = 0;
  }
  if (sentThisHour >= MAX_PER_HOUR) return null;

  const prior = seen.get(key);
  if (prior && now - prior.lastSentAt < throttleMinutes * 60_000) {
    prior.suppressed++;
    return null;
  }

  if (seen.size >= MAX_TRACKED && !prior) {
    // Drop the coldest entry rather than grow forever.
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of seen) {
      if (v.lastSentAt < oldestAt) {
        oldestAt = v.lastSentAt;
        oldestKey = k;
      }
    }
    if (oldestKey) seen.delete(oldestKey);
  }

  const suppressed = prior?.suppressed ?? 0;
  seen.set(key, { lastSentAt: now, suppressed: 0 });
  sentThisHour++;
  return { suppressed };
}

/** Test seam — clears throttle state. */
export function resetAlertState(): void {
  seen.clear();
  sentThisHour = 0;
  hourStartedAt = 0;
  box.cached = null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function configNow(): Promise<AlertConfig> {
  const now = Date.now();
  if (box.cached && now - box.cached.at < CONFIG_TTL_MS) return box.cached.config;
  const config = await getAlertConfig();
  box.cached = { at: now, config };
  return config;
}

async function deliver(event: AppLogEvent): Promise<void> {
  const config = await configNow();
  if (!config.enabled || !config.email) return;

  const decision = shouldSend(alertKey(event), Date.now(), config.throttleMinutes);
  if (!decision) return;

  const mail = await errorAlertEmail(event, decision.suppressed);
  await sendMail({
    to: config.email,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  // A trace in the container log (console only — see startErrorAlerts), so
  // "did the alert go out?" can be answered from `docker logs` rather than
  // from someone's inbox.
  console.log(`[alerts] sent "${alertKey(event)}" to ${config.email}`);
}

/** Send one alert for an arbitrary event — used by the admin "Send a test
 *  alert" button, bypassing the throttle so the button always does something. */
export async function sendTestAlert(to: string): Promise<void> {
  const mail = await errorAlertEmail(
    {
      level: "error",
      category: "test",
      message: "Test alert — this is what an error notification looks like.",
      details: { triggeredBy: "Admin → SMTP → Send a test alert" },
      userId: null,
      createdAt: new Date().toISOString(),
    },
    0,
  );
  await sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
}

/**
 * Subscribe to the app log and email on errors. Called once at server start
 * (`instrumentation-node.ts`); idempotent, and anchored on globalThis because
 * Next instantiates modules per route bundle and dev HMR re-runs them.
 */
export function startErrorAlerts(): void {
  const g = globalThis as { __opninferAlerts?: boolean };
  if (g.__opninferAlerts) return;
  g.__opninferAlerts = true;

  subscribeLogs((event) => {
    if (event.level !== "error") return;
    // Fire-and-forget: appLog runs subscribers inline on the request path, so
    // this must not block it — and must never reject into it.
    void deliver(event).catch((err) => {
      // Deliberately console-only. Routing this through appLog would log an
      // error, which would try to send an alert, which would fail again…
      console.error(
        "[alerts] could not send the error alert:",
        err instanceof Error ? err.message : String(err),
      );
    });
  });
}
