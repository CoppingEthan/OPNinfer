import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { roleFor, type ChatRole } from "./chat-rules";

/**
 * Shared chats — the DB half of the access rule (docs/V05_SHARED_CHATS.md §5).
 *
 * Before v0.5 every route, action and page loader checked
 * `where: { id, userId }` — "is this the owner". Those checks now come
 * through here, so admitting members is one rule in one place and the
 * appendix's forty-odd call sites cannot drift from each other. Three
 * shapes existed and all three have a helper:
 *
 *   - a conversation the person may use → `chatWhereFor` / `chatAccess`
 *   - a message, via its conversation   → `messageWhereFor`
 *   - a file — which used to follow the UPLOADER, not the chat. In a shared
 *     chat that broke downloads of anything a colleague (or the assistant
 *     during a colleague's turn) added, so files now follow their
 *     conversation: `fileWhereFor` / `fileAccess`.
 */

/** Conversations this person may use: owned, or a member of. */
export function chatWhereFor(userId: string): Prisma.ConversationWhereInput {
  return { OR: [{ userId }, { members: { some: { userId } } }] };
}

/** Messages this person may touch (rate, listen to): in a chat they may use. */
export function messageWhereFor(userId: string): Prisma.MessageWhereInput {
  return { conversation: chatWhereFor(userId) };
}

/** Files this person may read: their own (covers the legacy per-user layout
 *  and files whose chat is gone), or any file in a chat they may use. */
export function fileWhereFor(userId: string): Prisma.FileWhereInput {
  return { OR: [{ userId }, { conversation: chatWhereFor(userId) }] };
}

export interface ChatAccess {
  id: string;
  role: ChatRole;
  ownerId: string;
  incognito: boolean;
  /** True once the chat has member rows (the owner's included). */
  shared: boolean;
  /** Everyone in the chat — owner first, then members in join order. */
  memberIds: string[];
}

/** Who this person is in the chat, or null when they may not use it. */
export async function chatAccess(conversationId: string, userId: string): Promise<ChatAccess | null> {
  const c = await db.conversation.findFirst({
    where: { id: conversationId, ...chatWhereFor(userId) },
    select: {
      id: true,
      userId: true,
      incognito: true,
      members: { select: { userId: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!c) return null;
  const role = roleFor(c, userId);
  if (!role) return null;
  return {
    id: c.id,
    role,
    ownerId: c.userId,
    incognito: c.incognito,
    shared: c.members.length > 0,
    memberIds: [c.userId, ...c.members.map((m) => m.userId).filter((id) => id !== c.userId)],
  };
}

/** Everyone who should hear about the chat: owner + members, distinct. Used
 *  by the live feed to fan sidebar-level events out (title, activity, delete). */
export async function chatMemberIds(conversationId: string): Promise<string[]> {
  const c = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, members: { select: { userId: true } } },
  });
  if (!c) return [];
  return [c.userId, ...c.members.map((m) => m.userId).filter((id) => id !== c.userId)];
}

export interface Person {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

/** Profile fields for a set of user ids (authors, members) in one query. */
export async function peopleById(ids: Iterable<string>): Promise<Map<string, Person>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true, image: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}
