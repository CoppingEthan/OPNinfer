import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { chatWhereFor } from "./chat-access";
import type { ConversationItem } from "@/components/chat/sidebar";

/**
 * The sidebar row, built the same way for the layout's initial list and for
 * the live "a chat was shared with you" event, so the two can't disagree.
 * Star and unread are PER PERSON: the owner's star lives on the conversation,
 * a member's on their membership row; unread = the chat moved on since this
 * person last opened it (membership rows only — a private chat is never
 * unread for its only reader).
 */
export const CONVERSATION_ITEM_SELECT = {
  id: true,
  title: true,
  pinned: true,
  updatedAt: true,
  userId: true,
  user: { select: { name: true, email: true, image: true } },
  members: { select: { userId: true, pinned: true, lastReadAt: true } },
} satisfies Prisma.ConversationSelect;

export type ConversationItemRow = Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_ITEM_SELECT }>;

export function toConversationItem(c: ConversationItemRow, forUserId: string): ConversationItem {
  const mine = c.userId === forUserId;
  const me = c.members.find((m) => m.userId === forUserId);
  const shared = c.members.length > 0;
  return {
    id: c.id,
    title: c.title,
    pinned: mine ? c.pinned : !!me?.pinned,
    updatedAt: c.updatedAt.toISOString(),
    shared,
    mine,
    ownerId: c.userId,
    ...(mine ? {} : { owner: { name: c.user.name, email: c.user.email, image: c.user.image } }),
    memberCount: c.members.length,
    unread: shared && !!me && (!me.lastReadAt || me.lastReadAt < c.updatedAt),
  };
}

/** Every chat this person may see in the sidebar: starred first, then by
 *  recency. Incognito chats never appear. */
export async function sidebarItems(userId: string): Promise<ConversationItem[]> {
  const rows = await db.conversation.findMany({
    where: { ...chatWhereFor(userId), incognito: false },
    orderBy: { updatedAt: "desc" },
    select: CONVERSATION_ITEM_SELECT,
  });
  const items = rows.map((r) => toConversationItem(r, userId));
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/** One chat's row as THIS person sees it (null if they may not see it). */
export async function sidebarItemFor(conversationId: string, userId: string): Promise<ConversationItem | null> {
  const row = await db.conversation.findFirst({
    where: { id: conversationId, ...chatWhereFor(userId), incognito: false },
    select: CONVERSATION_ITEM_SELECT,
  });
  return row ? toConversationItem(row, userId) : null;
}
