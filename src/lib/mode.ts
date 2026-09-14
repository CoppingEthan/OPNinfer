/**
 * Which ROLE this container plays.
 *
 * The same image runs two ways:
 *   - a PORTAL   (the default) — one client's chat instance, with its own
 *     database, storage and users;
 *   - the CONSOLE (`OPNINFER_MODE=console`) — the operator's read-only
 *     overview across every portal on the host, on its own port.
 *
 * One image rather than two projects: the console reuses this app's build,
 * auth, charts and UI kit wholesale, so a release ships both halves together
 * and there is no second compile to pay for on every deploy.
 *
 * Deliberately dependency-free and env-only, because MIDDLEWARE imports it:
 * that file is compiled for the edge runtime and must not reach Prisma or
 * anything Node-only. Reading runtime env there is the same thing
 * `auth.config.ts` already does for `OPNINFER_INSTANCE` (and Auth.js itself
 * does for `AUTH_SECRET`).
 */
export const IS_CONSOLE = process.env.OPNINFER_MODE === "console";

/** Human name for the mode, for logs and error text. */
export function modeName(): "console" | "portal" {
  return IS_CONSOLE ? "console" : "portal";
}
