import { Readable } from "node:stream";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fileWhereFor } from "@/lib/chat-access";
import { readFileStream } from "@/lib/storage";
import { hasSudo } from "@/lib/sudo";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/files/:id — download a file. Access follows the file's CHAT (the
 * "signed download" of spec §8 is enforced by session here): your own files,
 * plus every file in a chat you are a member of — a colleague's attachment
 * or what the assistant produced during their turn (v0.5 shared chats).
 *
 * One exception: an admin holding an active sudo grant (Admin → Chats, after
 * re-entering their password) can read another user's files. Without it a
 * support transcript would render with every attachment and generated image
 * broken, which defeats the point of being able to read the chat at all. The
 * access is audited, same as opening the conversation.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }
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
        },
      });
    }
  }

  if (!file) return new Response("Not found", { status: 404 });
  // Symlink-safe (audit 2026-09-05): a file the Sandbox replaced with a link
  // is "missing", never followed — see resolveStoredPathForRead.
  let stream: Readable;
  try {
    stream = (await readFileStream(file.storagePath)) as Readable;
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const webStream = Readable.toWeb(stream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": file.sizeBytes.toString(),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(
        file.filename,
      )}"`,
      "Cache-Control": "private, no-store",
      // The type is whatever the uploader/upstream declared; never let a
      // browser sniff a stored body into HTML on the app's origin.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}
