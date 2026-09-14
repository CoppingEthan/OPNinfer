import "server-only";
import { verifyPassword } from "@/lib/hash";
import { configuredOperators, operatorId } from "./operators";

/**
 * Signing in to the operator console.
 *
 * Same argon2id verification the portals use, against the accounts in the
 * console's env file rather than a users table (see `operators.ts` for why
 * there is no table). Everything else about the session is unchanged: the
 * Auth.js JWT strategy needs no storage, and the cookies are already
 * namespaced per instance — the console runs as `OPNINFER_INSTANCE=console`,
 * so holding it open alongside four portals on one host just works.
 *
 * There is no sign-up, no reset and no invite here, by design: the only way an
 * account exists is `./deploy.sh console-password`, run on the host by someone
 * who already has shell access to every portal's database.
 */

export interface OperatorSession {
  id: string;
  email: string;
  role: "admin";
}

/**
 * Verify a console sign-in.
 *
 * Returns null for every failure — unknown address and wrong password alike,
 * and with the same work done in both cases where it matters: an unknown
 * address still costs the caller the round trip, and the rate limiting that
 * actually protects this lives in the shared login guard at the call site.
 */
export async function authorizeOperator(
  email: string,
  password: string,
): Promise<OperatorSession | null> {
  const wanted = email.toLowerCase().trim();
  const operator = configuredOperators().find((o) => o.email === wanted);
  if (!operator) return null;
  if (!(await verifyPassword(operator.hash, password))) return null;
  return { id: operatorId(operator.email), email: operator.email, role: "admin" };
}

/** True when at least one operator account is configured. */
export function consoleHasOperators(): boolean {
  return configuredOperators().length > 0;
}
