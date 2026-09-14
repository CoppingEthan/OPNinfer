/**
 * The scheduled-message queue, held SERVER-SIDE (v0.5 — docs/V05_SHARED_CHATS.md).
 *
 * Before: a message typed while a reply was streaming lived only in that
 * browser tab and was sent when the stream ended. With several people in a
 * chat that breaks — two tabs would race to send, and nobody else could see
 * what was lined up. Now the portal holds one queue per chat: everyone sees
 * the chips, entries run in arrival order once the reply finishes (each as a
 * normal turn sent AS ITS AUTHOR), and a refresh no longer loses them.
 *
 * Each entry is also OFFERED to the running turn as an interjection (unless
 * it carries attachments): if the assistant is between tool steps it is
 * spliced straight in and the queue drops its copy (`consumeQueued`); a
 * prose reply never consumes the offer, so the entry runs afterwards.
 *
 * In memory, single-instance, globalThis-anchored — same rules and reasons as
 * the interjection mailboxes it pairs with. A restart drops the queue (as a
 * restart used to drop the tab's copy).
 */

export interface QueuedAuthor {
  id: string;
  name: string;
  image: string | null;
}

export interface QueuedMessage {
  id: string;
  conversationId: string;
  userId: string;
  author: QueuedAuthor;
  content: string;
  fileIds: string[];
  extendedThinking: boolean;
  /** Also offered to the running turn for mid-task injection. */
  steering: boolean;
  /** The tab that queued it (so it can skip its own echo). */
  origin?: string;
  createdAt: number;
}

/** What every tab is shown — never the file ids or the thinking flag. */
export interface QueuedMessageView {
  id: string;
  userId: string;
  author: QueuedAuthor;
  content: string;
  steering: boolean;
  fileCount: number;
}

const queues: Map<string, QueuedMessage[]> = ((
  globalThis as { __oiChatQueues?: Map<string, QueuedMessage[]> }
).__oiChatQueues ??= new Map());

/** Cap per chat — beyond this, sends are refused rather than piling up. */
export const QUEUE_CAP = 10;

export function enqueueMessage(item: QueuedMessage): boolean {
  const q = queues.get(item.conversationId) ?? [];
  if (q.length >= QUEUE_CAP) return false;
  q.push(item);
  queues.set(item.conversationId, q);
  return true;
}

export function listQueued(conversationId: string): QueuedMessage[] {
  return [...(queues.get(conversationId) ?? [])];
}

/** Take the next entry to run (arrival order). */
export function shiftQueued(conversationId: string): QueuedMessage | null {
  const q = queues.get(conversationId);
  if (!q || q.length === 0) return null;
  const item = q.shift()!;
  if (q.length === 0) queues.delete(conversationId);
  return item;
}

/** Remove one entry by id (cancelled, or consumed as an interjection). */
export function removeQueued(conversationId: string, id: string): QueuedMessage | null {
  const q = queues.get(conversationId);
  if (!q) return null;
  const i = q.findIndex((x) => x.id === id);
  if (i === -1) return null;
  const [item] = q.splice(i, 1);
  if (q.length === 0) queues.delete(conversationId);
  return item;
}

/** Drop everything for a chat (deleted). */
export function clearQueued(conversationId: string): void {
  queues.delete(conversationId);
}

/** Drop one person's entries (they were removed from the chat, or left).
 *  Returns the dropped ids. */
export function removeQueuedByUser(conversationId: string, userId: string): string[] {
  const q = queues.get(conversationId);
  if (!q) return [];
  const dropped = q.filter((x) => x.userId === userId).map((x) => x.id);
  const kept = q.filter((x) => x.userId !== userId);
  if (kept.length === 0) queues.delete(conversationId);
  else queues.set(conversationId, kept);
  return dropped;
}

/** Put an entry back at the FRONT — the turn it was shifted for lost the
 *  registry race to a human's send, so it must run next, not vanish. */
export function requeueFront(item: QueuedMessage): void {
  const q = queues.get(item.conversationId) ?? [];
  q.unshift(item);
  queues.set(item.conversationId, q);
}

export function queueSnapshot(conversationId: string): QueuedMessageView[] {
  return listQueued(conversationId).map((m) => ({
    id: m.id,
    userId: m.userId,
    author: m.author,
    content: m.content,
    steering: m.steering,
    fileCount: m.fileIds.length,
  }));
}
