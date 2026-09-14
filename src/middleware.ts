import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { IS_CONSOLE } from "@/lib/mode";

const { auth } = NextAuth(authConfig);

/**
 * Route protection (edge). Public routes are the auth flows; everything else
 * requires a session, and `/admin` additionally requires the admin role. The
 * "is this the first user?" gate for `/setup` is enforced in that page itself
 * (it needs DB access, which can't run here).
 *
 * This file also SEPARATES THE TWO MODES the image can run in (see
 * `lib/mode.ts`). A portal never serves the operator console, and the console
 * — which has no database of its own — never serves a portal route: both are
 * a flat 404 rather than a redirect, because there is nothing at that address
 * on that container and pretending otherwise just moves the confusion.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/setup",
  "/invite",
  "/forgot-password",
  "/reset-password",
];

/** Where someone on an admin-set password is held until they choose their own. */
const CHANGE_PASSWORD = "/change-password";

/** Everything the console container serves. */
const CONSOLE_PREFIXES = ["/console", "/api/console"];

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

export default auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = !!req.auth;
  const path = nextUrl.pathname;

  const isConsolePath = matches(path, CONSOLE_PREFIXES);

  if (IS_CONSOLE) {
    // Only the console, its API and the sign-in screen exist here. `/` is
    // allowed through so the root page can forward to /console.
    if (path !== "/" && !isConsolePath && path !== "/login") {
      return new NextResponse(null, { status: 404 });
    }
    if (path === "/login") {
      return isLoggedIn ? NextResponse.redirect(new URL("/console", nextUrl)) : NextResponse.next();
    }
    if (!isLoggedIn) {
      const loginUrl = new URL("/login", nextUrl);
      loginUrl.searchParams.set("callbackUrl", path);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // A portal: the console's pages are not part of this product.
  if (isConsolePath) return new NextResponse(null, { status: 404 });

  const isPublic = matches(path, PUBLIC_PREFIXES);

  // Signed-in users shouldn't see the login/setup screens.
  if (isLoggedIn && (path === "/login" || path === "/setup")) {
    return NextResponse.redirect(new URL("/", nextUrl));
  }

  // Signed in on a password somebody else chose: nothing but the change
  // screen, until they pick their own. The flag rides the session token
  // because middleware runs at the edge and cannot read the database; it is
  // re-read by the 60-second recheck in auth.ts, so setting a temporary
  // password lands on an already-open session within the minute, and
  // clearing it releases them just as fast.
  if (isLoggedIn && req.auth?.user?.mustChangePassword && path !== CHANGE_PASSWORD) {
    return NextResponse.redirect(new URL(CHANGE_PASSWORD, nextUrl));
  }
  // …and nobody else has any business there.
  if (path === CHANGE_PASSWORD && isLoggedIn && !req.auth?.user?.mustChangePassword) {
    return NextResponse.next();
  }

  if (isPublic) return NextResponse.next();

  if (!isLoggedIn) {
    const loginUrl = new URL("/login", nextUrl);
    loginUrl.searchParams.set("callbackUrl", path);
    return NextResponse.redirect(loginUrl);
  }

  // Admin-only area.
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (req.auth?.user?.role !== "admin") {
      return NextResponse.redirect(new URL("/", nextUrl));
    }
  }

  return NextResponse.next();
});

export const config = {
  // Run on everything except Next internals, the auth API, and static assets.
  // `api/admin/import` is also excluded: middleware CLONES request bodies
  // (capped by middlewareClientMaxBodySize), which would truncate the
  // hundreds-of-MB OWUI database upload — that route does its own strict
  // admin check instead.
  // `api/admin/backup/restore` for the same body-cloning reason: a real backup
  // is far bigger than the clone cap, so a matched restore upload arrived
  // truncated and the admin was told their archive was corrupt — on the one day
  // it mattered. It streams the upload and does its own strict admin check.
  // `api/admin/drain` likewise: deploy.sh calls it from the host with a bearer
  // token and no session, so middleware would redirect it to /login.
  // `api/agent-proxy` for the same reason: the caller is the Sandbox agent's
  // container, authenticated by a per-run bearer token, never a session.
  // `manifest.webmanifest`, `sw.js` and `api/pwa` are the installable-app
  // (PWA) assets, and all three MUST be public: a browser fetches a manifest
  // and its icons with credentials OMITTED, so behind this middleware it would
  // store the login page's HTML as the manifest and the install would silently
  // offer nothing. They carry the logo and assistant name the login screen
  // already shows to anyone — pinned by src/lib/pwa.test.ts.
  matcher: [
    "/((?!api/auth|api/branding|api/pwa|api/admin/import|api/admin/backup/restore|api/admin/drain|api/admin/agent-credential|api/agent-proxy|_next/static|_next/image|favicon.ico|icon.svg|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
