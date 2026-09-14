import { timingSafeEqual } from "node:crypto";
import { agentTokenSource } from "@/lib/agent/env";

/**
 * "Which subscription credential will this instance actually use?" — for
 * `deploy.sh agent-token`, not for a browser.
 *
 * It exists because of the console's operator-account bug (2026-09-07): that
 * setup confirmed the file had been written, and then confirmed the value had
 * reached the container, and was wrong BOTH times — the running image was
 * what did not understand it. The only honest confirmation is asking the
 * running app what it sees, which is what this returns:
 *
 *   { source: "token" }      a long-lived token, understood and in use
 *   { source: "malformed" }  something is configured but is not a token
 *   { source: "none" }       the container volume login (the original path)
 *
 * It reveals no secret — only which of three states the app is in — and is
 * bearer-authed by the same per-instance deploy token as the drain endpoint,
 * because the caller is a shell script with no cookie jar. With no token
 * configured it 404s, exactly like drain control.
 *
 * NB: excluded from the middleware matcher, or a session-less request would
 * be bounced to /login.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = process.env.OPNINFER_DEPLOY_TOKEN ?? "";
  if (!token) {
    return Response.json({ error: "Not configured." }, { status: 404 });
  }
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({ source: agentTokenSource() });
}
