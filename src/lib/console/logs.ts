import "server-only";
import { fanOut } from "./db";

/**
 * The application log, merged across portals and sorted by time.
 *
 * Two views, mirroring Admin → Logs: every event as recorded, and the
 * per-reply "chat" rows (model, tokens, cost, duration, tool count) that make
 * a busy portal readable. The portal serves its own log live over SSE; the
 * console POLLS instead — four long-lived SSE connections into four client
 * databases, held open for as long as a dashboard tab is open, is a lot of
 * standing cost for a page that is refreshed every few seconds anyway.
 */

export interface ConsoleLogRow {
  portal: string;
  portalLabel: string;
  id: string;
  level: string;
  category: string;
  message: string;
  user: string | null;
  createdAt: string;
  details: Record<string, unknown> | null;
}

/** One assistant reply, as the chat view renders it. */
export interface ConsoleChatRow {
  portal: string;
  portalLabel: string;
  id: string;
  createdAt: string;
  user: string | null;
  model: string;
  provider: string;
  inTokens: number;
  cachedTokens: number;
  outTokens: number;
  cost: number;
  durationMs: number;
  toolCalls: number;
  notice: string | null;
}

export type LogLevelFilter = "all" | "info" | "warn" | "error";

const LIMIT = 150;

function detailsOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(d: Record<string, unknown> | null, k: string): number {
  const v = d?.[k];
  return typeof v === "number" ? v : 0;
}
function str(d: Record<string, unknown> | null, k: string): string {
  const v = d?.[k];
  return typeof v === "string" ? v : "";
}

export async function getLogs(level: LogLevelFilter = "all"): Promise<{
  rows: ConsoleLogRow[];
  errors: { portal: string; error: string }[];
}> {
  const results = await fanOut(async (db, instance) => {
    const rows = await db.appLog.findMany({
      where: level === "all" ? {} : { level },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    });
    const ids = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = ids.length
      ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return rows.map(
      (r): ConsoleLogRow => ({
        portal: instance.name,
        portalLabel: instance.label,
        id: r.id,
        level: r.level,
        category: r.category,
        message: r.message,
        user: r.userId ? emailById.get(r.userId) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        details: detailsOf(r.details),
      }),
    );
  });

  return {
    rows: results
      .flatMap((r) => r.data ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LIMIT * 2),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}

export async function getChatLog(): Promise<{
  rows: ConsoleChatRow[];
  errors: { portal: string; error: string }[];
}> {
  const results = await fanOut(async (db, instance) => {
    const rows = await db.appLog.findMany({
      where: { category: "chat", message: "Assistant reply" },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    });
    const ids = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = ids.length
      ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r): ConsoleChatRow => {
      const d = detailsOf(r.details);
      return {
        portal: instance.name,
        portalLabel: instance.label,
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        user: r.userId ? emailById.get(r.userId) ?? null : null,
        model: str(d, "model") || "—",
        provider: str(d, "provider") || "—",
        inTokens: num(d, "inputTokens"),
        cachedTokens: num(d, "cacheReadTokens"),
        outTokens: num(d, "outputTokens"),
        cost: num(d, "cost"),
        durationMs: num(d, "durationMs"),
        toolCalls: num(d, "toolCalls"),
        notice: str(d, "notice") || null,
      };
    });
  });

  return {
    rows: results
      .flatMap((r) => r.data ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LIMIT * 2),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}
