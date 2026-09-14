import "server-only";
import { db } from "./db";
import { audit } from "./audit";
import { peopleById, type Person } from "./chat-access";
import { sidebarItemFor } from "./chat-items";
import { displayName, roleFor } from "./chat-rules";
import { chatViewers, detachViewer, publishToChat, publishToUsers } from "./live";
import { clearQueued, queueSnapshot, removeQueuedByUser } from "./chat-queue";
import { withdrawInterjectionsByUser } from "./interject";
import { devLog } from "./dev-log";

/**
 * Shared chats — inviting, removing, leaving (docs/V05_SHARED_CHATS.md §1–2).
 *
 * The owner is `conversations.user_id`; `conversation_members` holds everyone
 * in a shared chat, the owner included (created with the first invite,
 * removed with the last leave, so "shared" is simply "has rows"). Every
 * change here also tells the live feed, so open screens update at once: the
 * invitee's sidebar gains the chat, a removed person's screen is bounced,
 * and the People panel refreshes for whoever has it open.
 *
 * Files belong to the CHAT, not the uploader (owner decision 16): when
 * someone leaves or is removed, their uploads are re-stamped to the owner —
 * otherwise deleting that person's account later would cascade files out of
 * somebody else's chat.
 */

export interface ChatPerson extends Person {
  role: "owner" | "member";
}

export interface ChatPeople {
  conversationId: string;
  ownerId: string;
  shared: boolean;
  people: ChatPerson[];
  /** Who has the chat open right now. */
  online: string[];
}

/** Everyone in the chat, owner first. Null if the chat does not exist. */
export async function chatPeople(conversationId: string): Promise<ChatPeople | null> {
  const c = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      members: { select: { userId: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!c) return null;
  const ids = [c.userId, ...c.members.map((m) => m.userId).filter((id) => id !== c.userId)];
  const people = await peopleById(ids);
  return {
    conversationId: c.id,
    ownerId: c.userId,
    shared: c.members.length > 0,
    people: ids
      .map((id) => people.get(id))
      .filter((p): p is Person => !!p)
      .map((p) => ({ ...p, role: p.id === c.userId ? "owner" : "member" })),
    online: chatViewers(c.id),
  };
}

/** Push the current people list to every open screen of the chat, and each
 *  person's own sidebar row to them (shared/member-count/owner may change). */
export async function announcePeople(conversationId: string): Promise<void> {
  const people = await chatPeople(conversationId);
  if (!people) return;
  publishToChat(conversationId, { type: "people", ...people });
  for (const p of people.people) {
    const item = await sidebarItemFor(conversationId, p.id);
    if (item) publishToUsers([p.id], { type: "chat_item", item });
  }
}

/**
 * Add people to a chat. Only the owner may; incognito chats never. Unknown,
 * disabled, already-present ids and the owner's own id are skipped silently
 * — the panel shows the result. Returns how many were actually added.
 */
export async function addMembers(
  conversationId: string,
  byUserId: string,
  userIds: string[],
): Promise<{ added: number; error?: string }> {
  const convo = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, incognito: true, title: true, members: { select: { userId: true } } },
  });
  if (!convo || convo.userId !== byUserId) return { added: 0, error: "Only the chat's owner can share it." };
  if (convo.incognito) return { added: 0, error: "Incognito chats can't be shared." };

  const present = new Set(convo.members.map((m) => m.userId));
  const wanted = [...new Set(userIds)].filter((id) => id !== convo.userId && !present.has(id));
  if (wanted.length === 0) return { added: 0 };
  const users = await db.user.findMany({
    where: { id: { in: wanted }, disabled: false },
    select: { id: true },
  });
  if (users.length === 0) return { added: 0 };

  // The owner's own row comes with the first invite — from then on everyone
  // in the chat carries the same per-person state.
  const rows = users.map((u) => ({ conversationId, userId: u.id, invitedById: byUserId }));
  if (!present.has(convo.userId)) rows.unshift({ conversationId, userId: convo.userId, invitedById: null as unknown as string });
  await db.conversationMember.createMany({
    data: rows.map((r) => ({ ...r, invitedById: r.invitedById ?? null })),
    skipDuplicates: true,
  });

  await audit("chat.share", {
    userId: byUserId,
    details: { conversationId, added: users.map((u) => u.id) },
  });
  devLog("info", "chat", "chat shared", { conversationId, by: byUserId, added: users.map((u) => u.id) });

  // Tell the invitees (their sidebar gains the chat, with a notice), then
  // everyone's screens.
  const owner = (await peopleById([byUserId])).get(byUserId);
  const byName = owner ? displayName(owner) : "Someone";
  for (const u of users) {
    const item = await sidebarItemFor(conversationId, u.id);
    if (item) publishToUsers([u.id], { type: "chat_added", item, by: byName });
  }
  await announcePeople(conversationId);
  return { added: users.length };
}

