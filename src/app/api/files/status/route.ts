import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fileWhereFor } from "@/lib/chat-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/files/status?ids=a,b,c — ingestion status for the caller's files.
 * The chat composer polls this while chips are pending/processing so users see
 * files flip to ready without a refresh.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
    .slice(0, 50);
  if (ids.length === 0) return Response.json({ files: [] });

  const rows = await db.file.findMany({
    where: { id: { in: ids }, ...fileWhereFor(session.user.id) },
    select: { id: true, status: true, processorGroup: true, error: true },
  });

  return Response.json({
    files: rows.map((r) => ({
      id: r.id,
      status: r.status,
      processorGroup: r.processorGroup,
      // The stored text is the worker's raw exception (container paths,
      // engine response bodies) — kept for Admin → Logs, never for the
      // browser (audit 2026-09-05). The chip only needs "it failed".
      error: r.error ? "This file could not be processed." : null,
    })),
  });
}
