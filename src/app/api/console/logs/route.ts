import { refuseNonOperator } from "@/lib/console/guard";
import { getChatLog, getLogs, type LogLevelFilter } from "@/lib/console/logs";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/logs?view=raw|chats&level=… — the merged application log.
 *
 * Polled rather than streamed: a portal serves its own log over SSE, but four
 * of those held open into four client databases for the life of a dashboard
 * tab is a lot of standing cost for something refreshed every few seconds.
 */
export async function GET(req: Request) {
  const refusal = await refuseNonOperator();
  if (refusal) return refusal;

  const params = new URL(req.url).searchParams;
  if (params.get("view") === "chats") return Response.json(await getChatLog());

  const raw = params.get("level");
  const level: LogLevelFilter =
    raw === "info" || raw === "warn" || raw === "error" ? raw : "all";
  return Response.json(await getLogs(level));
}
