"use client";

import { Fragment, useEffect, useRef, useState } from "react";

/**
 * Admin → Logs (revamped 2026-07-19, owner ask): TWO views over the live
 * app-log stream.
 *  - "Chats" (default): one row per assistant reply — who, when, model,
 *    tokens by tier (in / cached / out), cost, duration, tool calls, and an
 *    escalation/failover badge. Built from the enriched `chat` log events.
 *  - "Raw": every event exactly as the server recorded it — level, category,
 *    user, message; click a row to expand the full details JSON.
 * Both views share one SSE subscription and update live.
 */

/** Row shape passed from the server (mirrors AppLog; no server imports). */
export interface LogRow {
  level: string;
  category: string;
  message: string;
  userId?: string | null;
  createdAt: string;
  details?: unknown;
}

export interface LogUser {
  name: string | null;
  email: string;
  image: string | null;
}

interface ChatDetails {
  conversationId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  cost?: number;
  durationMs?: number;
  toolCalls?: number;
  notice?: string;
}

const LEVEL_TONE: Record<string, string> = {
  info: "text-muted",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
};

const isChatReply = (l: LogRow) => l.category === "chat" && l.message === "Assistant reply";

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtTokens(n?: number): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function UserCell({ user }: { user?: LogUser }) {
  if (!user) return <span className="text-muted">—</span>;
  const label = user.name || user.email;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/avatar/${user.image}`}
          alt=""
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-semibold uppercase text-muted">
          {label.slice(0, 1)}
        </span>
      )}
      <span className="truncate" title={user.email}>
        {label}
      </span>
    </span>
  );
}

export function LiveLogs({
  initial,
  initialChat,
  users,
}: {
  initial: LogRow[];
  initialChat: LogRow[];
  users: Record<string, LogUser>;
}) {
  const [view, setView] = useState<"chats" | "raw">("chats");
  const [logs, setLogs] = useState<LogRow[]>(initial);
  const [chatLogs, setChatLogs] = useState<LogRow[]>(initialChat);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/admin/logs/stream");
    esRef.current = es;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data);
        if (data.type === "log" && data.event) {
          const row = data.event as LogRow;
          setLogs((prev) => [row, ...prev].slice(0, 500));
          if (isChatReply(row)) setChatLogs((prev) => [row, ...prev].slice(0, 500));
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, []);

  const tab = (id: "chats" | "raw", label: string) => (
    <button
      type="button"
      onClick={() => setView(id)}
      aria-current={view === id ? "page" : undefined}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        view === id
          ? "bg-background text-foreground ring-1 ring-border"
          : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
          {tab("chats", "Chats")}
          {tab("raw", "Raw")}
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          <span
            className={`inline-block h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-muted"}`}
            aria-hidden="true"
          />
          {live ? "Live" : "Reconnecting…"} · newest first
        </span>
      </div>

      {view === "chats" ? (
        chatLogs.length === 0 ? (
          <p className="text-sm text-muted">No chat replies logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">In</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cached</th>
                  <th className="px-4 py-2.5 text-right font-medium">Out</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                  <th className="px-4 py-2.5 text-right font-medium">Time</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tools</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chatLogs.map((l, i) => {
                  const d = (l.details ?? {}) as ChatDetails;
                  const cached =
                    typeof d.cacheReadTokens === "number" || typeof d.cacheWriteTokens === "number"
                      ? (d.cacheReadTokens ?? 0) + (d.cacheWriteTokens ?? 0)
                      : undefined;
                  return (
                    <tr key={`${l.createdAt}-${i}`}>
                      <td className="max-w-[14rem] px-4 py-2">
                        <UserCell user={l.userId ? users[l.userId] : undefined} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtWhen(l.createdAt)}</td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-foreground">
                        {d.model ?? "—"}
                        {d.notice ? (
                          <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 font-sans text-[10px] font-medium text-accent">
                            {d.notice.toLowerCase().includes("escalat") ? "escalated" : "failover"}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-foreground">{fmtTokens(d.inputTokens)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{fmtTokens(cached)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-foreground">{fmtTokens(d.outputTokens)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">
                        {typeof d.cost === "number" ? `$${d.cost.toFixed(4)}` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">
                        {typeof d.durationMs === "number" ? `${(d.durationMs / 1000).toFixed(1)}s` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{fmtTokens(d.toolCalls)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : logs.length === 0 ? (
        <p className="text-sm text-muted">No log events yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Level</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium">User</th>
                <th className="px-4 py-2.5 font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((l, i) => (
                <Fragment key={`${l.createdAt}-${i}`}>
                  <tr
                    onClick={() => setExpanded(expanded === i ? null : i)}
                    className={l.details != null ? "cursor-pointer hover:bg-surface" : undefined}
                    title={l.details != null ? "Click to expand details" : undefined}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtWhen(l.createdAt)}</td>
                    <td className={`px-4 py-2 font-medium ${LEVEL_TONE[l.level] ?? "text-muted"}`}>
                      {l.level}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{l.category}</td>
                    <td className="max-w-[12rem] px-4 py-2 text-muted">
                      <UserCell user={l.userId ? users[l.userId] : undefined} />
                    </td>
                    <td className="px-4 py-2 text-foreground">{l.message}</td>
                  </tr>
                  {expanded === i && l.details != null ? (
                    <tr>
                      <td colSpan={5} className="bg-surface/60 px-4 py-2">
                        <pre className="oi-scroll max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-muted">
                          {JSON.stringify(l.details, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