/**
 * Take someone out of a chat — by the owner ("remove"), or by themselves
 * ("leave"). The owner can never be removed and never leaves (they delete).
 * Their uploads stay with the chat (re-stamped to the owner). When the last
 * member goes, the owner's row goes too and the chat is private again.
 */
export async function removeMember(
  conversationId: string,
  byUserId: string,
  targetUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const convo = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, members: { select: { userId: true } } },
  });
  if (!convo) return { ok: false, error: "Conversation not found." };
  const leaving = byUserId === targetUserId;
  const byRole = roleFor(convo, byUserId);
  if (targetUserId === convo.userId) return { ok: false, error: "The owner can't be removed — delete the chat instead." };
  if (!leaving && byRole !== "owner") return { ok: false, error: "Only the chat's owner can remove people." };
  if (leaving && byRole !== "member") return { ok: false, error: "You're not a member of this chat." };
  if (!convo.members.some((m) => m.userId === targetUserId)) return { ok: false, error: "That person isn't in this chat." };

  await db.$transaction([
    db.file.updateMany({ where: { conversationId, userId: targetUserId }, data: { userId: convo.userId } }),
    db.conversationMember.deleteMany({ where: { conversationId, userId: targetUserId } }),
  ]);
  // Last member gone → private again.
  const remaining = await db.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  if (remaining.length > 0 && remaining.every((m) => m.userId === convo.userId)) {
    await db.conversationMember.deleteMany({ where: { conversationId } });
  }

  await audit(leaving ? "chat.leave" : "chat.unshare", {
    userId: byUserId,
    details: { conversationId, ...(leaving ? {} : { removed: targetUserId }) },
  });
  devLog("info", "chat", leaving ? "member left chat" : "member removed from chat", {
    conversationId, by: byUserId, target: targetUserId,
  });

  // Their pending words go with them (audit 2026-09-05): a queued or offered
  // message would otherwise still land in the chat, as them, after removal —
  // and their open tabs are cut off from the chat's live events, which are
  // only access-checked at connect.
  const droppedQueued = removeQueuedByUser(conversationId, targetUserId);
  withdrawInterjectionsByUser(conversationId, targetUserId);
  detachViewer(conversationId, targetUserId);
  publishToUsers([targetUserId], { type: "chat_removed", conversationId, reason: leaving ? "left" : "removed" });
  if (droppedQueued.length > 0) {
    publishToChat(conversationId, { type: "queue", items: queueSnapshot(conversationId) });
  }
  await announcePeople(conversationId);
  return { ok: true };
}

/** Leave every chat shared WITH this person ("delete all my chats" for the
 *  ones they don't own; account deletion). Owned chats are the caller's. */
export async function leaveAllSharedChats(userId: string): Promise<number> {
  const rows = await db.conversationMember.findMany({
    where: { userId, conversation: { userId: { not: userId } } },
    select: { conversationId: true },
  });
  let n = 0;
  for (const r of rows) {
    const res = await removeMember(r.conversationId, userId, userId);
    if (res.ok) n++;
  }
  return n;
}

/**
 * Before a chat is deleted: who has to hear about it. Called by the delete
 * paths with the ids they are about to remove; the cascade takes the rows,
 * so the members must be read first and told after.
 */
export async function membersOfChats(conversationIds: string[]): Promise<Map<string, string[]>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await db.conversation.findMany({
    where: { id: { in: conversationIds } },
    select: { id: true, userId: true, members: { select: { userId: true } } },
  });
  return new Map(
    rows.map((c) => [c.id, [...new Set([c.userId, ...c.members.map((m) => m.userId)])]]),
  );
}

/** After the delete: every screen in those chats is bounced, every sidebar
 *  loses the row, and any scheduled messages are dropped. */
export function announceChatsDeleted(members: Map<string, string[]>, exceptClient?: string): void {
  for (const [conversationId, userIds] of members) {
    clearQueued(conversationId);
    publishToUsers(userIds, { type: "chat_deleted", conversationId }, { exceptClient });
    detachViewer(conversationId);
  }
}
