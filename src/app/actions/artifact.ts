"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { fileWhereFor } from "@/lib/chat-access";
import { statStoredFile } from "@/lib/storage";
import { canPreview, previewKind, type PreviewKind } from "@/lib/artifact";
import { gotenbergUrl } from "@/lib/office-preview";

export interface ArtifactMeta {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  kind: PreviewKind;
  previewable: boolean;
  conversationId: string | null;
  /** The ingestion worker produced text for this one — what makes a .docx or
   *  a .zip previewable at all. */
  hasPrepared: boolean;
  /**
   * The file's modification time in ms — the cache key the panel puts in the
   * preview URL.
   *
   * Read from DISK, not from the row: `files` carries no updated_at at all,
   * and even its size lags a rewrite because `present_files` fires mid-run
   * while `syncPool` only re-syncs the row once the agent has finished. The
   * same reason generated images stamp mtime rather than a column.
   */
  version: number;
}

/** What the artifact panel needs to render its header and fetch its body. */
export async function getArtifactMeta(id: string): Promise<ArtifactMeta | null> {
  const user = await requireUser();
  const file = await db.file.findFirst({
    where: { id, ...fileWhereFor(user.id) },
    select: {
      id: true,
      filename: true,
      sizeBytes: true,
      mimeType: true,
      storagePath: true,
      contentPath: true,
      conversationId: true,
      createdAt: true,
    },
  });
  if (!file) return null;

  // `files` has no updated_at (a documented quirk), so creation time is the
  // fallback and the real answer comes from the disk below.
  let version = file.createdAt.getTime();
  let sizeBytes = Number(file.sizeBytes);
  try {
    const st = await statStoredFile(file.storagePath);
    if (st) {
      version = st.mtimeMs;
      // The row's size lags a rewrite for the same reason its updatedAt does.
      sizeBytes = st.size;
    }
  } catch {
    /* gone or unreadable — the preview route will say so properly */
  }

  const kind = previewKind(file.mimeType, file.filename);
  return {
    id: file.id,
    filename: file.filename,
    sizeBytes,
    mimeType: file.mimeType,
    kind,
    hasPrepared: !!file.contentPath,
    previewable: canPreview({
      mimeType: file.mimeType,
      filename: file.filename,
      sizeBytes,
      hasPrepared: !!file.contentPath,
      officeToPdf: !!gotenbergUrl(),
    }),
    conversationId: file.conversationId,
    version: Math.round(version),
  };
}
