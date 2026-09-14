/**
 * Reply timeline (owner ask, 2026-07-19): Anthropic models narrate BETWEEN
 * tool calls ("Let me check X first…" → calls → "Now let's…" → calls → final
 * answer). The reply's text is stored as one string, but each activity item
 * (status line / run block) carries `at` — the length of the reply text at
 * the moment it was emitted — so the UI can re-interleave prose and activity
 * in true chronological order instead of lumping all activity above the text.
 *
 * Pure module: shared by the bubble renderer (client) and unit tests.
 */

/** Split a reply into ordered slots: each slot's text renders BEFORE its
 *  activity items; the final slot carries the trailing text and no items.
 *  Items with the same offset share a slot; offsets are clamped to the
 *  content and never move backwards (out-of-order safety → same slot). */
export interface TimelineSlot<T> {
  /** Text range [start, end) of this slot's prose (may be empty). */
  start: number;
  end: number;
  /** Activity that happened right after that prose. */
  items: T[];
}

export function segmentReply<T extends { at?: number }>(
  contentLength: number,
  activity: T[],
): TimelineSlot<T>[] {
  const groups: { at: number; items: T[] }[] = [];
  for (const item of activity) {
    const raw = Math.max(0, Math.min(item.at ?? 0, contentLength));
    const last = groups[groups.length - 1];
    if (last && raw <= last.at) last.items.push(item);
    else groups.push({ at: raw, items: [item] });
  }

  const slots: TimelineSlot<T>[] = [];
  let cursor = 0;
  for (const g of groups) {
    slots.push({ start: cursor, end: g.at, items: g.items });
    cursor = g.at;
  }
  slots.push({ start: cursor, end: contentLength, items: [] });
  return slots;
}
