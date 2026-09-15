import { Readable } from "node:stream";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fileWhereFor } from "@/lib/chat-access";
import { readFileStream, statStoredFile } from "@/lib/storage";
import { hasSudo } from "@/lib/sudo";
import { audit } from "@/lib/audit";
import { MAX_PREVIEW_BYTES, isFramed, isTextual, previewKind } from "@/lib/artifact";
import { readFile } from "node:fs/promises";
import { resolveStoredPathForRead } from "@/lib/storage";
import { officeAsPdf } from "@/lib/office-preview";

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
  svg: "image/svg+xml",
  pdf: "application/pdf",
  markdown: "text/plain; charset=utf-8",
  code: "text/plain; charset=utf-8",
  text: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  converted: "text/plain; charset=utf-8",
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
  /**
   * Word, Excel, PowerPoint. Converted to PDF by the same LibreOffice engine
   * the ingestion worker uses, so it previews with its REAL layout rather than
   * as extracted text. Cached after the first conversion.
   *
   * If the engine is not configured or not reachable, fall THROUGH to the
   * prepared text below: the words without the layout is an honest degradation,
   * a spinner that never resolves is not.
   */
  if (kind === "office") {
    const pdf = await officeAsPdf({
      fileId: file.id,
      filename: file.filename,
      storagePath: file.storagePath,
      contentPath: file.contentPath,
    });
    if (pdf) {
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(pdf.byteLength),
          "Content-Disposition": `inline; filename="${encodeURIComponent(file.filename)}.pdf"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
        },
      });
    }
  }

  /**
   * A format no browser can render, which the ingestion worker already turned
   * into text. Serve THAT, not the original bytes — the alternative is either
   * a download dressed up as a preview or nothing at all, and the conversion
   * is the same text the assistant itself reads.
   */
  if (kind === "converted" || kind === "office") {
    if (!file.contentPath) return new Response("No preview was prepared", { status: 415 });
    try {
      const prepared = await readFile(await resolveStoredPathForRead(file.contentPath), "utf8");
      return new Response(prepared.slice(0, MAX_PREVIEW_BYTES), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `inline; filename="${encodeURIComponent(file.filename)}.md"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
          "X-Frame-Options": "DENY",
        },
      });
    } catch {
      return new Response("No preview was prepared", { status: 415 });
    }
  }

  if (isTextual(kind) && Number(file.sizeBytes) > MAX_PREVIEW_BYTES) {
    return new Response("Too large to preview", { status: 413 });
  }

  /**
   * The length of what is ACTUALLY on disk, never the `size_bytes` column.
   *
   * That column lags: `present_files` fires mid-run and `syncPool` only
   * re-stamps the row once the agent has finished, so a file can be rewritten
   * larger while the row still says what it used to be. Sending the stale
   * number as Content-Length makes the browser stop reading there and hand the
   * reader a TRUNCATED file — which for a PDF is "Invalid PDF structure" and
   * for anything else is silent corruption. Found live: a 116 KB PDF whose row
   * said otherwise arrived as a fragment and would not open.
   */
  const onDisk = await statStoredFile(file.storagePath);

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
      "Content-Length": String(onDisk?.size ?? file.sizeBytes),
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
