/**
 * Resumable turn streams. A running assistant turn is decoupled from the HTTP
 * request that started it: the generation loop PUBLISHES every SSE event into
 * a per-conversation TurnStream here, and HTTP responses (the original POST,
 * plus any number of later resume GETs) merely SUBSCRIBE — replaying the
 * buffered events first, then following live. Leaving the page therefore only
 * detaches a subscriber; generation runs to completion and the reply is saved.
 * Re-entering the chat (or refreshing, or a second tab) re-attaches mid-turn
 * exactly where it left off.
 *
 * Stopping is now an explicit act (`abortTurn` via POST /api/chat/stop) — a
 * client disconnect no longer aborts the provider call.
 *
 * In-memory by design — OPNinfer is single-instance (see CLAUDE.md
 * "Concurrency & multi-user scale"); scaling out would externalise this
 * alongside the model cache. Anchored on globalThis because Next instantiates
 * modules once PER ROUTE BUNDLE — the chat, stream, and stop routes must see
 * the SAME map (the exact bug the interject mailboxes hit).
 */

export interface TurnEvent {
  type: string;
  [key: string]: unknown;
}

export interface TurnStream {
  conversationId: string;
  /** Every event published so far, in order — the replay buffer. */
  events: TurnEvent[];
  ended: boolean;
  /** Aborting THIS (not the request signal) cancels the provider call. */
  abort: AbortController;
  startedAt: number;
  subscribers: Set<{ onEvent: (ev: TurnEvent) => void; onEnd: () => void }>;
  /** The per-turn hard stop (see armTurnHardStop) — owned here rather than
   *  as a local timer in the route so a long-running tool can extend it. */
  hardStop?: ReturnType<typeof setTimeout>;
  /** Epoch ms the hard stop is currently set to fire. */
  deadlineAt?: number;
  /** The deadline before an agent run stretched it (restored on snap-back). */
  baseDeadlineAt?: number;
}

/** How long a finished turn stays resumable. Covers the race where the page
 *  loads its messages just before the reply is saved, then the resume request
 *  arrives just after the turn ended — the replay (ending in `done`) still
 *  hands the client the full reply. */
const GRACE_MS = 45_000;

const turns: Map<string, TurnStream> = ((
  globalThis as { __oiTurnStreams?: Map<string, TurnStream> }
).__oiTurnStreams ??= new Map());

/**
 * Register a new turn for the conversation. Returns null if one is already
 * RUNNING (the caller should 409 — one turn per conversation at a time). A
 * finished turn still in its grace window is replaced.
 */
export function startTurn(conversationId: string): TurnStream | null {
  const existing = turns.get(conversationId);
  if (existing && !existing.ended) return null;
  const turn: TurnStream = {
    conversationId,
    events: [],
    ended: false,
    abort: new AbortController(),
    startedAt: Date.now(),
    subscribers: new Set(),
  };
  turns.set(conversationId, turn);
  return turn;
}

/** The conversation's turn, if it's running or ended within the grace window. */
export function getTurn(conversationId: string): TurnStream | undefined {
  return turns.get(conversationId);
}

export function hasActiveTurn(conversationId: string): boolean {
  const t = turns.get(conversationId);
  return !!t && !t.ended;
}

/** How many replies are being generated right now, across all conversations.
 *  The deploy drain waits on this reaching zero before the container is
 *  replaced, so nobody is cut off mid-answer. */
export function activeTurnCount(): number {
  let n = 0;
  for (const t of turns.values()) if (!t.ended) n++;
  return n;
}

/** Buffer the event and fan it out to every attached subscriber. */
export function publishTurn(turn: TurnStream, event: TurnEvent): void {
  if (turn.ended) return;
  turn.events.push(event);
  for (const sub of turn.subscribers) {
    try {
      sub.onEvent(event);
    } catch {
      turn.subscribers.delete(sub);
    }
  }
}

/** Mark the turn finished: close every subscriber and start the grace timer
 *  after which the buffer is dropped (late resumes replay until then). */
