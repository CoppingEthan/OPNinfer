/**
 * Deploy drain — "finish what you're doing, start nothing new".
 *
 * `deploy.sh` asks each instance to drain, waits briefly for in-flight replies
 * to land, and only then replaces the container. Without it, an update kills
 * every reply mid-sentence: the turn registry is in memory, so a restart takes
 * the running generations with it and users just see a dead stream.
 *
 * While draining, new turns and uploads are refused with a plain "we're
 * updating" notice; anything already running is left alone, and the endpoints
 * a running turn depends on (resume, stop, mid-turn steering) stay open.
 *
 * The flag is deliberately IN MEMORY, not a settings row: a container restart
 * must clear it. If a deploy dies halfway, the worst case is that the old
 * process keeps refusing new turns until it is replaced — and the replacement
 * comes up accepting traffic, with no stuck "maintenance mode" row to notice
 * and clear by hand. Anchored on globalThis because Next instantiates modules
 * once per route bundle (the same trap the interjection mailbox hit).
 */

interface DrainState {
  since: number | null;
}

const state: DrainState = ((globalThis as { __oiDrain?: DrainState }).__oiDrain ??= {
  since: null,
});

/** Message shown to users who try to start something during a deploy. */
export const DRAIN_MESSAGE =
  "The portal is updating right now — please try again in a couple of minutes.";

export function beginDrain(): void {
  if (state.since === null) state.since = Date.now();
}

/** Cancel a drain (a deploy that aborted, or a manual all-clear). */
export function endDrain(): void {
  state.since = null;
}

export function isDraining(): boolean {
  return state.since !== null;
}

export function drainingSince(): number | null {
  return state.since;
}

/** 503 body used by every route that refuses work while draining. The
 *  `maintenance` flag is what tells the client to show the calm "updating"
 *  notice instead of a red error. */
export function drainResponse(): Response {
  return Response.json(
    { error: DRAIN_MESSAGE, maintenance: true },
    { status: 503, headers: { "Retry-After": "120" } },
  );
}
