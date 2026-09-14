/**
 * Shared chats — the RULES, pure and client-safe (docs/V05_SHARED_CHATS.md §2).
 *
 * One place answers "who may do what in this chat", used by the server
 * (routes, actions, the loader) and by the UI (which buttons to offer), so the
 * two can never disagree. The DB half — the Prisma `where` fragments and the
 * access lookup — lives in `chat-access.ts`.
 *
 * The model: a chat has ONE owner (`conversations.user_id`, unchanged from
 * before) and, once shared, a row per person in `conversation_members` — the
 * owner included, so everyone in a shared chat carries the same per-person
 * state (star, last read). A chat with no member rows is private.
 */

export type ChatRole = "owner" | "member";

export interface ChatLike {
  userId: string;
  members?: { userId: string }[];
}

/** The person's role in the chat, or null when they are not in it at all. */
export function roleFor(chat: ChatLike, userId: string): ChatRole | null {
  if (chat.userId === userId) return "owner";
  if (chat.members?.some((m) => m.userId === userId)) return "member";
  return null;
}

/** Shared = at least one membership row (the owner's row is created with the
 *  first invite and removed with the last leave, so this is exact). */
export function isSharedChat(chat: ChatLike | { members?: { userId: string }[] }): boolean {
  return (chat.members?.length ?? 0) > 0;
}

/** Invite, remove, delete: the owner's alone. */
export function canManageChat(role: ChatRole | null): boolean {
  return role === "owner";
}

/** Leave: members only — the owner deletes instead. */
export function canLeaveChat(role: ChatRole | null): boolean {
  return role === "member";
}

/** Anything a person in the chat may do: read, send, attach, answer, steer,
 *  schedule, download, rate, rename, retry, stop. */
export function canUseChat(role: ChatRole | null): boolean {
  return role !== null;
}

/**
 * Edit-and-revert deletes everything after the edited message, so in a
 * shared chat it is allowed only on YOUR OWN message and only when nothing
 * anyone else wrote comes after it — one person must never be able to delete
 * another's words. (In a private chat every user turn is the owner's, so this
 * reduces to "always", as before.) `later` = the messages after the edited
 * one, in order; only user turns by someone else block the edit.
 */
export function canEditMessage(input: {
  me: string;
  message: { role: string; userId: string | null };
  later: { role: string; userId: string | null }[];
}): boolean {
  const { me, message, later } = input;
  if (message.role !== "user") return false;
  if (message.userId !== me) return false;
  return !later.some((m) => m.role === "user" && m.userId !== me);
}

/** A scheduled message can be cancelled by its author, or by the owner. */
export function canCancelQueued(role: ChatRole | null, itemUserId: string, me: string): boolean {
  return itemUserId === me || role === "owner";
}

/** Personal memory is never used in a shared chat (owner decision 7): your
 *  memory is private and the assistant's replies are on everyone's screen. */
export function memoryAllowed(chat: { incognito: boolean; members?: { userId: string }[] }): boolean {
  return !chat.incognito && !isSharedChat(chat);
}

export interface PersonLike {
  name?: string | null;
  email?: string | null;
}

/** Full display name: the profile name, else the email's local part. */
export function displayName(p: PersonLike): string {
  return p.name?.trim() || p.email?.split("@")[0] || "Someone";
}

/** The short label beside a bubble: first name, else the email's local part. */
export function shortName(p: PersonLike): string {
  const full = p.name?.trim();
  if (full) return full.split(/\s+/)[0];
  return p.email?.split("@")[0] || "Someone";
}
