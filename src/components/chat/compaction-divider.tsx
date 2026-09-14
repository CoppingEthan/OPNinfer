/**
 * The line a compacted chat draws under the last message the assistant now
 * sees only as a summary (2026-09-10, owner: "seems simple enough and not too
 * intrusive"). Everything above it is still on screen and still theirs; it
 * just tells them why the assistant may be vaguer about old detail. Shared
 * by the chat window and the admin transcript, so the two match.
 */
export function CompactionDivider() {
  return (
    <div
      role="separator"
      aria-label="Earlier messages summarised for the assistant"
      data-compaction-divider
      className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-wide text-muted"
    >
      <span className="h-px flex-1 bg-border" />
      <span>Earlier messages summarised for the assistant</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
