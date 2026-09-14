import type { ReactNode } from "react";

/**
 * Small shared pieces for the console pages. Server-safe (pure render), and
 * deliberately the same visual language as `components/admin/ui.tsx` — this is
 * the same product seen from above, not a different one.
 */

/** A headline number with a label and optional secondary line. */
export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "warn" | "bad" | "good";
}) {
  const toneCls =
    tone === "bad"
      ? "text-red-500"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "good"
          ? "text-emerald-500"
          : "text-foreground";
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tracking-tight ${toneCls}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/** The portal a row belongs to, as a small tag. */
export function PortalTag({ label }: { label: string }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
      {label}
    </span>
  );
}

/**
 * A portal that could not be read.
 *
 * Shown inline on the page it affects rather than swallowed, because the
 * moment you most want this dashboard is the moment something is wrong — a
 * number that is quietly missing one of four portals is worse than no number.
 */
export function Unreachable({ errors }: { errors: { portal: string; error: string }[] }) {
  if (!errors.length) return null;
  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
        {errors.length} portal{errors.length === 1 ? "" : "s"} could not be read — the figures
        below exclude {errors.length === 1 ? "it" : "them"}.
      </p>
      <ul className="mt-2 space-y-1">
        {errors.map((e) => (
          <li key={e.portal} className="text-xs text-muted">
            <span className="font-medium text-foreground">{e.portal}</span> — {e.error}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Nothing to show yet. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}

/** A plain scrollable table wrapper — wide tables must never widen the page. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface oi-scroll">
      <table className="w-full min-w-[640px] text-sm">{children}</table>
    </div>
  );
}

export const thCls =
  "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted";
export const tdCls = "px-3 py-2 align-middle";

/* — formatting shared by the console pages — */

export function money(n: number): string {
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "3 minutes ago" / "6 days ago" — relative, because the question is always
 *  "is this recent", never "what was the exact timestamp". */
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
