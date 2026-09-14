/**
 * Conversation compaction — the PURE half (no DB, no provider, client-safe).
 *
 * The problem (2026-09-10): nothing in the app ever shortened a conversation.
 * The old "curation" only trims tool results and only runs between tool
 * rounds, so a chat's whole history was re-sent on every message for ever —
 * one imported chat reached 525k tokens and cost US$2 a message. This module
 * decides WHERE to cut a long history, HOW to hand the older part to the
 * front-end model in pieces it can read, and WHAT the reply model is shown in
 * place of it. The server half (compaction.ts) does the reading and writing.
 *
 * Shape, borrowed from Claude Code and Codex: keep the most recent turns
 * verbatim, summarise everything before them into ONE rolling summary
 * (always the newest — a later compaction rewrites it, folding in what came
 * since), and never let a reply be summarised away from its question.
 */

/** The message columns compaction needs (a Prisma row satisfies it). */
export interface CompactRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date | string;
  /** Who wrote a user turn in a shared chat; null/undefined otherwise. */
  userId?: string | null;
}

/** Rough token estimate: chars / 4 — the same rule curation uses. */
export function rowTokens(row: { content: string }): number {
  return Math.ceil(row.content.length / 4);
}

export function estimateRowsTokens(rows: readonly { content: string }[]): number {
  let n = 0;
  for (const r of rows) n += rowTokens(r);
  return n;
}

/**
 * Where to cut: returns the index of the LAST row to summarise, or -1 when
 * there is nothing to summarise. Everything after it is kept verbatim.
 *
 * Walks back from the newest row one TURN at a time (a turn starts at a user
 * row) until keeping one more turn would exceed `keepTokens`. A turn is kept
 * or summarised whole — a reply never survives without its question. If even
 * the newest turn is bigger than the budget (a giant paste), nothing is kept:
 * the summary alone precedes the next message, which is still far cheaper
 * than the alternative.
 *
 * `after` is the index of a previous compaction's boundary (-1 for none): the
 * new cut is always later than it, so the rolling summary only ever moves
 * forward. When the kept window would reach back to or before the previous
 * boundary — the recent turns alone exceed the budget — everything is
 * summarised (the cut lands on the last row).
 */
export function selectBoundary(
  rows: readonly CompactRow[],
  keepTokens: number,
  after = -1,
): number {
  if (rows.length === 0) return -1;
  // Turn starts: every user row (a leading assistant row belongs to turn 0).
  const starts: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].role === "user") starts.push(i);
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

  let kept = 0;
  let cutAt = rows.length; // first kept index
  for (let s = starts.length - 1; s >= 0; s--) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : rows.length;
    let turn = 0;
    for (let i = start; i < end; i++) turn += rowTokens(rows[i]);
    if (kept + turn > keepTokens) break;
    kept += turn;
    cutAt = start;
  }
  if (cutAt === 0 && after < 0) return -1; // everything fits
  let boundary = cutAt - 1;
  if (after >= 0 && boundary <= after) boundary = rows.length - 1;
  return boundary;
}

/** One row as the summariser sees it. */
export function renderRow(row: CompactRow, authorName?: string | null): string {
  const who =
    row.role === "user"
      ? authorName
        ? `User (${authorName})`
        : "User"
      : row.role === "assistant"
        ? "Assistant"
        : row.role;
  return `${who}:\n${row.content.trim()}`;
}

/** Default reading window for one summariser call: ~48k tokens of transcript. */
export const DEFAULT_CHUNK_CHARS = 48_000 * 4;

/**
 * Pack rendered rows into pieces the front-end model can read in one call.
 * Rows are never re-ordered; a single row longer than the cap is split on
 * its own (1.78 MB assistant messages exist in production) with continuation
 * markers so the model knows it is reading one long thing.
 */
