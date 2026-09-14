/**
 * Node-only server startup. Imported dynamically from `instrumentation.ts` under
 * the `NEXT_RUNTIME === "nodejs"` guard, so its Node-only dependencies (the
 * backup module pulls in `archiver`, which uses `path`/`fs`) never leak into the
 * Edge/middleware bundle where those built-ins don't resolve.
 */
import { startBackupScheduler } from "@/lib/backup";
import { startErrorAlerts } from "@/lib/alerts";
import { startWeeklyReportScheduler } from "@/lib/weekly-report";
import { startMemoryPassScheduler } from "@/lib/memory-pass";
import { startCompactionSweep } from "@/lib/compaction";
import { appLog } from "@/lib/applog";
import { devLogBoot, devLogEnabled } from "@/lib/dev-log";
import { IS_CONSOLE } from "@/lib/mode";

export function registerNode() {
  // Session marker so the latest run is easy to find in the dev log.
  devLogBoot({ nodeEnv: process.env.NODE_ENV });

  // Process-level guards: a single stray async error must not take down the
  // whole Node process and drop every connected user's in-flight SSE stream.
  // Node ≥15 exits on an unhandled rejection by default, so without this a bug
  // in any request handler is a fleet-wide outage. We log and keep serving;
  // Docker's `restart: unless-stopped` still covers a truly fatal exit.
  // These go through `appLog`, not just the dev log: dev-log is disabled in
  // production, so a crash used to leave no trace anywhere an admin could see
  // — not in Admin → Logs, and nothing to alert on. appLog tees into the dev
  // log anyway, so nothing is lost locally. Fire-and-forget: the process is
  // already in a bad way and must not be blocked (or re-thrown into).
  // Registered once per process (audit 2026-09-05): register() can run more
  // than once in dev, and each extra pair logged every crash twice and hit
  // the alert throttle twice. Same guard shape as the schedulers.
  const guards = globalThis as { __oiCrashGuards?: boolean };
  if (guards.__oiCrashGuards) return;
  guards.__oiCrashGuards = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
    void appLog("error", "process", "Unhandled promise rejection", {
      details: {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack?.slice(0, 4000) : undefined,
      },
    }).catch(() => {});
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    void appLog("error", "process", "Uncaught exception", {
      details: {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 4000) : undefined,
      },
    }).catch(() => {});
  });

  // The operator console runs from this same image with no database of its
  // own — every scheduler below reads or writes one. It also has nothing to
  // schedule: it takes no backups, sends no mail, and learns no memories.
  // (The crash guards above stay: `appLog` fails closed, and the console
  // stops even a fatal bug from ending the process.)
  if (IS_CONSOLE) {
    console.log("[console] read-only operator console — no schedulers started");
    return;
  }

  if (devLogEnabled()) console.log("[dev-log] verbose logging → logs/dev.log");

  // In-process auto-backup scheduler (no-op unless enabled in Admin → Backups).
  startBackupScheduler();

  // Email on logged errors (no-op unless switched on in Admin → SMTP).
  startErrorAlerts();

  // Friday-afternoon spend/errors/health digest (no-op unless switched on).
  startWeeklyReportScheduler();

  // Memory v2: read each chat for lasting facts once it has been quiet for
  // 30 minutes (no-op while the memory tool group is off).
  startMemoryPassScheduler();

  // Conversation compaction (2026-09-10): once per boot, summarise the
  // older part of every chat already over the trigger — the retroactive fix.
  startCompactionSweep();
}
