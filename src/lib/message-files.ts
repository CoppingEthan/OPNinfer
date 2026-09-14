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
  for (const m of messages) {
    for (const id of m.fileIds ?? []) {
      const f = fileById.get(id);
      if (f && !claimed.has(id)) push(m.id, f);
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
