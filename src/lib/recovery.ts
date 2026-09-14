/**
 * "You have never got in here — let us just give you a password."
 *
 * Owner ask, 2026-09-09: "clients keep emailing me saying I can't log in, when
 * they could just use the fucking reset button." The first design was a notice
 * telling them to press it; the owner's answer was better — send a TEMPORARY
 * PASSWORD, the same one Admin → Users issues, because a reset LINK expires in
 * an hour and every unused link on the estate had expired before anyone found
 * it in their quarantine folder. A password does not expire.
 *
 * THE ONE THING THAT MAKES THIS SAFE: it fires only for an account whose
 * password has NEVER worked here (`lastSignInAt` is null — see the column's
 * note in the schema). Issuing a temporary password REPLACES the existing one,
 * so doing it to somebody who merely mistyped theirs would take away a
 * password they were using. Checked against production before it shipped: of
 * the ~20 people who failed a sign-in in a fortnight, not one qualified —
 * they had all signed in successfully within days. This is a safety net for
 * the 25 accounts that arrived in a migration and have never once been used,
 * not a fix for everyday fumbling.
 *
 * Pure, so the rule can be argued with in a test rather than inferred from
 * behaviour. The throttle is in-process, like the login guard beside it: a
 * restart clears it, and each portal is a single process.
 */

/** Failed attempts before we offer anything. Below the guard's FREE_ATTEMPTS
 *  (4), so the offer arrives while they are still trying rather than after a
 *  backoff has already told them to go away. */
export const RECOVERY_AFTER_FAILURES = 3;

/** One automatic password per account per this long, however hard they try. */
export const RECOVERY_COOLDOWN_MS = 30 * 60_000;

export interface RecoveryCandidate {
  /** Consecutive failures recorded for this account right now. */
  failures: number;
  /** The account exists and can sign in at all. */
  exists: boolean;
  disabled: boolean;
  verified: boolean;
  /** Has a password EVER worked on this portal? Null means never. */
  lastSignInAt: Date | string | null;
}

/**
 * Should this failed sign-in be answered with a temporary password?
 *
 * Every clause is a way to get this wrong:
 *  - `exists` — never reveal, or act on, an address with no account.
 *  - `disabled` — a leaver must not be handed a working password.
 *  - `verified` — `authorize` refuses an unverified account before the
 *    password is even checked, so a password would be unusable.
 *  - `lastSignInAt` — the load-bearing one. See the note above.
 */
export function shouldIssueRecoveryPassword(c: RecoveryCandidate): boolean {
  if (!c.exists || c.disabled || !c.verified) return false;
  if (c.failures < RECOVERY_AFTER_FAILURES) return false;
  return c.lastSignInAt === null || c.lastSignInAt === undefined;
}

// --- throttle ---------------------------------------------------------------

const sent: Map<string, number> = ((
  globalThis as { __oiRecoverySent?: Map<string, number> }
).__oiRecoverySent ??= new Map());

/** Hard cap, like the login guard's: a spray must not grow this unbounded. */
const MAX_TRACKED = 5_000;

function key(email: string): string {
  return email.trim().toLowerCase();
}

/** True when this account may be sent one now (and records that it was). */
export function claimRecoverySend(email: string, now: number = Date.now()): boolean {
  const k = key(email);
  const last = sent.get(k);
  if (last !== undefined && now - last < RECOVERY_COOLDOWN_MS) return false;
  if (sent.size >= MAX_TRACKED) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = sent.keys().next();
    if (!oldest.done) sent.delete(oldest.value);
  }
  sent.set(k, now);
  return true;
}

/** Test seam. */
export function resetRecoveryThrottle(): void {
  sent.clear();
}
