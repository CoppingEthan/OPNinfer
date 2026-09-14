/**
 * The waiting half of `ask_user`: a running turn parks here until the user
 * answers its question card.
 *
 * Sibling to `interject.ts`, with one difference that shapes everything: an
 * interjection is fire-and-forget (offer it, the tool loop picks it up between
 * rounds), whereas an ask is a REQUEST/RESPONSE — the tool holds a promise open
 * mid-execution and the answer route resolves it, so the reply continues in the
 * same turn instead of ending and starting a new one.
 *
 * Anchored on globalThis for the same hard-won reason as the interjection
 * mailboxes and the turn registry: Next instantiates a module once PER ROUTE
 * BUNDLE, so the chat route and the answer route would otherwise hold separate
 * maps and every answer would miss.
 *
 * In-memory by design (single-instance — see CLAUDE.md "Concurrency &
 * multi-user scale"). A restart drops pending asks, which is correct: the turn
 * they belonged to died with it.
 */

import type { AskAnswer, AskBy, AskQuestion } from "./ask";

/** How the wait finished. `answers` (and who gave them) only accompany
 *  "answered". */
export type AskSettlement =
  | { status: "answered"; answers: AskAnswer[]; by?: AskBy }
  | { status: "dismissed" }
  | { status: "expired" };

interface PendingAsk {
  id: string;
  questions: AskQuestion[];
  settle: (result: AskSettlement) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long a question waits before the turn gives up and answers with a
 * default. Deliberately well under the 15-minute per-turn hard stop, so an
 * ignored card produces a graceful reply rather than a killed turn — a user
 * who wandered off should come back to an answer, not a dead stream.
 */
export const ASK_TIMEOUT_MS = 5 * 60_000;

const pending: Map<string, PendingAsk> = ((
  globalThis as { __oiPendingAsks?: Map<string, PendingAsk> }
).__oiPendingAsks ??= new Map());

/**
 * Park the turn on a question. Resolves when the user answers, when the turn is
 * dismissed or aborted, or when the wait runs out — never rejects, so the tool
 * always has something to tell the model.
 *
 * `signal` is the TURN's abort signal and is not optional in spirit: pressing
 * Stop aborts the provider call, but this wait is an ordinary promise that knows
 * nothing about it, so without the signal a stopped turn would sit on an
 * unanswerable card until the timeout instead of winding down immediately.
 *
 * One ask per conversation: a turn is single at a time, and a second card would
 * leave the first unanswerable, so any existing ask is dismissed first.
 */
export function openAsk(
  conversationId: string,
  id: string,
  questions: AskQuestion[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AskSettlement> {
  dismissAsk(conversationId);
  return new Promise<AskSettlement>((resolve) => {
    let done = false;
    const onAbort = () => settle({ status: "dismissed" });
    const settle = (result: AskSettlement) => {
      if (done) return;
      done = true;
      const entry = pending.get(conversationId);
      if (entry?.id === id) pending.delete(conversationId);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ status: "expired" }),
      opts.timeoutMs ?? ASK_TIMEOUT_MS,
    );
    // Never hold the process open for an unanswered question.
    (timer as { unref?: () => void }).unref?.();
    pending.set(conversationId, { id, questions, settle, timer });
    // Already stopped between the model's call and this line.
    if (opts.signal?.aborted) settle({ status: "dismissed" });
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The question currently on screen for this conversation, if any — lets the
 *  answer route validate the submission against what was actually asked. */
export function peekAsk(
  conversationId: string,
): { id: string; questions: AskQuestion[] } | null {
  const entry = pending.get(conversationId);
  return entry ? { id: entry.id, questions: entry.questions } : null;
}

/** Deliver the user's answers. False → nothing is waiting (the turn ended, the
 *  card is stale, or the id doesn't match), and the caller should say so
 *  instead of silently succeeding. */
export function settleAsk(
  conversationId: string,
  id: string,
  answers: AskAnswer[],
  by?: AskBy,
): boolean {
  const entry = pending.get(conversationId);
  if (!entry || entry.id !== id) return false;
  entry.settle({ status: "answered", answers, ...(by ? { by } : {}) });
  return true;
}

/** Abandon any pending ask — the turn was stopped, or ended without one. Safe
 *  to call unconditionally; the chat route does exactly that in its finally
 *  block, beside closing the interjection mailbox. */
export function dismissAsk(conversationId: string): void {
  pending.get(conversationId)?.settle({ status: "dismissed" });
}
