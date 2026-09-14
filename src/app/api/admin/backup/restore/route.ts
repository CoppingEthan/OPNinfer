import Busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { auth } from "@/auth";
import { audit } from "@/lib/audit";
import { appLog } from "@/lib/applog";
import { restoreFromZip } from "@/lib/backup";

export const dynamic = "force-dynamic";

/** A full-instance archive (database dump + every stored file) gets big. */
const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * POST /api/admin/backup/restore — restore the instance from an uploaded backup
 * zip (multipart `file`). DESTRUCTIVE: replaces all data and stored files.
 * Admin only. Returns a JSON summary (or an error the UI surfaces).
 *
 * The upload is STREAMED to a temp file, and this route is EXCLUDED from the
 * middleware matcher — for the same reason the OWUI importer is. Middleware
 * clones a matched request's body at `middlewareClientMaxBodySize` (256 MB) and
 * truncates silently past it, so a real backup from a live instance could not
 * be restored at all: JSZip failed on the missing central directory and the
 * admin was told their backup file was corrupt, on the one day it mattered.
 * That exclusion makes the admin check here the ONLY gate — keep it strict.
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

  const tempDir = await mkdtemp(path.join(tmpdir(), "opninfer-restore-"));
  const tempZip = path.join(tempDir, "backup.zip");
  try {
    await new Promise<void>((resolve, reject) => {
      const bb = Busboy({
        headers: { "content-type": contentType },
        limits: { files: 1, fileSize: MAX_ZIP_BYTES },
      });
      let sawFile = false;
      bb.on("file", (_field, stream) => {
        sawFile = true;
        stream.on("limit", () => reject(new Error("Backup exceeds the 4 GB limit.")));
        pipeline(stream, createWriteStream(tempZip)).then(resolve, reject);
      });
      bb.on("error", reject);
      bb.on("finish", () => {
        if (!sawFile) reject(new Error("No backup file provided."));
      });
      Readable.fromWeb(req.body as WebReadableStream<Uint8Array>).pipe(bb);
    });

    const result = await restoreFromZip(await readFile(tempZip));

    // Audit + log AFTER the restore so the entry lands in the restored DB.
    await audit("backup.restore", {
      userId: session.user.id,
      details: {
        appVersion: result.appVersion,
        createdAt: result.createdAt,
        restoredFiles: result.restoredFiles,
        masterKeyMismatch: result.masterKeyMismatch,
      },
    });
    await appLog("warn", "backup", "Instance restored from backup.", {
      userId: session.user.id,
      details: { from: result.createdAt, tables: result.tables },
    });

    return Response.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Restore failed.";
    await appLog("error", "backup", "Restore failed.", {
      userId: session.user?.id,
      details: { error: msg },
    }).catch(() => {});
    return Response.json({ error: msg }, { status: 400 });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
