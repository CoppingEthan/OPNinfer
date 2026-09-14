/**
 * The ONE order a conversation's messages are read in — for the model, the
 * chat screen, the admin viewer, exports, feedback snapshots and the memory
 * pass alike.
 *
 * Why this exists (2026-09-10): chats imported from Open WebUI stamp a
 * question and its answer with the SAME second, and `ORDER BY created_at`
 * alone leaves Postgres to break the tie however its sort happens to. On a
 * table whose physical order is no longer time order — every portal, after
 * enough page reuse — that is a real quicksort, which put the answer before
 * the question in half of one chat's 74 tied pairs, and put a DIFFERENT half
 * first on every turn. The model read a differently shuffled history each
 * time, so the prompt cache could never match and the whole 525k-token chat
 * was re-written at premium rates on every message (US$2 a message). The
 * user saw the same shuffle on screen.
 *
 * Pure and client-safe. Deterministic for any input order, on any database,
 * under any query plan: time, then user before assistant (a reply never
 * precedes its question), then id.
 */

const ROLE_RANK: Record<string, number> = {
  user: 0,
  assistant: 1,
  system: 2,
  tool_call: 3,
  tool_result: 4,
};

function millis(at: Date | string): number {
  return at instanceof Date ? at.getTime() : Date.parse(at);
}

export function orderThreadRows<
  T extends { id: string; role: string; createdAt: Date | string },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = millis(a.createdAt);
    const tb = millis(b.createdAt);
    if (ta !== tb) return ta - tb;
    const ra = ROLE_RANK[a.role] ?? 9;
    const rb = ROLE_RANK[b.role] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Make a run of timestamps strictly increasing by nudging any repeat forward
 * a millisecond at a time. For writers (the OWUI importer) so no new tie is
 * ever stored — the sort above then has nothing to break. Whole-second source
 * clocks make the nudge invisible to anyone.
 */
export function strictlyIncreasing(times: readonly Date[]): Date[] {
  const out: Date[] = [];
  let prev = Number.NEGATIVE_INFINITY;
  for (const t of times) {
    const ms = t.getTime() <= prev ? prev + 1 : t.getTime();
    out.push(new Date(ms));
    prev = ms;
  }
  return out;
}
