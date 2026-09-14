import { attachFilesToMessages } from "@/lib/message-files";
import { displayName } from "@/lib/chat-rules";
import type { UIMessage } from "@/components/chat/message-bubble";
import type { Attachment } from "@/components/chat/file-chip";
import type { ToolRunRecord } from "@/lib/tool-run";
import type { AskRecord } from "@/lib/ask";

/**
 * Rebuild a stored conversation into the exact shape the chat UI renders.
 *
 * Used by BOTH the user's own chat page and the admin support viewer, so the
 * two can never drift: an admin reading someone's chat sees precisely what
 * that person saw — same bubbles, attachments, generated images, tool-run
 * chips, visualisations and sources — because it is literally the same
 * component fed by the same builder. The only difference is that the admin
 * view passes no action handlers, so nothing is editable, ratable or
 * retryable there.
 */

/** The message columns this builder needs (a Prisma row satisfies it). */
export interface ThreadMessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  meta: unknown;
  /** Who wrote a user turn (v0.5 shared chats); null = account since deleted. */
  userId?: string | null;
}

/** Profile fields for labelling who wrote what (shared chats). */
export interface ThreadAuthor {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface ThreadOptions {
  /** When given, every user turn gets an `author` (a shared chat). A row
   *  whose author is not in the map reads as "Former member". */
  authors?: Map<string, ThreadAuthor>;
  /** Ratings are per person: the viewer's own is what the buttons show. The
   *  owner's also lives in the legacy `meta.rating`, which is what an admin
   *  viewer (no viewer id) and older rows fall back to. */
  viewerId?: string;
  ownerId?: string;
  /** Conversation compaction: the LAST message the stored summary covers —
   *  the screen draws a divider after it ("earlier messages summarised"). */
  compactedThroughId?: string | null;
}

/** The file columns this builder needs (a Prisma row satisfies it). */
export interface ThreadFileRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: bigint | number;
  status: string;
  kind: string;
  createdAt: Date;
}

type MessageMeta = {
  rating?: "up" | "down";
  /** Per-person ratings (v0.5) keyed by user id. */
  ratings?: Record<string, "up" | "down">;
  notice?: string;
  fileIds?: string[];
  followups?: string[];
  viz?: { title: string; html: string }[];
  sources?: { url: string; title?: string; kind?: "web" | "file"; fileId?: string }[];
  images?: { fileId: string; aspectRatio: string; prompt: string; operation: string; version?: number }[];
  toolRuns?: ToolRunRecord[];
  /** Question cards raised this turn (ask_user), joined by id from `activity`. */
  asks?: AskRecord[];
  /** This user row is an answer to a question card — the card renders it
   *  inline where it was asked, so it gets no bubble of its own. */
  askAnswer?: boolean;
  /** Ordered status/run/ask log with reply-text offsets (interleave). */
  activity?: (
    | { kind: "status"; label: string; at: number }
    | { kind: "run"; id: string; at: number }
    | { kind: "ask"; id: string; at: number }
    | { kind: "image"; id: string; at: number }
    | { kind: "files"; ids: string[]; at: number }
  )[];
} | null;

export interface ChatThread {
  /** Ready to hand straight to `<MessageBubble>`. */
  messages: UIMessage[];
  /** Uploads that were never sent (attach → reload before send). */
  pending: Attachment[];
  /** Follow-up suggestions persisted on the final reply. */
  followups: string[];
  /** The last message the assistant now sees only as a summary (null = none). */
  compactedThroughId: string | null;
}

