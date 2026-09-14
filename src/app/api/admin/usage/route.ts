import { auth } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Wrap a CSV field, escaping quotes and forcing text where needed. */
function field(value: unknown): string {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/** Rows fetched (and streamed) per batch. */
const BATCH = 2_000;

const HEADER = [
  "created_at",
  "user_email",
  "provider",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd",
];

/**
 * GET /api/admin/usage — the usage ledger as CSV (admin only, spec §9).
 *
 * STREAMED in keyset-paginated batches rather than built in memory. The ledger
 * is permanent by design (it outlives chats and accounts) and grows several
 * rows per turn, so `findMany()` with no bound, plus an array of formatted
 * strings, plus the joined copy, was an OOM waiting for the day an admin
 * clicked Export — in a single process that is concurrently streaming
 * everyone's replies.
 *
 * `?range=` (hour|day|week|month|year) narrows it the same way the dashboard
 * does; omitted means everything, which is now safe to ask for.
 */
const RANGE_MS: Record<string, number> = {
  hour: 3600_000,
  day: 864e5,
  week: 7 * 864e5,
  month: 30 * 864e5,
  year: 365 * 864e5,
};

export async function GET(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const range = new URL(req.url).searchParams.get("range") ?? "";
  const since = RANGE_MS[range] ? new Date(Date.now() - RANGE_MS[range]) : null;
  const where = since ? { createdAt: { gte: since } } : {};

  // Declared outside the loop so `rows` isn't inferred from a value derived
  // from itself (keyset pagination is circular to the type checker otherwise).
  const page = (after: string | null) =>
    db.usageRecord.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      include: { user: { select: { email: true } } },
    });

  const encoder = new TextEncoder();
  // One batch per `pull`, so the reader's backpressure actually applies: the
  // next page is only queried when the client has taken the previous one.
  let cursor: string | null = null;
  let wroteHeader = false;
  let exhausted = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!wroteHeader) {
        wroteHeader = true;
        controller.enqueue(encoder.encode(HEADER.map(field).join(",") + "\r\n"));
        return;
      }
      if (exhausted) {
        controller.close();
        return;
      }
      const rows = await page(cursor);
      if (rows.length === 0) {
        controller.close();
        return;
      }
      let chunk = "";
      for (const r of rows) {
        chunk +=
          [
            r.createdAt.toISOString(),
            r.user?.email ?? "(deleted)",
            r.provider,
            r.model,
            r.inputTokens,
            r.outputTokens,
            r.cacheReadTokens,
            r.cacheWriteTokens,
            r.costEstimate.toString(),
          ]
            .map(field)
            .join(",") + "\r\n";
      }
      controller.enqueue(encoder.encode(chunk));
      if (rows.length < BATCH) exhausted = true;
      else cursor = rows[rows.length - 1].id;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="opninfer-usage.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
