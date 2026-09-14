import { readFile } from "node:fs/promises";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fileWhereFor } from "@/lib/chat-access";
import { resolveStoredPathForRead } from "@/lib/storage";
import { formatBytes } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * GET /api/files/:id/context — the exact prepared content `read_file` would
 * hand the assistant for this file (what the LLM actually reads), so a user
 * can see for themselves what the model sees. Owner-only, same ownership
 * check as the download route. Returns the full text unpaginated — the
 * model's page-at-a-time limit is a tool-call mechanic, not a formatting
 * difference, so showing it whole is the more honest "exact" view.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const file = await db.file.findFirst({
    where: { id, ...fileWhereFor(session.user.id) },
  });
  if (!file) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const manifestType = file.processorGroup ?? file.detectedMime ?? file.mimeType;
  const base = {
    filename: file.filename,
    sizeBytes: Number(file.sizeBytes),
    sizeFormatted: formatBytes(Number(file.sizeBytes)),
    type: manifestType,
    status: file.status,
    tokenEstimate: file.tokenEstimate,
  };

  if (file.status === "pending" || file.status === "processing") {
    return Response.json({ ...base, content: null, note: "Still being prepared — not readable by the assistant yet." });
  }
  if (file.status === "failed") {
    return Response.json({ ...base, content: null, note: "Preparation failed — the assistant has no readable content for this file." });
  }
  if (!file.contentPath) {
    return Response.json({
      ...base,
      content: null,
      note:
        manifestType === "image"
          ? "This is an image — the assistant sees it natively (vision) or via view_image, not as text content."
          : "No readable text content was extracted — metadata only.",
    });
  }

  try {
    const content = await readFile(await resolveStoredPathForRead(file.contentPath), "utf8");
    return Response.json({ ...base, content });
  } catch {
    return Response.json({ ...base, content: null, note: "Prepared content is missing from storage." }, { status: 500 });
  }
}
