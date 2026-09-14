"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { deleteStoredFile } from "@/lib/storage";
import { audit } from "@/lib/audit";

/** Delete an uploaded file (DB row + bytes on disk): one you uploaded, or
 *  any file in a chat you OWN. A member of a shared chat can remove only
 *  their own attachments, never a colleague's. */
export async function deleteFile(fileId: string): Promise<void> {
  const user = await requireUser();
  const file = await db.file.findFirst({
    where: { id: fileId, OR: [{ userId: user.id }, { conversation: { userId: user.id } }] },
  });
  if (!file) return;

  await db.file.delete({ where: { id: file.id } });
  await deleteStoredFile(file.storagePath);
  await audit("file.delete", { userId: user.id, details: { fileId: file.id } });
}
