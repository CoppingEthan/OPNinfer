import type { NextAuthConfig } from "next-auth";
import type { Role } from "@prisma/client";

/**
 * Edge-safe Auth.js config. This file must NOT import node-only code (Prisma,
 * argon2) so it can run in middleware. The Credentials provider's `authorize`
 * (which needs the DB) is added in `auth.ts`, not here.
 */
/**
 * Cookie names are NAMESPACED PER INSTANCE (2026-09-05).
 *
 * Cookies are scoped by host and ignore the PORT, so several portals reached
 * on one address — `<host>:3002`, `:3003`, `:3004` while their DNS still
 * points elsewhere — shared a single jar under the default Auth.js names.
 * Signing into one overwrote the session (and the CSRF token) of the last,
 * so you could never be signed into more than one at a time. Their own
 * domains keep them apart in production, but an operator running four
 * portals should not have to rely on that.
 *
 * `OPNINFER_INSTANCE` reaches the app through its instance env file, and
 * this config is also what MIDDLEWARE runs, so both halves derive the same
 * name — a mismatch would look like being signed out on every request.
 * Runtime env is readable there: Auth.js already reads AUTH_SECRET this way.
 *
 * Secure-ness follows AUTH_URL rather than Auth.js's own default, because we
 * are now naming the cookies ourselves: `https://` gets the `__Secure-` /
 * `__Host-` prefixes and the Secure flag, plain http (LAN setup, dev) does
 * not — a Secure cookie over http is silently dropped.
 *
 * Changing these names signs everyone out ONCE, on the deploy that ships it.
 */
const INSTANCE =
  (process.env.OPNINFER_INSTANCE || "default")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32) || "default";
const SECURE = (process.env.AUTH_URL ?? "").startsWith("https://");
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: SECURE,
} as const;

export const authConfig = {
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  cookies: {
    sessionToken: {
      name: `${SECURE ? "__Secure-" : ""}authjs.session-token.${INSTANCE}`,
      options: cookieOptions,
    },
    callbackUrl: {
      name: `${SECURE ? "__Secure-" : ""}authjs.callback-url.${INSTANCE}`,
      options: cookieOptions,
    },
    csrfToken: {
      // `__Host-` demands Secure + Path=/ + no Domain, which is what we set.
      name: `${SECURE ? "__Host-" : ""}authjs.csrf-token.${INSTANCE}`,
      options: cookieOptions,
    },
  },
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days (spec §5)
  },
  callbacks: {
    // Persist id + role into the token at sign-in, then expose on the session.
    // `user` is typed `unknown` here because the edge config declares no
    // providers (the real one lives in auth.ts) — narrow it explicitly.
    jwt({ token, user }) {
      if (user) {
        const u = user as { id: string; role: Role; mustChangePassword?: boolean };
        token.id = u.id;
        token.role = u.role;
        token.mustChangePassword = !!u.mustChangePassword;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as Role;
        // Middleware runs at the edge with no database, so the "this password
        // was set for you" flag has to travel on the token itself.
        session.user.mustChangePassword = !!token.mustChangePassword;
      }
      return session;
    },
  },
  providers: [], // populated in auth.ts
} satisfies NextAuthConfig;
