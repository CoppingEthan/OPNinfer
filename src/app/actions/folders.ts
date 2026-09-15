"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { chatWhereFor } from "@/lib/chat-access";

/**
 * Folders — a person's own grouping for their sidebar.
 *
 * The filing is PER PERSON (see the schema note): the owner's lives on the
 * conversation, a member's on their membership row. Every write here works out
 * which of the two it is from the chat's ownership, so a caller never has to
 * — and so tidying a shared chat can never rearrange a colleague's sidebar.
 */

const nameSchema = z.string().trim().min(1, "Give the folder a name.").max(60);

export type FolderResult = { error?: string; success?: string; id?: string };

export async function createFolder(rawName: string): Promise<FolderResult> {
  const user = await requireUser();
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const name = parsed.data;

  const clash = await db.folder.findFirst({
    where: { userId: user.id, name },
    select: { id: true },
  });
  if (clash) return { error: `You already have a folder called "${name}".` };

  const last = await db.folder.findFirst({
    where: { userId: user.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const folder = await db.folder.create({
    data: { userId: user.id, name, position: (last?.position ?? 0) + 1 },
    select: { id: true },
  });
  revalidatePath("/chat");
  return { success: `Folder "${name}" created.`, id: folder.id };
}

export async function renameFolder(id: string, rawName: string): Promise<FolderResult> {
  const user = await requireUser();
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const owned = await db.folder.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!owned) return { error: "That folder no longer exists." };

  const clash = await db.folder.findFirst({
    where: { userId: user.id, name: parsed.data, NOT: { id } },
    select: { id: true },
  });
  if (clash) return { error: `You already have a folder called "${parsed.data}".` };

  await db.folder.update({ where: { id }, data: { name: parsed.data } });
  revalidatePath("/chat");
  return { success: "Renamed." };
}

/**
 * Delete the folder, never its chats.
 *
 * Both foreign keys are ON DELETE SET NULL, so every chat in it simply returns
 * to the date-grouped list. That is deliberate: a sidebar tidy-up that could
 * destroy conversations is a tidy-up nobody would dare use.
 */
export async function deleteFolder(id: string): Promise<FolderResult> {
  const user = await requireUser();
  const res = await db.folder.deleteMany({ where: { id, userId: user.id } });
  if (res.count === 0) return { error: "That folder no longer exists." };
  revalidatePath("/chat");
  return { success: "Folder deleted — the chats in it are still there." };
}

/**
 * File one or more chats. `folderId: null` takes them out of whatever folder
 * they were in.
 *
 * Which row is written depends on whether you own the chat, which is the one
 * subtlety worth keeping in one place: your filing of a chat somebody shared
 * WITH you belongs on your membership row, not on their conversation.
 */
export async function moveToFolder(
  conversationIds: string[],
  folderId: string | null,
): Promise<FolderResult> {
  const user = await requireUser();
  if (conversationIds.length === 0) return { error: "Nothing selected." };

  if (folderId) {
    const owned = await db.folder.findFirst({
      where: { id: folderId, userId: user.id },
      select: { id: true },
    });
    if (!owned) return { error: "That folder no longer exists." };
  }

  // Only chats this person may actually see, so an id from anywhere else is a
  // no-op rather than a way to learn whether a conversation exists.
  const visible = await db.conversation.findMany({
    where: { id: { in: conversationIds }, ...chatWhereFor(user.id) },
    select: { id: true, userId: true },
  });
  if (visible.length === 0) return { error: "Those chats are no longer available." };

  const mine = visible.filter((c) => c.userId === user.id).map((c) => c.id);
  const theirs = visible.filter((c) => c.userId !== user.id).map((c) => c.id);

  await db.$transaction(async (tx) => {
    if (mine.length) {
      // A raw update: `conversations.updated_at` is @updatedAt and is the
      // column the sidebar sorts by, so filing a chat through Prisma's update
      // would jump it to the top of the list — the memory-pass lesson.
      await tx.$executeRaw`
        UPDATE conversations SET folder_id = ${folderId}::uuid
        WHERE id = ANY(${mine}::uuid[])`;
    }
    if (theirs.length) {
      await tx.conversationMember.updateMany({
        where: { userId: user.id, conversationId: { in: theirs } },
        data: { folderId },
      });
    }
  });

  revalidatePath("/chat");
  return { success: folderId ? "Moved." : "Removed from the folder." };
}