export function endTurn(turn: TurnStream): void {
  if (turn.ended) return;
  turn.ended = true;
  for (const sub of turn.subscribers) {
    try {
      sub.onEnd();
    } catch {
      /* subscriber already gone */
    }
  }
  turn.subscribers.clear();
  const timer = setTimeout(() => {
    // Only delete our own entry — a newer turn may have replaced it.
    if (turns.get(turn.conversationId) === turn) turns.delete(turn.conversationId);
  }, GRACE_MS);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Attach: synchronously replay everything buffered so far, then follow live.
 * If the turn already ended, the replay still runs (grace window) and onEnd
 * fires immediately. Returns an unsubscribe function (detach only — never
 * affects generation).
 */
export function subscribeTurn(
  turn: TurnStream,
  onEvent: (ev: TurnEvent) => void,
  onEnd: () => void,
): () => void {
  for (const ev of turn.events) onEvent(ev);
  if (turn.ended) {
    onEnd();
    return () => {};
  }
  const sub = { onEvent, onEnd };
  turn.subscribers.add(sub);
  return () => turn.subscribers.delete(sub);
}

/**
 * Arm (or re-arm) the turn's hard stop: a hung provider must never leave the
 * conversation "active" forever, because every later POST would 409. The
 * pipeline has its own bounds; this is the backstop.
 */
export function armTurnHardStop(turn: TurnStream, ms: number): void {
  if (turn.hardStop) clearTimeout(turn.hardStop);
  turn.deadlineAt = Date.now() + ms;
  turn.hardStop = setTimeout(() => turn.abort.abort(), ms);
  (turn.hardStop as { unref?: () => void }).unref?.();
}

/**
 * Make sure the turn's hard stop is at least `ms` away — used by the Sandbox
 * agent tool, whose runs can legitimately outlast the default 15 minutes
 * (owner decision, 2026-09-01: the turn stretches to the agent's own
 * admin-set budget while an agent is active, then snaps back). Never
 * SHORTENS a deadline. Returns false if no turn is running.
 */
export function extendTurnHardStop(conversationId: string, ms: number): boolean {
  const t = turns.get(conversationId);
  if (!t || t.ended) return false;
  const wanted = Date.now() + ms;
  if (t.deadlineAt !== undefined && t.deadlineAt >= wanted) return true;
  // Remember what the turn had BEFORE the stretch, so the snap-back can
  // give it back (audit 2026-09-05: a 20-second agent call at the start of
  // a 15-minute turn left the rest of the tool loop with five minutes).
  t.baseDeadlineAt ??= t.deadlineAt;
  armTurnHardStop(t, ms);
  return true;
}

/** Snap back after an agent run: `ms` from now, or whatever was left of the
 *  turn's ORIGINAL budget if that is longer — never shorter than either. */
export function resetTurnHardStop(conversationId: string, ms: number): void {
  const t = turns.get(conversationId);
  if (!t || t.ended) return;
  const remaining = t.baseDeadlineAt !== undefined ? t.baseDeadlineAt - Date.now() : 0;
  t.baseDeadlineAt = undefined;
  armTurnHardStop(t, Math.max(ms, remaining));
}

export function clearTurnHardStop(turn: TurnStream): void {
  if (turn.hardStop) clearTimeout(turn.hardStop);
  turn.hardStop = undefined;
  turn.deadlineAt = undefined;
}

/**
 * Abort a RUNNING turn (stop button, or a conversation delete racing a live
 * reply). The runner's provider call gets an AbortError, the pipeline winds
 * down, and the route saves whatever text was produced — same semantics the
 * old client-side fetch-abort had. Returns whether a running turn was hit.
 */
export function abortTurn(conversationId: string): boolean {
  const t = turns.get(conversationId);
  if (!t || t.ended) return false;
  t.abort.abort();
  return true;
}

/**
 * Pipe a turn to an SSE Response. Used by both the originating POST and
 * resume GETs — each response is an independent subscriber; dropping it
 * (client gone) only unsubscribes.
 */
export function turnStreamResponse(turn: TurnStream, reqSignal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Assigned below — but `close` can fire DURING subscribeTurn (an
      // already-ended turn calls onEnd synchronously), so default to a no-op.
      let unsub: () => void = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      unsub = subscribeTurn(
        turn,
        (ev) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
          } catch {
            close(); // this response's client went away — detach only
          }
        },
        close,
      );
      reqSignal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
