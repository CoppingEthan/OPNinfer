import Busboy from "busboy";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { chatAccess } from "@/lib/chat-access";
import {
  saveFileToPool,
  deleteChatPool,
  UploadTooLargeError,
  type StoredFile,
} from "@/lib/storage";
import { getMaxUploadBytes } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { devLog } from "@/lib/dev-log";
import { drainResponse, isDraining } from "@/lib/drain";

export const dynamic = "force-dynamic";

/**
 * POST /api/files?conversationId=…&incognito=1 — upload a file into a chat's
 * storage pool (multipart `file`). The body is STREAMED to disk via busboy —
 * a 100 MB upload never sits in memory — with the admin-configured size limit
 * enforced mid-stream.
 *
 * Every file belongs to a conversation pool. If no `conversationId` is given
 * (attaching in a brand-new chat), the conversation is created here so the
 * pool exists ("create on attach"); the response carries the id for the client
 * to adopt. The row starts `status=pending` for the ingestion worker.
 */
export async function POST(req: Request) {
  // Mid-deploy: an upload accepted now would be half-ingested when the worker
  // and app are replaced. Refuse it with the same "we're updating" notice the
  // composer shows for chat.
  if (isDraining()) return drainResponse();

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const url = new URL(req.url);
  const rawConvId = url.searchParams.get("conversationId");
  const incognito = url.searchParams.get("incognito") === "1";
  const max = await getMaxUploadBytes();
  const maxMb = Math.floor(max / 1024 / 1024);

  // Fast-fail on the declared length (small margin for multipart framing).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max + 65_536) {
    return Response.json(
      { error: `File exceeds the ${maxMb} MB limit.` },
      { status: 413 },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data") || !req.body) {
    return Response.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  // Resolve the pool: verify access (owner or member — a shared chat has ONE
  // workspace everyone attaches into), or create the conversation on attach.
  let conversationId: string;
  let conversationCreated = false;
  if (rawConvId) {
    const access = await chatAccess(rawConvId, userId);
    if (!access) {
      return Response.json({ error: "Conversation not found." }, { status: 404 });
    }
    conversationId = access.id;
  } else {
    const convo = await db.conversation.create({
      data: { userId, title: "New chat", incognito },
    });
    conversationId = convo.id;
    conversationCreated = true;
  }

  interface Uploaded {
    stored: StoredFile;
    declaredMime: string;
  }

  let uploaded: Uploaded;
  try {
    uploaded = await new Promise<Uploaded>((resolvePromise, reject) => {
      const bb = Busboy({
        headers: { "content-type": contentType },
        // One file per request; cap set ABOVE our limit so the byte-meter in
        // saveFileToPool throws (a clean 413) before busboy silently truncates.
        limits: { files: 1, fileSize: max + 1 },
      });
      let sawFile = false;

      bb.on("file", (_field, stream, info) => {
        sawFile = true;
        saveFileToPool(conversationId, info.filename || "file", stream, max)
          .then((stored) =>
            resolvePromise({
              stored,
              declaredMime: info.mimeType || "application/octet-stream",
            }),
          )
          .catch((err) => {
            stream.resume(); // drain so busboy can finish
            reject(err);
          });
      });
      bb.on("error", reject);
      bb.on("finish", () => {
        if (!sawFile) reject(new Error("No file provided."));
      });

      Readable.fromWeb(req.body as WebReadableStream<Uint8Array>).pipe(bb);
    });
  } catch (err) {
    // Roll back a conversation we created for this failed upload.
    if (conversationCreated) {
      await db.conversation.delete({ where: { id: conversationId } }).catch(() => {});
      await deleteChatPool(conversationId);
    }
    const msg = err instanceof Error ? err.message : "Upload failed.";
    const tooLarge = err instanceof UploadTooLargeError;
    devLog(tooLarge ? "warn" : "error", "upload", `upload failed: ${msg}`, {
      userId, conversationId, declared, contentType: contentType.slice(0, 60),
    });
    if (tooLarge) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    return Response.json({ error: msg }, { status: 400 });
  }

  // `filename` = the (possibly deduplicated) pool name, so the chip, the pool
  // path, and what the model later sees all agree.
  const row = await db.file.create({
    data: {
      userId,
      conversationId,
      filename: uploaded.stored.storedName,
      mimeType: uploaded.declaredMime,
      sizeBytes: BigInt(uploaded.stored.sizeBytes),
      storagePath: uploaded.stored.storagePath,
      // kind/status default to upload/pending — the ingestion worker takes over.
    },
  });

  devLog("info", "upload", `stored ${row.filename}`, {
    userId, conversationId, fileId: row.id,
    sizeBytes: uploaded.stored.sizeBytes, mime: uploaded.declaredMime,
  });
  await audit("file.upload", {
    userId,
    details: {
      fileId: row.id,
      conversationId,
      sizeBytes: uploaded.stored.sizeBytes,
    },
  });

  return Response.json({
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    status: row.status,
    conversationId,
    conversationCreated,
  });
}
