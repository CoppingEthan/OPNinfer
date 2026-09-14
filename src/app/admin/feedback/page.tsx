import Link from "next/link";
import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/admin/page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feedback · Admin" };

const num = (n: number) => n.toLocaleString();

function fmtTime(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Admin → Feedback: every thumbs-rated reply, snapshotted so it survives chat
 * deletion, with the frontend model's "why" analysis. The health strip on top
 * shows how the assistant is doing overall.
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ rating?: string }>;
}) {
  await requireAdmin();
  const { rating } = await searchParams;
  const filter = rating === "up" || rating === "down" ? rating : undefined;

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [entries, upCount, downCount, up7, down7] = await Promise.all([
    db.messageFeedback.findMany({
      where: filter ? { rating: filter } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { email: true } } },
    }),
    db.messageFeedback.count({ where: { rating: "up" } }),
    db.messageFeedback.count({ where: { rating: "down" } }),
    db.messageFeedback.count({ where: { rating: "up", createdAt: { gte: weekAgo } } }),
    db.messageFeedback.count({ where: { rating: "down", createdAt: { gte: weekAgo } } }),
  ]);
  const total = upCount + downCount;
  const positive = total > 0 ? Math.round((upCount / total) * 100) : null;

  const tab = (key: string | undefined, label: string, count?: number) => {
    const active = filter === key || (!filter && !key);
    return (
      <Link
        key={label}
        href={key ? `/admin/feedback?rating=${key}` : "/admin/feedback"}
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
          active ? "bg-surface-hover text-foreground" : "text-muted hover:text-foreground"
        }`}
      >
        {label}
        {count != null ? <span className="ml-1.5 text-muted">{num(count)}</span> : null}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback"
        subtitle="Thumbs-rated replies with an AI analysis of why — entries survive chat deletion"
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total ratings" value={num(total)} />
        <Stat label="Positive" value={positive != null ? `${positive}%` : "—"} sub={`${num(upCount)} 👍 · ${num(downCount)} 👎`} />
        <Stat label="👍 last 7 days" value={num(up7)} />
        <Stat label="👎 last 7 days" value={num(down7)} />
      </div>

      <div className="inline-flex rounded-xl border border-border bg-background p-0.5">
        {tab(undefined, "All", total)}
        {tab("down", "👎 Bad", downCount)}
        {tab("up", "👍 Good", upCount)}
      </div>

      {entries.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface px-4 py-8 text-center text-sm text-muted">
          No ratings yet. When users thumb a reply, it lands here with an AI analysis of why.
        </p>
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <div key={e.id} className="rounded-2xl border border-border bg-surface p-5">
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                    e.rating === "up"
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/10 text-red-600 dark:text-red-400"
                  }`}
                >
                  {e.rating === "up" ? <ThumbUp /> : <ThumbDown />}
                  {e.rating === "up" ? "Good response" : "Bad response"}
                </span>
                <span className="font-medium text-foreground">{e.user?.email ?? "(deleted user)"}</span>
                {e.conversationTitle ? <span className="truncate">· {e.conversationTitle}</span> : null}
                {e.model ? <span>· {e.model}</span> : null}
                <span className="ml-auto">{fmtTime(e.createdAt)}</span>
              </div>

              {e.summary ? (
                <div className="mb-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-foreground">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent">
                    <Sparkle /> Why (AI analysis)
                  </div>
                  {e.summary}
                </div>
              ) : (
                <p className="mb-3 text-xs italic text-muted">AI analysis pending — refresh shortly.</p>
              )}

              <details className="group">
                <summary className="cursor-pointer select-none text-xs font-medium text-muted transition-colors hover:text-foreground">
                  Show the exchange
                </summary>
                <div className="mt-3 space-y-3 text-sm">
                  <div className="rounded-xl bg-background px-4 py-3">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">User asked</div>
                    <div className="whitespace-pre-wrap text-foreground">{e.userText || "(no preceding user message)"}</div>
                  </div>
                  <div className="rounded-xl bg-background px-4 py-3">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Rated reply</div>
                    <div className="whitespace-pre-wrap text-foreground">{e.assistantText}</div>
                  </div>
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

const iconSvg = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

function ThumbUp() {
  return (
    <svg className="h-3.5 w-3.5" {...iconSvg}>
      <path d="M7 11v9M3 13v5a2 2 0 0 0 2 2h11.3a2 2 0 0 0 2-1.7l1.2-7a2 2 0 0 0-2-2.3H13l1-4.3A1.8 1.8 0 0 0 10.6 3L7 11" />
    </svg>
  );
}
function ThumbDown() {
  return (
    <svg className="h-3.5 w-3.5" {...iconSvg}>
      <path d="M17 13V4M21 11V6a2 2 0 0 0-2-2H7.7a2 2 0 0 0-2 1.7l-1.2 7a2 2 0 0 0 2 2.3H11l-1 4.3A1.8 1.8 0 0 0 13.4 21L17 13" />
    </svg>
  );
}
function Sparkle() {
  return (
    <svg className="h-3.5 w-3.5" {...iconSvg}>
      <path d="M12 3l1.9 4.8L19 9.7l-4.1 2.9L16 18l-4-3-4 3 1.1-5.4L5 9.7l5.1-1.9z" />
    </svg>
  );
}
