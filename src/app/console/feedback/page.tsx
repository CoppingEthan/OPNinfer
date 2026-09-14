import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { getFeedback } from "@/lib/console/feedback";
import {
  Empty,
  PortalTag,
  Stat,
  Unreachable,
  ago,
} from "@/components/console/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feedback" };

/**
 * Every thumbs-rated reply, across every portal.
 *
 * `message_feedback` is a permanent snapshot — it outlives the chat it came
 * from — so this stays honest even after a client clears their history. The
 * "why" line under each entry is the portal's own front-end model's reading of
 * what went wrong, written at rating time.
 */
export default async function ConsoleFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const raw = (await searchParams).filter;
  const filter = raw === "up" || raw === "down" ? raw : "all";
  const view = await getFeedback(filter);
  const total = view.counts.up + view.counts.down;
  const positive = total > 0 ? (view.counts.up / total) * 100 : 0;

  return (
    <>
      <PageHeader title="Feedback" subtitle="What people thought of the replies." />
      <div className="space-y-6">
        <Unreachable errors={view.errors} />

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Rated replies" value={total} sub="all time" />
          <Stat
            label="Positive"
            value={`${positive.toFixed(0)}%`}
            tone={total === 0 ? "default" : positive >= 75 ? "good" : positive >= 50 ? "warn" : "bad"}
            sub={`${view.counts.up} up · ${view.counts.down} down`}
          />
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">By portal</p>
            <div className="mt-2 space-y-1">
              {view.byPortal.map((p) => (
                <p key={p.portal} className="flex items-center justify-between text-sm">
                  <span className="truncate text-muted">{p.label}</span>
                  <span className="tabular-nums">
                    <span className="text-emerald-500">{p.up}</span>
                    <span className="text-muted"> · </span>
                    <span className={p.down > 0 ? "text-red-500" : "text-muted"}>{p.down}</span>
                  </span>
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
          {[
            { key: "all", label: "All" },
            { key: "up", label: "👍 Positive" },
            { key: "down", label: "👎 Negative" },
          ].map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/console/feedback" : `/console/feedback?filter=${f.key}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        {view.entries.length === 0 ? (
          <Empty>No ratings recorded yet.</Empty>
        ) : (
          <div className="space-y-3">
            {view.entries.map((e) => (
              <article key={`${e.portal}:${e.id}`} className="rounded-2xl border border-border bg-surface p-4">
                <header className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className={e.rating === "up" ? "text-emerald-500" : "text-red-500"}>
                    {e.rating === "up" ? "👍" : "👎"}
                  </span>
                  <PortalTag label={e.portalLabel} />
                  <span className="truncate font-medium text-foreground">
                    {e.conversationTitle ?? "Untitled chat"}
                  </span>
                  <span>·</span>
                  <span>{e.user ?? "(deleted account)"}</span>
                  <span>·</span>
                  <span>{e.model ?? "—"}</span>
                  <span className="ml-auto">{ago(e.createdAt)}</span>
                </header>

                {e.summary ? (
                  <p className="mt-3 rounded-xl bg-background p-3 text-sm">{e.summary}</p>
                ) : null}

                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted hover:text-foreground">
                    Show the exchange
                  </summary>
                  <div className="mt-2 space-y-2 text-sm">
                    <p className="whitespace-pre-wrap rounded-xl bg-background p-3">
                      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
                        They asked
                      </span>
                      {e.userText}
                    </p>
                    <p className="whitespace-pre-wrap rounded-xl bg-background p-3">
                      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
                        It replied
                      </span>
                      {e.assistantText}
                    </p>
                  </div>
                </details>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
