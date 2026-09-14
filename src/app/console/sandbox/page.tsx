import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { SANDBOX_RANGES, getSandbox, parseSandboxRange } from "@/lib/console/sandbox";
import { AgentLimitsPanel } from "@/components/admin/agent-limits-panel";
import {
  Empty,
  PortalTag,
  Stat,
  TableWrap,
  Unreachable,
  ago,
  compact,
  money,
  tdCls,
  thCls,
} from "@/components/console/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandbox" };

/**
 * The Sandbox agent tier across the estate — the view no single portal can
 * give you.
 *
 * Two things only make sense from up here. The plan windows are ONE pool every
 * portal's agent draws on, so who is spending it is a comparison, not a
 * number. And a run that cannot use the plan falls back to the org API key and
 * quietly starts costing real money — $15.10 in a day, once, before anyone
 * noticed. Fallback spend is therefore a headline here, not a footnote.
 */
export default async function ConsoleSandboxPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseSandboxRange((await searchParams).range);
  const view = await getSandbox(range);
  const anyRuns = view.portals.some((p) => p.data.requests > 0 || p.data.plan);

  return (
    <>
      <PageHeader
        title="Sandbox"
        subtitle="The agent tier: the shared Claude plan, fallback spend, and what it reached for."
      />
      <div className="space-y-6">
        <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
          {(Object.keys(SANDBOX_RANGES) as (keyof typeof SANDBOX_RANGES)[]).map((key) => (
            <Link
              key={key}
              href={`/console/sandbox?range=${key}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                range === key
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {SANDBOX_RANGES[key].label}
            </Link>
          ))}
        </div>

        <Unreachable errors={view.errors} />

        {!anyRuns ? (
          <Empty>No portal has run the Sandbox. Nothing to show yet.</Empty>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Agent sessions" value={compact(view.totals.sessions)} />
              <Stat
                label="Saved on the plan"
                value={money(view.totals.planSaved)}
                tone="good"
                sub="what these runs would have cost"
              />
              <Stat
                label="Fell back to the API key"
                value={money(view.totals.apiCost)}
                tone={view.totals.apiCost > 0 ? "bad" : "good"}
                sub={`${compact(view.totals.apiRequests)} calls billed for real`}
              />
              <Stat
                label="Portals using it"
                value={view.portals.filter((p) => p.data.sessions > 0).length}
                sub={`of ${view.portals.length}`}
              />
            </div>

            {view.totals.apiCost > 0 ? (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                <p className="font-medium text-amber-600 dark:text-amber-400">
                  Some runs are not using the plan.
                </p>
                <p className="mt-1 text-muted">
                  A run falls back to the org API key when the plan is spent, or when the shared
                  sign-in has been rotated — the usual cause of the second is a host clone or
                  restore. Recovery is{" "}
                  <code className="rounded bg-surface-hover px-1 py-0.5">
                    ./deploy.sh agent-login &lt;instance&gt;
                  </code>
                  .
                </p>
              </div>
            ) : null}

            <section>
              <h2 className="text-sm font-semibold tracking-tight">The shared plan</h2>
              <p className="mb-3 mt-0.5 text-sm text-muted">
                Every portal signs in to the same Anthropic account, so these windows are one
                pool. Each portal only knows the reading it last recorded — the freshest is the
                truest.
              </p>
              <div className="space-y-3">
                {view.portals.map((p) => (
                  <div key={p.portal} className="rounded-2xl border border-border bg-surface p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <PortalTag label={p.label} />
                      <span className="text-xs text-muted">
                        {p.data.sessions} session{p.data.sessions === 1 ? "" : "s"} ·{" "}
                        {p.data.users} {p.data.users === 1 ? "person" : "people"}
                      </span>
                    </div>
                    <AgentLimitsPanel state={p.data.plan ?? {}} />
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold tracking-tight">Spend by portal</h2>
              <div className="mt-3">
                <TableWrap>
                  <thead>
                    <tr className="border-b border-border">
                      <th className={thCls}>Portal</th>
                      <th className={`${thCls} text-right`}>Sessions</th>
                      <th className={`${thCls} text-right`}>On the plan</th>
                      <th className={`${thCls} text-right`}>Saved</th>
                      <th className={`${thCls} text-right`}>On the API key</th>
                      <th className={`${thCls} text-right`}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.portals.map((p) => (
                      <tr key={p.portal} className="border-b border-border/60 last:border-0">
                        <td className={tdCls}>{p.label}</td>
                        <td className={`${tdCls} text-right tabular-nums`}>{p.data.sessions}</td>
                        <td className={`${tdCls} text-right tabular-nums text-muted`}>
                          {compact(p.data.planRequests)}
                        </td>
                        <td className={`${tdCls} text-right tabular-nums`}>
                          {p.data.planSaved > 0 ? money(p.data.planSaved) : "—"}
                        </td>
                        <td className={`${tdCls} text-right tabular-nums text-muted`}>
                          {compact(p.data.apiRequests)}
                        </td>
                        <td
                          className={`${tdCls} text-right tabular-nums ${
                            p.data.apiCost > 0 ? "text-amber-500" : ""
                          }`}
                        >
                          {p.data.apiCost > 0 ? money(p.data.apiCost) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              </div>
            </section>

            {view.portals.some((p) => p.data.errors.length > 0) ? (
              <section>
                <h2 className="text-sm font-semibold tracking-tight">Agent errors</h2>
                <p className="mb-3 mt-0.5 text-sm text-muted">
                  These are the rows that trigger the error-alert email on each portal.
                </p>
                <div className="space-y-2">
                  {view.portals.flatMap((p) =>
                    p.data.errors.map((e) => (
                      <div
                        key={`${p.portal}:${e.message}`}
                        className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                      >
                        <PortalTag label={p.label} />
                        <span className="text-red-500">{e.message}</span>
                        <span className="ml-auto text-xs text-muted">
                          ×{e.count} · last {ago(e.last)}
                        </span>
                      </div>
                    )),
                  )}
                </div>
              </section>
            ) : null}

            <section>
              <h2 className="text-sm font-semibold tracking-tight">What the agent reached for</h2>
              <p className="mb-3 mt-0.5 text-sm text-muted">
                Installs, downloads and clones its shell commands performed — what to consider
                baking into the image next.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {view.portals
                  .filter((p) => p.data.packages.length > 0)
                  .map((p) => (
                    <div key={p.portal} className="rounded-2xl border border-border bg-surface p-4">
                      <PortalTag label={p.label} />
                      <ul className="mt-2 space-y-1">
                        {p.data.packages.slice(0, 12).map((pkg) => (
                          <li
                            key={`${pkg.kind}:${pkg.name}`}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="truncate">
                              <span className="text-muted">{pkg.kind}</span>{" "}
                              <code>{pkg.name}</code>
                            </span>
                            <span className="tabular-nums text-muted">{pkg.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
