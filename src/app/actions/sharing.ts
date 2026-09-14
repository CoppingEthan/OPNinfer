"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { chatAccess } from "@/lib/chat-access";
import { addMembers, chatPeople, removeMember, type ChatPeople } from "@/lib/sharing";

/**
 * Server actions behind the People panel (v0.5 shared chats). Every one
 * re-checks access server-side; the panel only decides what to offer.
 */

/** Who is in the chat (owner first) + who is online. Anyone in it may ask. */
export async function getChatPeople(conversationId: string): Promise<ChatPeople | null> {
  const user = await requireUser();
  const access = await chatAccess(conversationId, user.id);
  if (!access) return null;
  return chatPeople(conversationId);
}

const querySchema = z.string().trim().max(80);

/** Colleagues who could be added: active accounts matching name or email,
 *  minus yourself and anyone already in the chat. Up to 8. */
export async function searchPeople(
  conversationId: string,
  rawQuery: string,
): Promise<{ id: string; name: string | null; email: string; image: string | null }[]> {
  const user = await requireUser();
  const q = querySchema.parse(rawQuery);
  const access = await chatAccess(conversationId, user.id);
  if (!access || access.role !== "owner") return [];
  const exclude = new Set([user.id, ...access.memberIds]);
  const rows = await db.user.findMany({
    where: {
      disabled: false,
      id: { notIn: [...exclude] },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 8,
    select: { id: true, name: true, email: true, image: true },
  });
  return rows;
}

export async function shareChat(
  conversationId: string,
  userIds: string[],
): Promise<{ added: number; error?: string }> {
  const user = await requireUser();
  const ids = z.array(z.string().uuid()).max(50).parse(userIds);
  return addMembers(conversationId, user.id, ids);
}

export async function unshareChat(
  conversationId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  return removeMember(conversationId, user.id, z.string().uuid().parse(userId));
}

export async function leaveChat(conversationId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  return removeMember(conversationId, user.id, user.id);
}