export function planChunks(
  rows: readonly CompactRow[],
  authorOf: (row: CompactRow) => string | null | undefined = () => null,
  maxChars = DEFAULT_CHUNK_CHARS,
): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trimEnd());
    current = "";
  };
  for (const row of rows) {
    const text = renderRow(row, authorOf(row));
    if (text.length > maxChars) {
      flush();
      for (let at = 0, part = 1; at < text.length; at += maxChars, part++) {
        const slice = text.slice(at, at + maxChars);
        chunks.push(at === 0 ? slice : `(continued, part ${part})\n${slice}`);
      }
      continue;
    }
    if (current.length + text.length + 2 > maxChars) flush();
    current += (current ? "\n\n" : "") + text;
  }
  flush();
  return chunks;
}

/** Hard ceiling on a stored summary, cut at a paragraph or line so it never
 *  ends mid-sentence. ~10k tokens. The first production sweep showed three
 *  summaries sitting exactly on a 16k cap: section 3 (reusable content,
 *  verbatim) is allowed to run long, and clipping at the END loses sections
 *  5–6 — the open items and the latest request — which are the ones the next
 *  reply needs most. A compacted chat still replays at ~30k. */
export const SUMMARY_MAX_CHARS = 40_000;

export function clipSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(". "));
  return (cut > max * 0.6 ? head.slice(0, cut + 1) : head).trim();
}

/**
 * What the front-end model is told. The section list is the point: it is
 * what Claude Code's and Codex's compaction prompts converge on, adapted to a
 * chat portal — and section 3 exists because the chat that prompted all this
 * IS its email template; a summary that paraphrased it would lose the work.
 */
export const COMPACTION_SYSTEM = `You are compacting a long chat between a person and an AI assistant, so the assistant can carry on with less history. Write a summary of the conversation so far that lets the assistant continue exactly as if it had read every message.

Use these headings, in this order, and leave a heading out only if there is nothing for it:

1. What the user is working on and wants — their goals and requests, in their own words where possible.
2. Key facts, names, numbers, dates and decisions — anything a later answer would need to get right.
3. Content to reuse — templates, drafts, final wording, lists, code the user has been building. Keep the LATEST version of each VERBATIM (word for word), not paraphrased. This section may be long if the content matters.
4. Preferences and standing instructions the user gave in this chat (tone, format, length, things to avoid).
5. Open items — what was asked and not finished, and anything the assistant promised.
6. The most recent request — the user's last message, verbatim.

You may be given a "summary so far" together with a further part of the transcript. Then produce ONE merged summary that REPLACES the summary so far: keep everything from it that is still relevant, fold in the new part, and replace what has been superseded. If you are given only part of a long transcript, summarise what you can see; a later part may follow.

Never invent anything. If something is unclear or contradictory, leave it out rather than guess. Do not add commentary, greetings or notes about this task. Plain text, about 2,000 words at most (section 3 may push past that when the content is worth keeping).`;

export function compactionUserPrompt(
  summarySoFar: string | null,
  part: string,
  index: number,
  total: number,
): string {
  const head =
    summarySoFar && summarySoFar.trim()
      ? `Summary so far:\n${summarySoFar.trim()}\n\n`
      : "";
  const label = total > 1 ? ` (part ${index + 1} of ${total})` : "";
  return `${head}Transcript${label}:\n\n${part}`;
}

/**
 * What the REPLY model is sent in place of the summarised rows: one user
 * message carrying the summary (Anthropic's own recommended client-side
 * shape) and a short acknowledgement, so roles keep alternating for every
 * provider without leaning on the mappers' merging.
 */
export function summaryMessages(summary: string, messagesCovered: number): {
  role: "user" | "assistant";
  content: string;
}[] {
  return [
    {
      role: "user",
      content:
        `[Summary of the earlier part of this conversation. It was written to keep the chat fast and replaces the ${messagesCovered} earlier messages, which the user can still see on their screen. Treat it as what was said.]\n\n` +
        summary.trim(),
    },
    {
      role: "assistant",
      content:
        "Understood — I have the earlier context from that summary and will continue from here.",
    },
  ];
}
