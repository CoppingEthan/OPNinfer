/**
 * Failed-sign-in throttling.
 *
 * The portals sit on the public internet behind the owner's reverse proxy, and
 * the front door had nothing at all: no per-account lockout, no backoff, and —
 * worse for noticing it — no log line, audit row or alert on a failed attempt.
 * Someone could grind a staff email against a password list indefinitely and
 * leave no trace anywhere an admin looks. Each attempt also allocates ~19 MiB
 * for argon2, so a few hundred concurrent guesses is a cheap memory squeeze on
 * a 6.7 GB VM running four portals.
 *
 * Escalating backoff rather than a hard lock: a real person who has forgotten
 * their password should not be shut out for the day, but a script should slow
 * to uselessness. In-process by design, like the sudo gate — a restart clears
 * it, and each portal is a single process. Per-IP limiting belongs at the
 * reverse proxy, which is the only thing that sees the real client address.
 */

/** Failures before any delay applies — room for ordinary human fumbling. */
export const FREE_ATTEMPTS = 4;
/** Ceiling on the backoff, so a locked-out user is never stuck for long. */
export const MAX_LOCKOUT_MS = 15 * 60_000;
/** Forget a quiet account's history after this long. */
const FORGET_MS = 60 * 60_000;

interface Entry {
  count: number;
  /** When the current backoff expires (0 = not backing off). */
  until: number;
  /** Last failure, for pruning. */
  at: number;
}

// globalThis-anchored (audit 2026-09-05): `authorize` runs from the login
// page's server-action bundle AND from /api/auth/[...nextauth]; in dev those
// are separate module instances, so a script posting straight to the API
// route never moved the page's counter.
const attempts: Map<string, Entry> = ((globalThis as { __oiLoginGuard?: Map<string, Entry> }).__oiLoginGuard ??=
  new Map());
/** Hard cap on tracked buckets — an email spray must not grow this unbounded
 *  inside the hour `prune` waits for. Oldest insertions go first. */
const MAX_TRACKED = 5_000;

/**
 * Normalise an identifier so "A@B.com " and "a@b.com" share a bucket. With a
 * client address the bucket is per address AND account (audit 2026-09-05):
 * keyed on the email alone, anyone who knew a colleague's address could keep
 * them locked out for good with one wrong password every fourteen minutes.
 * The reverse proxy supplies the address; with none (dev, direct) it is the
 * email alone, as before.
 */
export function loginKey(email: string, clientIp?: string | null): string {
  const e = email.trim().toLowerCase();
  const ip = (clientIp ?? "").trim();
  return ip ? `${e}|${ip}` : e;
}

/** How long the delay after `n` total failures. Doubles, then flattens. */
export function backoffMs(count: number): number {
  if (count <= FREE_ATTEMPTS) return 0;
  const step = count - FREE_ATTEMPTS; // 1, 2, 3, …
  return Math.min(MAX_LOCKOUT_MS, 2 ** (step - 1) * 30_000);
}

function prune(now: number): void {
  if (attempts.size < 500) return;
  for (const [k, e] of attempts) {
    if (now - e.at > FORGET_MS) attempts.delete(k);
  }
  // Still too many (a spray within the hour): drop the oldest fifth.
  if (attempts.size > MAX_TRACKED) {
    let toDrop = Math.ceil(attempts.size / 5);
    for (const k of attempts.keys()) {
      if (toDrop-- <= 0) break;
      attempts.delete(k);
    }
  }
}

/** Milliseconds the caller must wait, or 0 if they may try now. */
export function loginBlockedMs(key: string, now: number = Date.now()): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  return entry.until > now ? entry.until - now : 0;
}

/** Record a failure and return the delay now in force. */
export function recordLoginFailure(key: string, now: number = Date.now()): number {
  const entry = attempts.get(key);
  // A backoff that has already elapsed does not reset the count — the whole
  // point is that a persistent guesser keeps slowing down — but the history is
  // forgotten entirely after an hour of quiet (see `prune`, and the explicit
  // forget below for a single stale entry).
  const stale = !!entry && now - entry.at > FORGET_MS;
  const count = stale || !entry ? 1 : entry.count + 1;
  const wait = backoffMs(count);
  attempts.set(key, { count, until: now + wait, at: now });
  prune(now);
  return wait;
}

/** A successful sign-in wipes the slate. */
/** How many consecutive failures are on record. Read-only — the login screen
 *  needs the number to decide whether to offer a recovery password, and must
 *  not bump it by asking. */
export function loginFailureCount(key: string, now: number = Date.now()): number {
  const e = attempts.get(key);
  if (!e) return 0;
  // Same forgetting rule the guard itself uses, so a count never outlives
  // the backoff it belongs to.
  return now - e.at > FORGET_MS ? 0 : e.count;
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/** Test seam. */
export function resetLoginGuard(): void {
  attempts.clear();
}
