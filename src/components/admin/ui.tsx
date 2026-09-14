import type { ReactNode } from "react";

/**
 * Shared admin UI primitives, styled to match the chat surface (rounded-2xl
 * cards, soft borders, subtle focus) so the admin area feels like the same
 * product rather than a separate console. Server-safe (pure render).
 */

/** Card surface — matches the chat composer / message cards. */
export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-border bg-surface p-5 ${className}`}>
      {children}
    </div>
  );
}

/** Section wrapper: a small uppercase heading over its content. */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      {hint ? <p className="mb-3 mt-0.5 text-sm text-muted">{hint}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

/** Input/select style shared across admin forms — soft focus, no heavy ring. */
export const fieldCls =
  "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/60 focus-visible:outline-none disabled:opacity-50";

/** Labelled field wrapper. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
