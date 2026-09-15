import { Readable } from "node:stream";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fileWhereFor } from "@/lib/chat-access";
import { readFileStream } from "@/lib/storage";
import { hasSudo } from "@/lib/sudo";
import { audit } from "@/lib/audit";
import { MAX_PREVIEW_BYTES, isFramed, isTextual, previewKind } from "@/lib/artifact";

export const dynamic = "force-dynamic";

/**
 * GET /api/files/:id/preview — the same bytes as the download route, served
 * INLINE so the artifact panel can render them.
 *
 * It is a separate route rather than a query parameter on the download
 * because the two have genuinely different contracts. Download hands you a
 * file and its `Content-Disposition: attachment` is what stops a stored body
 * ever rendering on this origin; preview deliberately relaxes that, so it has
 * to re-earn the safety itself:
 *
 *   - it refuses anything `previewKind` says is not previewable, so an image,
 *     a zip or a docx can never reach a browser inline through this path;
 *   - it refuses a textual file over the cap, rather than streaming megabytes
 *     into a page that will choke on them;
 *   - the served Content-Type comes from what we DECIDED the file is, never
 *     from the stored mime — which for anything the Sandbox wrote is
 *     `application/octet-stream` and would render as nothing;
 *   - `CSP: sandbox` and `nosniff` stay. An HTML artifact therefore renders in
 *     a unique origin with scripts disabled: you can read the advert the agent
 *     built, and it cannot read anything of yours.
 *
 * Access is identical to the download route, including the audited sudo
 * exception, so the panel can never widen who sees what.
 */

const TYPE_FOR: Record<string, string> = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
  markdown: "text/plain; charset=utf-8",
  code: "text/plain; charset=utf-8",
  text: "text/plain; charset=utf-8",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const viewerId = session.user.id;

  let file = await db.file.findFirst({ where: { id, ...fileWhereFor(viewerId) } });

  if (!file && session.user.role === "admin" && (await hasSudo(viewerId))) {
    file = await db.file.findUnique({ where: { id } });
    if (file) {
      await audit("admin.view_file", {
        userId: viewerId,
        details: {
          fileId: file.id,
          filename: file.filename,
          ownerId: file.userId,
          conversationId: file.conversationId,
          via: "preview",
        },
      });
    }
  }
  if (!file) return new Response("Not found", { status: 404 });

  const kind = previewKind(file.mimeType, file.filename);
  if (kind === "none") {
    return new Response("Not previewable", { status: 415 });
  }
  if (isTextual(kind) && Number(file.sizeBytes) > MAX_PREVIEW_BYTES) {
    return new Response("Too large to preview", { status: 413 });
  }

  // Symlink-safe (audit 2026-09-05): a file the Sandbox replaced with a link
  // is "missing", never followed — see resolveStoredPathForRead.
  let stream: Readable;
  try {
    stream = (await readFileStream(file.storagePath)) as Readable;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": TYPE_FOR[kind] ?? "application/octet-stream",
      "Content-Length": file.sizeBytes.toString(),
      "Content-Disposition": `inline; filename="${encodeURIComponent(file.filename)}"`,
      // `v` in the URL is what busts the browser cache on a re-present, so
      // this may be cached briefly — but only ever privately.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // An HTML artifact renders in a unique origin with scripts disabled.
      // Without this line, serving `text/html` inline from our own origin
      // would be a stored-XSS hole wearing a preview panel as a disguise.
      "Content-Security-Policy": "sandbox",
      ...(isFramed(kind) ? {} : { "X-Frame-Options": "DENY" }),
    },
  });
}
