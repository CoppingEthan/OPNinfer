"use client";

/**
 * Follow-up suggestions from the front-end model, shown after a period of
 * inactivity. Clicking one sends it as the next message.
 */
export function FollowUps({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (s: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 pt-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Suggested follow-ups
      </p>
      <div className="flex flex-col items-start gap-2">
        {suggestions.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-xl border border-border bg-surface px-3.5 py-2 text-left text-sm text-foreground transition-colors hover:border-accent hover:bg-surface-hover"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
