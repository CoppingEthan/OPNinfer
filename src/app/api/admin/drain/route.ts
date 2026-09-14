import { timingSafeEqual } from "node:crypto";
import { beginDrain, endDrain, isDraining, drainingSince } from "@/lib/drain";
import { activeTurnCount } from "@/lib/turn-stream";
import { appLog } from "@/lib/applog";

/**
 * Deploy drain control, for `deploy.sh` — not a browser endpoint.
 *
 *   GET    → { draining, activeTurns }        poll until activeTurns is 0
 *   POST   → start draining, returns status
 *   DELETE → stop draining (aborted deploy / manual all-clear)
 *
 * Authenticated by a per-instance bearer token (`OPNINFER_DEPLOY_TOKEN`)
 * rather than an admin session, because the caller is a shell script on the
 * host with no cookie jar. With no token configured the endpoint is off
 * entirely — it can't be left accidentally open, and an instance that has
 * never set one simply deploys the old (abrupt) way.
 *
 * NB: excluded from the middleware matcher, like the OWUI import route, since
 * middleware would bounce a session-less request to /login.
 */
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const token = process.env.OPNINFER_DEPLOY_TOKEN ?? "";
  if (!token) return false;
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function status() {
  return Response.json({
    draining: isDraining(),
    since: drainingSince(),
    activeTurns: activeTurnCount(),
  });
}

function guard(req: Request): Response | null {
  if (!process.env.OPNINFER_DEPLOY_TOKEN) {
    return Response.json({ error: "Drain control is not configured." }, { status: 404 });
  }
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: Request) {
  return guard(req) ?? status();
}

export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const first = !isDraining();
  beginDrain();
  if (first) {
    await appLog("info", "deploy", "Draining for an update — new turns and uploads refused.", {
      details: { activeTurns: activeTurnCount() },
    });
  }
  return status();
}

export async function DELETE(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const was = isDraining();
  endDrain();
  if (was) await appLog("info", "deploy", "Drain cancelled — accepting traffic again.");
  return status();
}
