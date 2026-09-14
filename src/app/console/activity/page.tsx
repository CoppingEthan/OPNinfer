import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { ACTIVITY_RANGES, getActivity, parseActivityRange } from "@/lib/console/activity";
import { Empty, PortalTag, Stat, TableWrap, Unreachable, compact, tdCls, thCls } from "@/components/console/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity" };

/**
 * What the assistants actually did — tools, and what came out of them.
 *
 * Split into two tables on purpose, because the evidence behind them differs
 * in kind (see `lib/console/activity.ts`): counts of things a reply provably
 * produced, and the status lines the user saw, bucketed. The page says which
 * is which rather than presenting one confident-looking list.
 */
export default async function ConsoleActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseActivityRange((await searchParams).range);
  const view = await getActivity(range);
  const c = view.combined;
  const toolRate = c.replies > 0 ? (c.repliesWithTools / c.replies) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="What the assistants did, across every portal."
      />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
            {(Object.keys(ACTIVITY_RANGES) as (keyof typeof ACTIVITY_RANGES)[]).map((key) => (
              <Link
                key={key}
                href={`/console/activity?range=${key}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  range === key
                    ? "bg-surface-hover text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {ACTIVITY_RANGES[key].label}
              </Link>
            ))}
          </div>
        </div>

        <Unreachable errors={view.errors} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Replies" value={compact(c.replies)} sub={`${ACTIVITY_RANGES[range].label}`} />
          <Stat
            label="Used a tool"
            value={`${toolRate.toFixed(0)}%`}
            sub={`${compact(c.repliesWithTools)} replies`}
          />
          <Stat label="Sandbox steps" value={compact(c.produced.sandboxRuns)} sub="agent tool runs" />
          <Stat
            label="Images made"
            value={compact(c.produced.images)}
            sub={`${compact(c.produced.visualisations)} visualisations`}
          />
        </div>

        <section>
          <h2 className="text-sm font-semibold tracking-tight">What came out of it</h2>
          <p className="mb-3 mt-0.5 text-sm text-muted">
            Counted from what each reply saved for its own re-rendering — these definitely
            happened.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Web sources cited" value={compact(c.produced.webSources)} />
            <Stat label="Files handed over" value={compact(c.produced.filesPresented)} />
            <Stat label="Clarifying questions" value={compact(c.produced.questionsAsked)} />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold tracking-tight">What the assistant did</h2>
          <p className="mb-3 mt-0.5 text-sm text-muted">
            Grouped from the status lines people saw. A file read and a single web page both
            read as &ldquo;Reading&hellip;&rdquo; and cannot be told apart, so they share a row.
          </p>
          {c.did.length === 0 ? (
            <Empty>No tool activity recorded in this window.</Empty>
          ) : (
            <TableWrap>
              <thead>
                <tr className="border-b border-border">
                  <th className={thCls}>Action</th>
                  <th className={`${thCls} text-right`}>Times</th>
                  {view.portals.map((p) => (
                    <th key={p.portal} className={`${thCls} text-right`}>
                      {p.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.did.slice(0, 25).map((row) => (
                  <tr key={row.key} className="border-b border-border/60 last:border-0">
                    <td className={tdCls}>{row.key}</td>
                    <td className={`${tdCls} text-right tabular-nums font-medium`}>
                      {compact(row.count)}
                    </td>
                    {view.portals.map((p) => {
                      const n = p.activity.did.find((d) => d.key === row.key)?.count ?? 0;
                      return (
                        <td
                          key={p.portal}
                          className={`${tdCls} text-right tabular-nums text-muted`}
                        >
                          {n || "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold tracking-tight">Sandbox steps by tool</h2>
          <p className="mb-3 mt-0.5 text-sm text-muted">
            The agent&apos;s own steps, by real tool name — the one place exact names are kept.
          </p>
          {c.sandboxTools.length === 0 ? (
            <Empty>No Sandbox runs in this window.</Empty>
          ) : (
            <div className="flex flex-wrap gap-2">
              {c.sandboxTools.map((t) => (
                <span
                  key={t.key}
                  className="rounded-xl border border-border bg-surface px-3 py-1.5 text-sm"
                >
                  <code className="text-foreground">{t.key}</code>
                  <span className="ml-2 tabular-nums text-muted">{compact(t.count)}</span>
                </span>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold tracking-tight">By portal</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.portals.map((p) => (
              <div key={p.portal} className="rounded-2xl border border-border bg-surface p-4">
                <PortalTag label={p.label} />
                <p className="mt-2 text-sm">
                  <span className="font-medium">{compact(p.activity.replies)}</span> replies ·{" "}
                  {p.activity.replies > 0
                    ? Math.round((p.activity.repliesWithTools / p.activity.replies) * 100)
                    : 0}
                  % used a tool
                </p>
                <p className="mt-1 text-xs text-muted">
                  {compact(p.activity.produced.images)} images ·{" "}
                  {compact(p.activity.produced.webSources)} sources ·{" "}
                  {compact(p.activity.produced.sandboxRuns)} sandbox steps
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
