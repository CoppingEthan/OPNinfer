import "server-only";
import { fanOut } from "./db";
import { classifyReset, type ResetState } from "./reset-watch";

/**
 * Everyone with an account on any portal, in one table.
 *
 * The per-portal Admin → Users page answers "who is on THIS portal"; this
 * answers the questions that only exist above it — who has actually started
 * using the thing since a migration, which client's people are quiet, and who
 * the heavy users are across the estate.
 *
 * NOTE ON `lastActiveAt`: it is only bumped on a real sign-in here, but the
 * Open WebUI importer carries OWUI's own value across for migrated accounts.
 * So a date older than the portal's cutover is history, not a sign-in — which
 * is why `passwordChangedAt` is shown beside it: it is stamped only by a
 * RESET (self-service or admin), never by accepting an invite, so after a
 * migration it is the unambiguous "this person has arrived" signal. On a
 * portal that was never migrated it means nothing much, which is why the UI
 * shows it plainly rather than flagging a missing one.
 *
 * It also answers the owner's question of 2026-09-09 — "who did the reset and
 * never recovered their account?" — because that is the one thing here that
 * points at a cause rather than a symptom: a link we sent, that expired
 * unused, is the clearest sign the email never reached them. See
 * `reset-watch.ts` for the rule.
 */

export interface ConsolePerson {
  portal: string;
  portalLabel: string;
  email: string;
  name: string | null;
  role: string;
  disabled: boolean;
  verified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  passwordChangedAt: string | null;
  /** Where this person stands with a password-reset link, if they asked. */
  reset: ResetState;
  /** When they last asked, for the "asked 3 days ago" line. */
  resetAskedAt: string | null;
  chats: number;
  requests: number;
  inTokens: number;
  outTokens: number;
  cost: number;
}

export async function getPeople(): Promise<{
  people: ConsolePerson[];
  errors: { portal: string; error: string }[];
}> {
  const results = await fanOut(async (db, instance) => {
    const [users, usage, chats, pending] = await Promise.all([
      db.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          disabled: true,
          emailVerified: true,
          createdAt: true,
          lastActiveAt: true,
          passwordChangedAt: true,
        },
      }),
      db.usageRecord.groupBy({
        by: ["userId"],
        _sum: { inputTokens: true, outputTokens: true, costEstimate: true },
        _count: true,
      }),
      db.conversation.groupBy({ by: ["userId"], _count: true }),
      // The newest link a person never used. `requestPasswordReset` deletes a
      // user's earlier unused rows before creating one, so there is at most
      // one per person and it is always their latest ask.
      db.passwordResetToken.findMany({
        where: { usedAt: null },
        select: { userId: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const usageBy = new Map(usage.map((u) => [u.userId ?? "", u]));
    const chatsBy = new Map(chats.map((c) => [c.userId, c._count]));
    // Newest first above, so the first row wins if a portal ever holds more
    // than one (it should not, but a page must not depend on that).
    const pendingBy = new Map<string, { requestedAt: string; expiresAt: string }>();
    for (const t of pending) {
      if (!pendingBy.has(t.userId)) {
        pendingBy.set(t.userId, {
          requestedAt: t.createdAt.toISOString(),
          expiresAt: t.expiresAt.toISOString(),
        });
      }
    }

    return users.map((u): ConsolePerson => {
      const g = usageBy.get(u.id);
      const p = pendingBy.get(u.id) ?? null;
      return {
        portal: instance.name,
        portalLabel: instance.label,
        email: u.email,
        name: u.name,
        role: u.role,
        disabled: u.disabled,
        verified: !!u.emailVerified,
        createdAt: u.createdAt.toISOString(),
        lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
        passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
        reset: classifyReset({
          pending: p,
          passwordChangedAt: u.passwordChangedAt?.toISOString() ?? null,
        }),
        resetAskedAt: p?.requestedAt ?? null,
        chats: chatsBy.get(u.id) ?? 0,
        requests: g?._count ?? 0,
        inTokens: g?._sum.inputTokens ?? 0,
        outTokens: g?._sum.outputTokens ?? 0,
        cost: Number(g?._sum.costEstimate ?? 0),
      };
    });
  });

  return {
    people: results.flatMap((r) => r.data ?? []).sort((a, b) => b.cost - a.cost),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}