export function buildChatThread(
  messageRows: ThreadMessageRow[],
  fileRows: ThreadFileRow[],
  opts: ThreadOptions = {},
): ChatThread {
  const authorOf = (m: ThreadMessageRow): UIMessage["author"] | undefined => {
    if (!opts.authors || m.role !== "user") return undefined;
    const p = m.userId ? opts.authors.get(m.userId) : undefined;
    return p
      ? { id: p.id, name: displayName(p), image: p.image }
      : { id: m.userId ?? "", name: "Former member", image: null };
  };
  const ratingOf = (meta: MessageMeta): "up" | "down" | null => {
    if (!meta) return null;
    if (opts.viewerId) {
      const mine = meta.ratings?.[opts.viewerId];
      if (mine) return mine;
      // Older rows: the single rating was the owner's.
      if (!meta.ratings && opts.viewerId === opts.ownerId) return meta.rating ?? null;
      return null;
    }
    return meta.rating ?? null;
  };
  const rows = messageRows.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      // Answers to a question card are shown BY the card, in the position the
      // question was asked. The row still exists and is still replayed to the
      // model (without it the assistant forgets its own question's answer on
      // the very next message) — it simply has no bubble.
      (m.meta as MessageMeta)?.askAnswer !== true,
  );

  const toChip = (f: ThreadFileRow) => ({
    id: f.id,
    filename: f.filename,
    mimeType: f.mimeType,
    sizeBytes: Number(f.sizeBytes),
    status: f.status,
    kind: f.kind,
    createdAt: f.createdAt,
  });

  // Generated IMAGES render as first-class GeneratedImage cards (from
  // meta.images), so exclude them from the file-card reconstruction — else the
  // time-based fallback would ALSO attach them as plain download cards.
  const imageFileIds = new Set<string>();
  for (const m of rows) {
    for (const img of (m.meta as MessageMeta)?.images ?? []) imageFileIds.add(img.fileId);
  }

  const { byMessage, pending } = attachFilesToMessages(
    rows.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      createdAt: m.createdAt,
      fileIds: (m.meta as MessageMeta)?.fileIds,
    })),
    fileRows.filter((f) => !imageFileIds.has(f.id)).map(toChip),
  );

  const stripChip = (f: ReturnType<typeof toChip>): Attachment => ({
    id: f.id,
    filename: f.filename,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    status: f.status,
  });

  const messages: UIMessage[] = rows.map((m) => {
    const meta = m.meta as MessageMeta;
    // Rebuild the interleaved timeline: statuses inline, runs joined to their
    // full toolRuns record (done state). Pre-feature rows fall back to runs
    // at offset 0 (everything above the text, as before).
    const runById = new Map((meta?.toolRuns ?? []).map((r) => [r.id, r]));
    const askById = new Map((meta?.asks ?? []).map((a) => [a.id, a]));
    const toRunItem = (r: ToolRunRecord, at: number) => ({
      kind: "run" as const,
      at,
      run: { ...r, code: r.code ?? "", output: r.output ?? "", phase: "done" as const },
    });
    const imageIds = new Set((meta?.images ?? []).map((g) => g.fileId));
    const presentedIds = new Set((byMessage.get(m.id) ?? []).map((f) => f.id));
    type Item = NonNullable<UIMessage["activity"]>[number];
    const toItem = (a: NonNullable<NonNullable<MessageMeta>["activity"]>[number]): Item | null => {
      if (a.kind === "status") return { kind: "status", label: a.label, at: a.at };
      if (a.kind === "ask") {
        // A card the turn died on stays "pending" in meta; on reload nothing
        // is waiting any more, so read it as unanswered.
        const ask = askById.get(a.id);
        return ask
          ? { kind: "ask", at: a.at, ask: { ...ask, status: ask.status === "pending" ? ("dismissed" as const) : ask.status } }
          : null;
      }
      // Deliverables at the point they were presented (owner ask 2026-09-02).
      if (a.kind === "image") return imageIds.has(a.id) ? { kind: "image", id: a.id, at: a.at } : null;
      if (a.kind === "files") {
        const ids = a.ids.filter((id) => presentedIds.has(id));
        return ids.length ? { kind: "files", ids, at: a.at } : null;
      }
      const run = runById.get(a.id);
      return run ? toRunItem(run, a.at) : null;
    };
    const activity: Item[] = meta?.activity?.length
      ? meta.activity.map(toItem).filter((x): x is Item => x !== null)
      : (meta?.toolRuns ?? []).map((r) => toRunItem(r, 0));
    const files = byMessage.get(m.id)?.map(stripChip);

    const author = authorOf(m);
    return {
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      dbId: m.id,
      createdAt: m.createdAt.toISOString(),
      rating: ratingOf(meta),
      ...(author ? { author } : {}),
      ...(meta?.notice ? { notice: meta.notice } : {}),
      ...(meta?.viz?.length
        ? { viz: meta.viz.map((v) => ({ ...v, done: true })) }
        : {}),
      ...(activity.length ? { activity } : {}),
      ...(meta?.sources?.length ? { sources: meta.sources } : {}),
      ...(files?.length ? { files } : {}),
      ...(meta?.images?.length
        ? {
            genImages: meta.images.map((g) => ({
              id: g.fileId,
              aspectRatio: g.aspectRatio,
              prompt: g.prompt,
              operation: g.operation,
              fileId: g.fileId,
              ...(g.version ? { version: g.version } : {}),
              status: "ready" as const,
            })),
          }
        : {}),
    };
  });

  // Follow-ups persisted on the FINAL reply survive navigation (the window
  // remounts per conversation, so client state alone loses them).
  const lastRow = rows[rows.length - 1];
  const followups =
    lastRow?.role === "assistant"
      ? ((lastRow.meta as MessageMeta)?.followups ?? [])
      : [];

  return {
    messages,
    pending: pending.map(stripChip),
    followups,
    compactedThroughId: opts.compactedThroughId ?? null,
  };
}
