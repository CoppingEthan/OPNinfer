"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { ConsoleChatRow, ConsoleLogRow, LogLevelFilter } from "@/lib/console/logs";
import { Empty, PortalTag, TableWrap, Unreachable, compact, money, tdCls, thCls } from "./ui";

/**
 * The application log of every portal, merged and sorted by time.
 *
 * Two views, exactly as Admin -> Logs has: "Chats" (one row per assistant
 * reply — model, tokens, cost, duration, tools) and "Raw" (everything as
 * recorded, click a row for the details JSON). The portals stream theirs over
 * SSE; this polls, because four SSE connections into four client databases
 * held open for the life of a tab is a lot of standing cost for something a
 * few seconds of staleness cannot hurt.
 */
const REFRESH_MS = 15_000;

type View = "chats" | "raw";

export function LogsView() {
  const [view, setView] = useState<View>("chats");
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const [chats, setChats] = useState<ConsoleChatRow[] | null>(null);
  const [raw, setRaw] = useState<ConsoleLogRow[] | null>(null);
  const [errors, setErrors] = useState<{ portal: string; error: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const state = useRef({ view, level });
  state.current = { view, level };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { view: v, level: l } = state.current;
      try {
        const url =
          v === "chats" ? "/api/console/logs?view=chats" : `/api/console/logs?level=${l}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const d = (await res.json()) as {
          rows: ConsoleChatRow[] | ConsoleLogRow[];
          errors: { portal: string; error: string }[];
        };
        if (cancelled) return;
        setErrors(d.errors ?? []);
        if (v === "chats") setChats(d.rows as ConsoleChatRow[]);
        else setRaw(d.rows as ConsoleLogRow[]);
      } catch {
        /* transient — the next tick will try again */
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view, level]);

  const rows = view === "chats" ? chats : raw;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
          {(["chats", "raw"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-current={view === v ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                view === v ? "bg-surface-hover text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {view === "raw" ? (
          <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
            {(["all", "info", "warn", "error"] as LogLevelFilter[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  level === l
                    ? "bg-surface-hover text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        ) : null}
        <p className="ml-auto text-xs text-muted">Refreshes every {REFRESH_MS / 1000}s</p>
      </div>

      <Unreachable errors={errors} />

      {!rows ? (
        <Empty>Reading every portal&hellip;</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing logged.</Empty>
      ) : view === "chats" ? (
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <th className={thCls}>When</th>
              <th className={thCls}>Portal</th>
              <th className={thCls}>Person</th>
              <th className={thCls}>Model</th>
              <th className={`${thCls} text-right`}>In</th>
              <th className={`${thCls} text-right`}>Cached</th>
              <th className={`${thCls} text-right`}>Out</th>
              <th className={`${thCls} text-right`}>Cost</th>
              <th className={`${thCls} text-right`}>Took</th>
              <th className={`${thCls} text-right`}>Tools</th>
            </tr>
          </thead>
          <tbody>
            {(rows as ConsoleChatRow[]).map((r) => (
              <tr key={`${r.portal}:${r.id}`} className="border-b border-border/60 last:border-0">
                <td className={`${tdCls} whitespace-nowrap text-xs text-muted`}>
                  <Time iso={r.createdAt} />
                </td>
                <td className={tdCls}>
                  <PortalTag label={r.portalLabel} />
                </td>
                <td className={`${tdCls} max-w-[14rem] truncate text-muted`}>{r.user ?? "—"}</td>
                <td className={tdCls}>
                  <span className="text-xs">{r.model}</span>
                  {r.notice ? (
                    <span className="ml-2 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
                      {r.notice.toLowerCase().includes("escalat") ? "escalated" : "failover"}
                    </span>
                  ) : null}
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {compact(r.inTokens)}
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {compact(r.cachedTokens)}
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {compact(r.outTokens)}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>{money(r.cost)}</td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {(r.durationMs / 1000).toFixed(1)}s
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {r.toolCalls || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <th className={thCls}>When</th>
              <th className={thCls}>Portal</th>
              <th className={thCls}>Level</th>
              <th className={thCls}>Category</th>
              <th className={thCls}>Message</th>
              <th className={thCls}>Person</th>
            </tr>
          </thead>
          <tbody>
            {(rows as ConsoleLogRow[]).map((r) => {
              const id = `${r.portal}:${r.id}`;
              return (
                <Fragment key={id}>
                  <tr
                    onClick={() => setOpen(open === id ? null : id)}
                    className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-hover"
                  >
                    <td className={`${tdCls} whitespace-nowrap text-xs text-muted`}>
                      <Time iso={r.createdAt} />
                    </td>
                    <td className={tdCls}>
                      <PortalTag label={r.portalLabel} />
                    </td>
                    <td className={tdCls}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                          r.level === "error"
                            ? "bg-red-500/10 text-red-500"
                            : r.level === "warn"
                              ? "bg-amber-500/10 text-amber-500"
                              : "bg-surface-hover text-muted"
                        }`}
                      >
                        {r.level}
                      </span>
                    </td>
                    <td className={`${tdCls} text-xs text-muted`}>{r.category}</td>
                    <td className={`${tdCls} max-w-[28rem] truncate`}>{r.message}</td>
                    <td className={`${tdCls} max-w-[12rem] truncate text-xs text-muted`}>
                      {r.user ?? "—"}
                    </td>
                  </tr>
                  {open === id && r.details ? (
                    <tr className="border-b border-border/60">
                      <td className={tdCls} colSpan={6}>
                        <pre className="oi-scroll max-h-64 overflow-auto rounded-xl bg-background p-3 text-xs">
                          {JSON.stringify(r.details, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}

/** Rendered on the client only — a server-rendered local time would mismatch
 *  on hydration, and the viewer's clock is the one that matters here. */
function Time({ iso }: { iso: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    setText(
      sameDay
        ? d.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : d.toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
    );
  }, [iso]);
  return <span suppressHydrationWarning>{text || "—"}</span>;
}
