"use server";

import { revalidatePath } from "next/cache";
import { orderThreadRows } from "@/lib/thread-order";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { getAssistantConfig } from "@/lib/assistant";
import { generateTitle, recordUsage } from "@/lib/pipeline";
import { purgeConversationStorage } from "@/lib/storage";
import { abortTurn } from "@/lib/turn-stream";
import { clearQueued } from "@/lib/chat-queue";
import { chatAccess, chatMemberIds, chatWhereFor } from "@/lib/chat-access";
import { announceChatsDeleted, leaveAllSharedChats, membersOfChats } from "@/lib/sharing";
import { publishToUsers } from "@/lib/live";
import type { ChatMessage } from "@/lib/providers/types";

/**
 * Delete conversations AND their storage pools. The DB cascade only removes
 * the `files` rows — the bytes on disk are ours to clean up, so capture the
 * ids + paths first, delete the rows, then purge the disk.
 *
 * Deleting is the OWNER's alone (`userId` in the where); a member of a
 * shared chat leaves instead (`leaveChat` in actions/sharing.ts). Everyone
 * who was in a deleted chat is told over the live feed afterwards.
 */
async function deleteConversationsWithStorage(
  where: { id?: string | { in: string[] }; userId: string; incognito?: boolean },
): Promise<number> {
  const convos = await db.conversation.findMany({
    where,
    select: { id: true, files: { select: { storagePath: true } } },
  });
  if (convos.length === 0) return 0;
  const ids = convos.map((c) => c.id);
  const members = await membersOfChats(ids);
  // A live reply may still be generating (resumable turns run detached from
  // the client) — abort it so the provider call stops and its save doesn't
  // land on a deleted conversation.
  for (const c of convos) {
    abortTurn(c.id);
    clearQueued(c.id);
  }
  const res = await db.conversation.deleteMany({
    where: { id: { in: ids }, userId: where.userId },
  });
  await purgeConversationStorage(convos);
  announceChatsDeleted(members);
  return res.count;
}

const titleSchema = z.string().trim().min(1).max(200);

/** Tell everyone in the chat (other tabs of yours included) about a new title. */
async function announceTitle(conversationId: string, title: string): Promise<void> {
  publishToUsers(await chatMemberIds(conversationId), { type: "title", conversationId, title });
}

/** Rename: anyone in the chat (owner decision 11). */
export async function renameConversation(
  id: string,
  rawTitle: string,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const parsed = titleSchema.safeParse(rawTitle);
  if (!parsed.success) return { error: "Title cannot be empty." };

  const access = await chatAccess(id, user.id);
  if (!access) return { error: "Conversation not found." };

  await db.conversation.update({
    where: { id },
    data: { title: parsed.data },
  });
  await announceTitle(id, parsed.data);
  revalidatePath("/chat");
  return {};
}

/** Star: personal. The owner's lives on the chat, a member's on their row. */
export async function togglePin(id: string): Promise<void> {
  const user = await requireUser();
  const access = await chatAccess(id, user.id);
  if (!access) return;

  if (access.role === "owner") {
    const convo = await db.conversation.findUnique({ where: { id }, select: { pinned: true } });
    if (!convo) return;
    await db.conversation.update({ where: { id }, data: { pinned: !convo.pinned } });
  } else {
    const row = await db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: id, userId: user.id } },
      select: { id: true, pinned: true },
    });
    if (!row) return;
    await db.conversationMember.update({ where: { id: row.id }, data: { pinned: !row.pinned } });
  }
  revalidatePath("/chat");
}

export async function deleteConversation(id: string): Promise<void> {
  const user = await requireUser();
  // Messages + files cascade (spec §4); usage_records are SET NULL, preserved.
  // The chat's storage pool is removed from disk too.
  await deleteConversationsWithStorage({ id, userId: user.id });
  revalidatePath("/chat");
  redirect("/chat");
}

/**
 * Delete one or more of the user's conversations WITHOUT redirecting — used by
 * the sidebar kebab, multi-select bulk delete, and incognito cleanup. As with
 * every delete, messages/files cascade while usage/audit records are preserved.
 */
export async function deleteConversations(ids: string[]): Promise<{ deleted: number }> {
  const user = await requireUser();
  if (ids.length === 0) return { deleted: 0 };
  const count = await deleteConversationsWithStorage({
    id: { in: ids },
    userId: user.id,
  });
  if (count > 0) {
    await audit("conversation.delete", {
      userId: user.id,
      details: { count, ids: ids.slice(0, 50) },
    });
    revalidatePath("/chat");
  }
  return { deleted: count };
}

/**
 * Delete ALL of the user's conversations (spec: "delete all my chats" in user
 * settings). Follows the same logic as a normal delete — chats/messages/files
 * go, billing + audit records remain for the admin. Chats shared WITH the
 * user are not theirs to delete: they leave those instead.
 */
export async function deleteAllMyChats(): Promise<{ deleted: number; left: number }> {
  const user = await requireUser();
  const count = await deleteConversationsWithStorage({ userId: user.id });
  const left = await leaveAllSharedChats(user.id);
  await audit("conversation.delete_all", {
    userId: user.id,
    details: { count, left },
  });
  revalidatePath("/chat");
  return { deleted: count, left };
}

/**
 * Re-title a conversation with the front-end model (spec: "rename with AI").
 * Reuses the same 2–5-word emoji title generator as new-chat naming, over the
 * first user/assistant exchange. Usage is recorded under the `frontend` role,
 * against whoever asked. Anyone in the chat may.
 */
export async function renameConversationWithAI(
  id: string,
): Promise<{ title?: string; error?: string }> {
  const user = await requireUser();
  const convo = await db.conversation.findFirst({
    where: { id, ...chatWhereFor(user.id) },
    include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 6 } },
  });
  if (!convo) return { error: "Conversation not found." };

  const chat: ChatMessage[] = orderThreadRows(convo.messages)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
  const firstUser = chat.find((m) => m.role === "user")?.content ?? "";
  const firstAssistant = chat.find((m) => m.role === "assistant")?.content ?? "";
  if (!firstUser) return { error: "Nothing to name yet." };

  const config = await getAssistantConfig();
  const result = await generateTitle(config, firstUser, firstAssistant);
  if (!result) return { error: "The assistant isn't configured to name chats." };

  await db.conversation.update({ where: { id }, data: { title: result.title } });
  await announceTitle(id, result.title);
  if (result.usage) {
    await recordUsage({
      userId: user.id,
      role: "frontend",
      provider: result.role.provider,
      model: result.role.model,
      usage: result.usage,
    });
  }
  revalidatePath("/chat");
  return { title: result.title };
}
