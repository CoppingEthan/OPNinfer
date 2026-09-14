import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { authConfig } from "./auth.config";
import { db } from "./lib/db";
import { verifyPassword } from "./lib/hash";
import { appLog } from "./lib/applog";
import {
  clearLoginFailures,
  loginBlockedMs,
  loginKey,
  recordLoginFailure,
} from "./lib/login-guard";
import { IS_CONSOLE } from "./lib/mode";
import { authorizeOperator } from "./lib/console/auth";
import type { Role } from "@prisma/client";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * How long a session may run on the role/disabled state captured at sign-in.
 *
 * Sessions last 7 days, and the claims baked in at sign-in used to be the ONLY
 * thing consulted for the whole of that: disabling a leaver in Admin → Users
 * ended their ability to sign in again but left the tab they already had open
 * fully working, and demoting an admin left their `role: "admin"` claim intact
 * — so they kept the provider keys, the backups (which contain every
 * conversation), the OWUI import, and the chat viewer. Deleting the account
 * changed nothing either.
 *
 * One indexed lookup a minute, per active session, closes that. It is cheap
 * next to the model calls this app makes.
 */
const SESSION_RECHECK_MS = 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // NB this override lives here, not in auth.config.ts: that file is compiled
    // for the edge runtime (middleware) and must not import Prisma. Middleware
    // therefore still routes on the cached claim — which is fine, because every
    // admin page, route and action re-checks through `auth()` from THIS file,
    // and the token is re-signed with the fresh role as soon as it does.
    async jwt(params) {
      const { token, user } = params;
      if (user) {
        const u = user as { id: string; role: Role; pwv?: number; mustChangePassword?: boolean };
        token.id = u.id;
        token.role = u.role;
        token.pwv = u.pwv ?? 0;
        token.mustChangePassword = !!u.mustChangePassword;
        token.checkedAt = Date.now();
        return token;
      }

      // The console has no users table to re-check against: its accounts live
      // in its env file, so the only way one changes is a redeploy, which ends
      // every session anyway. Nothing to look up, and no database to look it
      // up in.
      if (IS_CONSOLE) return token;

      const checkedAt = typeof token.checkedAt === "number" ? token.checkedAt : 0;
      if (Date.now() - checkedAt < SESSION_RECHECK_MS) return token;

      const id = typeof token.id === "string" ? token.id : null;
      if (!id) return null;
      try {
        const row = await db.user.findUnique({
          where: { id },
          select: {
            role: true,
            disabled: true,
            passwordChangedAt: true,
            mustChangePassword: true,
          },
        });
        // Gone or disabled → the session ends here, mid-flight. So does a
        // session issued before the password last changed (audit 2026-09-05):
        // a reset is the natural response to a stolen session, and used to
        // leave the thief signed in for the token's remaining days.
        if (!row || row.disabled) return null;
        const pwv = typeof token.pwv === "number" ? token.pwv : 0;
        if (row.passwordChangedAt && row.passwordChangedAt.getTime() > pwv) return null;
        token.role = row.role;
        // Re-read, not just carried: an admin setting a temporary password
        // must take hold on a session that is ALREADY open, and clearing it
        // after the person picks their own must release them just as quickly.
        token.mustChangePassword = row.mustChangePassword;
        token.checkedAt = Date.now();
      } catch {
        // A database blip must not sign everybody out. Keep the cached claims
        // and try again on the next request.
      }
      return token;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase().trim();

        // Refuse before touching argon2: a guesser must not be able to spend
        // our CPU and ~19 MiB of RAM per attempt while they wait.
        // Bucketed per account AND client address (audit 2026-09-05): on the
        // email alone, anyone who knew a colleague's address could keep them
        // locked out with one wrong password every fourteen minutes. The
        // reverse proxy sets X-Forwarded-For; without it (dev) it is per email.
        const forwarded = request?.headers?.get?.("x-forwarded-for") ?? null;
        const clientIp = forwarded ? forwarded.split(",")[0]?.trim() : null;
        const key = loginKey(email, clientIp);
        const waitMs = loginBlockedMs(key);
        if (waitMs > 0) {
          if (IS_CONSOLE) {
            console.warn(
              `[console] sign-in refused for ${email} — retry in ${Math.ceil(waitMs / 1000)}s`,
            );
          } else {
            void appLog("warn", "auth", "Sign-in refused — too many failed attempts.", {
              details: { email, retryInSeconds: Math.ceil(waitMs / 1000) },
            }).catch(() => {});
          }
          return null;
        }

        // Operator console: no users table, no `appLog` to write to. Same
        // backoff, same argon2 verification, accounts from the env file.
        if (IS_CONSOLE) {
          const operator = await authorizeOperator(email, parsed.data.password);
          if (!operator) {
            const wait = recordLoginFailure(key);
            console.warn(
              `[console] failed sign-in for ${email} — backing off ${Math.round(wait / 1000)}s`,
            );
            return null;
          }
          clearLoginFailures(key);
          return operator;
        }

        const user = await db.user.findUnique({ where: { email } });

        // Reject unknown, disabled, or unverified accounts. Email verification
        // blocks login until complete (spec §5); admins can verify manually.
        // Counted as a failure too — otherwise enumerating addresses is free.
        if (!user || user.disabled || !user.emailVerified) {
          const wait = recordLoginFailure(key);
          void appLog("warn", "auth", "Failed sign-in.", {
            details: {
              email,
              reason: !user ? "unknown account" : user.disabled ? "disabled" : "unverified",
              backoffSeconds: Math.round(wait / 1000),
            },
          }).catch(() => {});
          return null;
        }

        const ok = await verifyPassword(user.passwordHash, parsed.data.password);
        if (!ok) {
          const wait = recordLoginFailure(key);
          // Logged so a grind is VISIBLE — in Admin → Logs, in the error-alert
          // mail when it escalates, and in the weekly report. Never the password.
          void appLog("warn", "auth", "Failed sign-in.", {
            userId: user.id,
            details: { email, reason: "wrong password", backoffSeconds: Math.round(wait / 1000) },
          }).catch(() => {});
          return null;
        }
        clearLoginFailures(key);

        // Record sign-in as activity for the admin Users page (fire-and-forget).
        // `lastSignInAt` goes with it (2026-09-09) and is the load-bearing
        // half: `lastActiveAt` is carried across by the OWUI importer, so on a
        // migrated portal it cannot tell "signed in here" from "existed
        // somewhere else last year". This one is written ONLY here, so NULL
        // means the password has never worked on this portal — which is what
        // lets a failed sign-in safely offer a temporary one (lib/recovery.ts).
        void db.user
          .update({
            where: { id: user.id },
            data: { lastActiveAt: new Date(), lastSignInAt: new Date() },
          })
          .catch(() => {});

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          // Password version: the recheck signs this session out the moment a
          // later password change is recorded (see the schema note).
          pwv: user.passwordChangedAt?.getTime() ?? 0,
          // Signed in with a password an admin set: they get no further than
          // the change-password screen until they choose their own.
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
});
