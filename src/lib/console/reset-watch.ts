/**
 * "Who asked for a sign-in link and never got in?"
 *
 * Owner ask, 2026-09-09: clients email to say they cannot sign in, and the
 * suspicion — borne out by the first real reading of this — is that the reset
 * emails are being delivered to their mail system and filtered there. A person
 * who asks for a link and never uses it is the cleanest evidence of that we
 * have: they wanted in, we sent the email, and nothing happened.
 *
 * Pure so the rule can be argued with in a test rather than eyeballed on a
 * page. It rests on two facts about the reset flow:
 *
 *  - `requestPasswordReset` DELETES a user's earlier unused links before
 *    creating a new one, so there is at most ONE unused row per person —
 *    always the most recent ask. (Used ones are kept, which is how we know
 *    someone has ever completed one.)
 *  - completing a reset sets `usedAt` on the row AND `passwordChangedAt` on
 *    the user, so "asked but never arrived" is an unused row with no later
 *    password change.
 */

export type ResetState =
  /** No outstanding request. */
  | "none"
  /** Asked recently; the link is still live, so they may simply not have
   *  opened it yet. Not yet evidence of anything. */
  | "waiting"
  /** The link expired without ever being used, and the password was not
   *  changed by any other route. They asked for help and never got it. */
  | "stuck";

export interface ResetInput {
  /** The newest link that was never used, if any. */
  pending: { requestedAt: string; expiresAt: string } | null;
  /** When this account's password was last actually changed, if ever. */
  passwordChangedAt: string | null;
}

export function classifyReset(input: ResetInput, now: number = Date.now()): ResetState {
  const { pending } = input;
  if (!pending) return "none";

  const requested = Date.parse(pending.requestedAt);
  const expires = Date.parse(pending.expiresAt);
  if (!Number.isFinite(requested) || !Number.isFinite(expires)) return "none";

  // Got in another way after asking — an admin set them a password, or they
  // remembered it. Whatever happened, they are not waiting on us.
  const changed = input.passwordChangedAt ? Date.parse(input.passwordChangedAt) : NaN;
  if (Number.isFinite(changed) && changed >= requested) return "none";

  // Before the link expires, silence means nothing: people do not always read
  // their email within the hour. Only an EXPIRED unused link is evidence.
  return now >= expires ? "stuck" : "waiting";
}

/** How long ago they asked, for the page's "asked 3 days ago" line. */
export function askedAgo(requestedAt: string, now: number = Date.now()): number {
  const t = Date.parse(requestedAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}
