"use client";

import { useMemo, useState } from "react";
import type { ConsolePerson } from "@/lib/console/people";
import { Empty, PortalTag, TableWrap, ago, compact, money, tdCls, thCls } from "./ui";

type SortKey = "cost" | "requests" | "chats" | "lastActiveAt" | "email";

/**
 * Everyone with an account on any portal.
 *
 * Two columns need a word of explanation, and get one on the page rather than
 * only in the code.
 *
 * "Last seen" is imported from Open WebUI for migrated accounts, so a date
 * older than that portal's cutover is history, not a sign-in here. "Password
 * changed" is stamped ONLY by a reset (self-service or admin) — never by
 * accepting an invite — which makes it the unambiguous "this person has
 * arrived" signal after a migration, and nothing at all on a portal that was
 * never migrated. It is therefore shown plainly rather than flagged: an early
 * version painted every normally-invited user amber for a column they could
 * never satisfy.
 */
export function PeopleTable({ people }: { people: ConsolePerson[] }) {
  const [q, setQ] = useState("");
  const [portal, setPortal] = useState("all");
  const [sort, setSort] = useState<SortKey>("cost");

  const portals = useMemo(
    () => [...new Set(people.map((p) => p.portalLabel))].sort(),
    [people],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = people.filter(
      (p) =>
        (portal === "all" || p.portalLabel === portal) &&
        (!needle ||
          p.email.toLowerCase().includes(needle) ||
          (p.name ?? "").toLowerCase().includes(needle)),
    );
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "email":
          return a.email.localeCompare(b.email);
        case "requests":
          return b.requests - a.requests;
        case "chats":
          return b.chats - a.chats;
        case "lastActiveAt":
          return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
        default:
          return b.cost - a.cost;
      }
    });
  }, [people, q, portal, sort]);

  const reset = rows.filter((p) => p.passwordChangedAt).length;
  // The owner's actual question (2026-09-09): who asked for a sign-in link and
  // never got in? An expired, unused link is the closest thing to proof that
  // the email did not reach them — so those are listed by name at the top,
  // rather than left as a badge to spot in a table of forty rows.
  const stuck = rows.filter((p) => p.reset === "stuck");
  const waiting = rows.filter((p) => p.reset === "waiting");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or email…"
          className="w-56 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent/60"
        />
        <select
          value={portal}
          onChange={(e) => setPortal(e.target.value)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent/60"
        >
          <option value="all">All portals</option>
          {portals.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-accent/60"
        >
          <option value="cost">Most spend</option>
          <option value="requests">Most requests</option>
          <option value="chats">Most chats</option>
          <option value="lastActiveAt">Recently seen</option>
          <option value="email">Email A–Z</option>
        </select>
        <p className="ml-auto text-xs text-muted">
          {rows.length} account{rows.length === 1 ? "" : "s"} · {reset} have reset a password here
          {stuck.length > 0 ? (
            <>
              {" · "}
              <span className="font-medium text-amber-600 dark:text-amber-400">
                {stuck.length} stuck on a reset
              </span>
            </>
          ) : null}
        </p>
      </div>

      {stuck.length > 0 ? (
        <div
          data-reset-stuck={stuck.length}
          className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4"
        >
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
            {stuck.length} {stuck.length === 1 ? "person" : "people"} asked for a sign-in link and
            never used it
          </p>
          <p className="mt-1 text-xs text-muted">
            The link expired unused and their password never changed — so the email most likely
            never reached them. Set them a password directly from that portal&apos;s Admin →
            Users.
          </p>
          <ul className="mt-3 space-y-1 text-xs">
            {stuck.map((p) => (
              <li key={`stuck:${p.portal}:${p.email}`} className="flex flex-wrap items-center gap-2">
                <PortalTag label={p.portalLabel} />
                <span className="font-medium text-foreground">{p.email}</span>
                <span className="text-muted">asked {ago(p.resetAskedAt)}</span>
              </li>
            ))}
          </ul>
          {waiting.length > 0 ? (
            <p className="mt-3 text-xs text-muted">
              {waiting.length} more {waiting.length === 1 ? "has" : "have"} a link that is still
              valid — too early to say.
            </p>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty>No accounts match.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr className="border-b border-border">
              <th className={thCls}>Person</th>
              <th className={thCls}>Portal</th>
              <th className={`${thCls} text-right`}>Chats</th>
              <th className={`${thCls} text-right`}>Requests</th>
              <th className={`${thCls} text-right`}>Tokens</th>
              <th className={`${thCls} text-right`}>Cost</th>
              <th className={`${thCls} text-right`}>Last seen</th>
              <th className={`${thCls} text-right`}>Password changed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={`${p.portal}:${p.email}`} className="border-b border-border/60 last:border-0">
                <td className={tdCls}>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium" title={p.email}>
                      {p.name || p.email}
                    </span>
                    {p.role === "admin" ? (
                      <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        admin
                      </span>
                    ) : null}
                    {p.disabled ? (
                      <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-500">
                        disabled
                      </span>
                    ) : null}
                    {p.reset === "stuck" ? (
                      <span
                        data-reset="stuck"
                        title={`Asked for a sign-in link ${ago(p.resetAskedAt)} and never used it`}
                        className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400"
                      >
                        link unused
                      </span>
                    ) : p.reset === "waiting" ? (
                      <span
                        data-reset="waiting"
                        title={`Asked for a sign-in link ${ago(p.resetAskedAt)} — still valid`}
                        className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                      >
                        link sent
                      </span>
                    ) : null}
                  </div>
                  {p.name ? <p className="truncate text-xs text-muted">{p.email}</p> : null}
                </td>
                <td className={tdCls}>
                  <PortalTag label={p.portalLabel} />
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>{p.chats}</td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {compact(p.requests)}
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted`}>
                  {compact(p.inTokens + p.outTokens)}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>{money(p.cost)}</td>
                <td className={`${tdCls} text-right text-muted`}>{ago(p.lastActiveAt)}</td>
                <td className={`${tdCls} text-right text-muted`}>
                  {p.passwordChangedAt ? ago(p.passwordChangedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
