/**
 * Attach a conversation's files to the messages they belong to, for the chat
 * loader. Files ride the message they were sent with — a user's uploads on the
 * user turn, an assistant's generated outputs on the reply.
 *
 * New messages carry exact linkage in `meta.fileIds`. Older chats (recorded
 * before that linkage existed) are reconstructed by TIME: an upload belongs to
 * the first user turn at/after its upload time; a generated file to the first
 * assistant reply at/after its creation (or the last reply as a fallback).
 * Files with no home (composer abandoned mid-attach — uploaded, never sent)
 * are returned as `pending` so the composer restores them.
 *
 * Pure + framework-free so it can be unit-tested without a DB or React.
 */

export interface FileLite {
  id: string;
  kind: string; // "upload" | "generated"
  createdAt: Date;
}

export interface MessageLite {
  id: string;
  role: "user" | "assistant";
  createdAt: Date;
  /** meta.fileIds if present. */
  fileIds?: string[];
}

export interface AttachResult<F> {
  /** messageId → files, in the file order given. */
  byMessage: Map<string, F[]>;
  /** Files with no owning message — restore into the composer. */
  pending: F[];
}

export function attachFilesToMessages<F extends FileLite>(
  messages: MessageLite[],
  files: F[],
): AttachResult<F> {
  const byMessage = new Map<string, F[]>();
  const claimed = new Set<string>();
  const fileById = new Map(files.map((f) => [f.id, f]));
  const push = (messageId: string, f: F) => {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), f]);
    claimed.add(f.id);
  };

  // 1. Exact linkage from meta.fileIds (authoritative, order preserved).
  //
  // A file may be named by MORE THAN ONE message, and every naming is real:
  // the person attaches a document and the assistant PRESENTS THE SAME ONE
  // BACK, so both turns legitimately carry it. Letting the first message to
  // mention a file claim it exclusively is what made presented files vanish —
  // they showed while the reply streamed (the `files` SSE event draws them
  // directly) and were gone on the next load, because by then the loader had
  // given both ids to the user's turn and left the reply with nothing.
  // `claimed` decides only whether a file still NEEDS a home, never whether it
  // is allowed a second one.
  for (const m of messages) {
    const here = new Set<string>();
    for (const id of m.fileIds ?? []) {
      const f = fileById.get(id);
      // Guard the same id listed twice on ONE message — that is a duplicate
      // card, not a second home.
      if (!f || here.has(id)) continue;
      here.add(id);
      push(m.id, f);
    }
  }

  // 2. Time-based reconstruction for UPLOADS still unclaimed (legacy chats).
  //    Generated files attach ONLY via meta.fileIds: since presentation
  //    (2026-07-19) the pool is the assistant's private workspace — an
  //    unpresented output must stay invisible, so no time fallback for them
  //    (and they are never "pending"; that would dump workspace files into
  //    the composer strip).
  for (const f of files) {
    if (claimed.has(f.id) || f.kind === "generated") continue;
    const target = messages.find((m) => m.role === "user" && m.createdAt >= f.createdAt);
    if (target) push(target.id, f);
  }

  const pending = files.filter((f) => !claimed.has(f.id) && f.kind !== "generated");
  return { byMessage, pending };
}
