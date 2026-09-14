import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { appLog } from "@/lib/applog";
import { importOwuiBackup } from "@/lib/owui-import";

export const dynamic = "force-dynamic";

// A webui.db can be large (hundreds of MB); refuse anything absurd.
const MAX_DB_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * POST /api/admin/import/owui — import users/chats/memories from an uploaded
 * Open WebUI `webui.db` (multipart `file`). Additive + idempotent (existing
 * emails/chat ids are skipped). Admin only.
 *
 * NOTE: this route is EXCLUDED from the middleware matcher (middleware body
 * cloning caps/duplicates large uploads — see next.config), so the admin
 * check here is the only gate. Keep it strict.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data") || !req.body) {
    return Response.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  // Stream the upload to a temp file — never buffered in memory.
  const tempDir = await mkdtemp(path.join(tmpdir(), "owui-import-"));
  const tempDb = path.join(tempDir, "webui.db");
  try {
    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({
        headers: { "content-type": contentType },
        limits: { files: 1, fileSize: MAX_DB_BYTES },
      });
      let sawFile = false;
      bb.on("file", (_field, stream) => {
        sawFile = true;
        stream.on("limit", () =>
          reject(new Error("Upload exceeds the 4 GB import limit.")),
        );
        pipeline(stream, createWriteStream(tempDb)).then(resolve, reject);
      });
      bb.on("error", reject);
      bb.on("finish", () => {
        if (!sawFile) reject(new Error("No file provided."));
      });
      Readable.fromWeb(req.body as WebReadableStream<Uint8Array>).pipe(bb);
    });

    const summary = await importOwuiBackup(tempDb);

    await audit("import.owui", {
      userId: session.user.id,
      details: {
        usersCreated: summary.usersCreated,
        usersMatched: summary.usersMatched,
        chatsImported: summary.chatsImported,
        messagesImported: summary.messagesImported,
        memoriesImported: summary.memoriesImported,
      },
    });
    await appLog("info", "admin", "Imported an Open WebUI backup.", {
      userId: session.user.id,
      details: {
        usersCreated: summary.usersCreated,
        usersMatched: summary.usersMatched,
        chatsImported: summary.chatsImported,
        chatsSkippedExisting: summary.chatsSkippedExisting,
        messagesImported: summary.messagesImported,
        memoriesImported: summary.memoriesImported,
      },
    });

    // Ids are for harness/cleanup use — keep the HTTP payload lean.
    const { createdUserIds, importedConversationIds, ...counts } = summary;
    return Response.json({
      success: true,
      ...counts,
      createdUsers: createdUserIds.length,
      importedConversations: importedConversationIds.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import failed.";
    await appLog("error", "admin", "Open WebUI import failed.", {
      userId: session.user?.id,
      details: { error: msg },
    }).catch(() => {});
    return Response.json({ error: msg }, { status: 400 });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
