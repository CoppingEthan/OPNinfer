/**
 * The live feed for shared chats (docs/V05_SHARED_CHATS.md §5).
 *
 * Every open chat tab holds ONE long-lived SSE connection
 * (`GET /api/chat/live?viewing=<conversationId>&client=<tabId>`), registered
 * here with who it belongs to and which chat it is looking at. Events are
 * then fanned out two ways:
 *
 *   - `publishToChat(id, …)`  — to every tab VIEWING that chat: another
 *     person's message, "a reply started" (the tab then attaches to the
 *     reply stream `turn-stream.ts` already keeps for resuming), the
 *     scheduled queue, people changes, presence, reloads.
 *   - `publishToUsers(ids, …)` — to every tab of those PEOPLE, wherever they
 *     are: a chat shared with them, one taken away, sidebar bumps, titles,
 *     deletions.
 *
 * Presence falls out of the registry: who is online in a chat = the distinct
 * owners of connections viewing it.
 *
 * In memory on the single instance, like the turn registry and the mailboxes,
 * and anchored on globalThis for the same reason (Next instantiates modules
 * once PER ROUTE BUNDLE — the live route and the chat route must share this).
 */

export interface LiveEvent {
  type: string;
  [key: string]: unknown;
}

export interface LiveSubscriber {
  userId: string;
  /** Per-tab id the browser minted, so a tab can skip its own echoes. */
  clientId: string;
  /** The chat this tab has open, if any. */
  viewing: string | null;
  send: (ev: LiveEvent) => void;
}

const subs: Set<LiveSubscriber> = ((
  globalThis as { __oiLiveSubs?: Set<LiveSubscriber> }
).__oiLiveSubs ??= new Set());

/** Register a connection. Returns the unsubscribe. */
export function subscribeLive(sub: LiveSubscriber): () => void {
  subs.add(sub);
  return () => {
    subs.delete(sub);
  };
}

function deliver(sub: LiveSubscriber, ev: LiveEvent): void {
  try {
    sub.send(ev);
  } catch {
    subs.delete(sub);
  }
}

/** To every tab viewing the chat (optionally not the tab that caused it). */
export function publishToChat(
  conversationId: string,
  ev: LiveEvent,
  opts: { exceptClient?: string } = {},
): void {
  for (const sub of subs) {
    if (sub.viewing !== conversationId) continue;
    if (opts.exceptClient && sub.clientId === opts.exceptClient) continue;
    deliver(sub, { conversationId, ...ev });
  }
}

/** To every tab of these people, wherever they are. `onDeliver` sees each
 *  recipient (the live route uses it to mark a viewed chat as read). */
export function publishToUsers(
  userIds: Iterable<string>,
  ev: LiveEvent,
  opts: { exceptClient?: string; onDeliver?: (sub: LiveSubscriber) => void } = {},
): void {
  const targets = new Set(userIds);
  if (targets.size === 0) return;
  for (const sub of subs) {
    if (!targets.has(sub.userId)) continue;
    if (opts.exceptClient && sub.clientId === opts.exceptClient) continue;
    deliver(sub, ev);
    opts.onDeliver?.(sub);
  }
}

/**
 * Cut a person's open connections off from a chat they no longer have access
 * to (removed by the owner, or the chat deleted). Access is checked ONCE, at
 * connect; without this a removed member's tab kept receiving every later
 * message, the queue and the people list until they navigated away (audit,
 * 2026-09-05). Returns how many connections were detached.
 */
export function detachViewer(conversationId: string, userId?: string): number {
  let n = 0;
  for (const sub of subs) {
    if (sub.viewing !== conversationId) continue;
    if (userId && sub.userId !== userId) continue;
    sub.viewing = null;
    n++;
  }
  return n;
}

/** Distinct people with the chat open right now. */
export function chatViewers(conversationId: string): string[] {
  const out = new Set<string>();
  for (const sub of subs) if (sub.viewing === conversationId) out.add(sub.userId);
  return [...out];
}

/** Tell everyone looking at the chat who else is looking. */
export function broadcastPresence(conversationId: string): void {
  publishToChat(conversationId, { type: "presence", online: chatViewers(conversationId) });
}

/** For tests and the admin health line. */
export function liveConnectionCount(): number {
  return subs.size;
}
