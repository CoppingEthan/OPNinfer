import { db } from "@/lib/db";
import { devLog } from "@/lib/dev-log";
import type { Prisma } from "@prisma/client";

/**
 * Structured application log (v0.2). Each event is persisted to `app_log` for
 * the "last N" view AND fanned out to in-memory subscribers for the live Logs
 * stream. In-memory is fine for the single-instance deployment.
 */
export type LogLevel = "info" | "warn" | "error";

export interface AppLogEvent {
  id?: string;
  level: LogLevel;
  category: string;
  message: string;
  details?: unknown;
  userId?: string | null;
  createdAt: string;
}

type Listener = (e: AppLogEvent) => void;
// Anchored on globalThis (2026-09-04, found in production): Next instantiates
// this module once PER ROUTE BUNDLE, so a module-local Set meant the error
// alerts subscribed from instrumentation-node saw only events logged from
// that bundle — i.e. none of the chat route's. Twenty "Sandbox signed out"
// errors in a day, alerts enabled, SMTP working, and not one email. Same
// trap as interject.ts / turn-stream.ts / db.ts.
const g = globalThis as { __opninferLogListeners?: Set<Listener> };
const listeners: Set<Listener> = (g.__opninferLogListeners ??= new Set<Listener>());

export function subscribeLogs(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function appLog(
  level: LogLevel,
  category: string,
  message: string,
  opts?: { userId?: string | null; details?: unknown },
): Promise<void> {
  const createdAt = new Date().toISOString();
  const evt: AppLogEvent = {
    level,
    category,
    message,
    details: opts?.details,
    userId: opts?.userId ?? null,
    createdAt,
  };
  // Tee every curated app event into the verbose dev log file too.
  devLog(level, category, message, opts?.details);
  for (const l of [...listeners]) {
    try {
      l(evt);
    } catch {
      /* a bad subscriber must not break logging */
    }
  }
  try {
    await db.appLog.create({
      data: {
        level,
        category,
        message,
        details: (opts?.details as Prisma.InputJsonValue) ?? undefined,
        userId: opts?.userId ?? undefined,
      },
    });
  } catch {
    /* logging must never throw into the request path */
  }
}
