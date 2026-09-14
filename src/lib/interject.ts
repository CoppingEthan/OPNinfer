/**
 * Mid-turn interjection mailboxes (queued-message injection).
 *
 * A user who types while the assistant is mid TOOL LOOP shouldn't have to
 * wait for the whole task to finish — the message is offered here, and the
 * tool loops drain it between rounds, appending it as a real user turn so
 * the model course-corrects immediately ("actually October, direct only").
 * Plain prose replies have no injection seam; unconsumed offers are simply
 * discarded when the turn ends and the SERVER-SIDE queue (`chat-queue.ts`)
 * sends the message as its own turn instead.
 *
 * Since v0.5 (shared chats) every offer carries WHO made it — the spliced-in
 * bubble is persisted as that person's message — and an id, so the scheduled
 * queue can drop its copy the moment the running turn consumes the offer.
 *
 * In-memory by design — OPNinfer is single-instance (see CLAUDE.md
 * "Concurrency & multi-user scale"); horizontal scaling would externalise
 * this alongside the model cache.
 */

export interface Interjection {
  /** Matches the scheduled-queue item it was offered from (or a fresh id). */
  id: string;
  /** Who typed it — the persisted user turn is theirs. */
  userId: string;
  content: string;
}

// Anchored on globalThis — Next can instantiate a module once PER ROUTE
// BUNDLE (the same reason db.ts globals the Prisma client), and the chat
// route and the interject route must see the SAME map or every offer is
// refused. Verified live: a plain module-level Map came up empty cross-route.
const mailboxes: Map<string, Interjection[]> = ((
  globalThis as { __oiInterjectMailboxes?: Map<string, Interjection[]> }
).__oiInterjectMailboxes ??= new Map());

/** The chat route opens a mailbox for the conversation while its turn runs. */
export function openInterjectionMailbox(conversationId: string): void {
  mailboxes.set(conversationId, []);
}

/** Closed (and any unconsumed offers dropped) when the turn's stream ends —
 *  the scheduled queue still holds its own copy and sends it as a new turn. */
export function closeInterjectionMailbox(conversationId: string): void {
  mailboxes.delete(conversationId);
}

/** Offer a message for mid-turn injection. False → no turn is listening
 *  (nothing streaming, or the instance restarted) — caller keeps the text. */
export function offerInterjection(conversationId: string, item: Interjection): boolean {
  const box = mailboxes.get(conversationId);
  if (!box) return false;
  box.push(item);
  return true;
}

/** Take an offer back (the person cancelled their scheduled message before
 *  the turn reached a seam). False → it was already consumed or never there. */
export function withdrawInterjection(conversationId: string, id: string): boolean {
  const box = mailboxes.get(conversationId);
  if (!box) return false;
  const i = box.findIndex((x) => x.id === id);
  if (i === -1) return false;
  box.splice(i, 1);
  return true;
}

/** Withdraw every offer from one person (removed from the chat mid-turn —
 *  their steer must not be spliced in as a real turn after they are gone). */
export function withdrawInterjectionsByUser(conversationId: string, userId: string): number {
  const box = mailboxes.get(conversationId);
  if (!box) return 0;
  const before = box.length;
  const kept = box.filter((x) => x.userId !== userId);
  box.splice(0, box.length, ...kept);
  return before - kept.length;
}

/** Take everything offered so far (in order). Persistence + SSE events are
 *  the consumer's job (the pipeline, which owns the turn's transcript). */
export function drainInterjections(conversationId: string): Interjection[] {
  const box = mailboxes.get(conversationId);
  if (!box || box.length === 0) return [];
  return box.splice(0, box.length);
}

/**
 * Look WITHOUT taking. The Sandbox agent tool feeds a running agent a copy of
 * each mid-run message this way, and leaves the mailbox intact so the
 * pipeline still drains it between rounds — persisting the message, moving
 * the bubble, and appending it to the live transcript as a genuine user
 * turn the conversation model will then honour. (Draining here and relaying
 * the text inside the tool result instead made the model — correctly —
 * treat "the user also said…" as a likely injection.)
 */
export function peekInterjections(conversationId: string): Interjection[] {
  const box = mailboxes.get(conversationId);
  return box ? [...box] : [];
}
