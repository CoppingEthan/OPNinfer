import "server-only";
import { orderThreadRows } from "./thread-order";
import { loadCompaction } from "./compaction";
import { db } from "./db";
import { chatAccess, peopleById, type ChatAccess } from "./chat-access";
import { buildChatThread, type ChatThread } from "./chat-thread";
import { chatPeople, type ChatPeople } from "./sharing";
import { queueSnapshot, type QueuedMessageView } from "./chat-queue";

/**
 * Everything a chat screen needs, loaded the same way for the page (server
 * render) and for `GET /api/chat/thread` (the live feed's "reload" after a
 * reconnect or a transcript change on another screen) — so the two can't
 * drift. Null when the person may not see the chat.
 */
export interface ChatView extends ChatThread {
  id: string;
  title: string;
  incognito: boolean;
  access: ChatAccess;
  people: ChatPeople | null;
  queue: QueuedMessageView[];
}

export async function loadChatView(conversationId: string, userId: string): Promise<ChatView | null> {
  const access = await chatAccess(conversationId, userId);
  if (!access) return null;
  const convo = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      files: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!convo) return null;
  const rows = orderThreadRows(convo.messages);

  // Authors only matter once the chat is shared — a private chat's bubbles
  // stay unlabelled, exactly as before.
  const authors = access.shared
    ? await peopleById([
        ...access.memberIds,
        ...rows.map((m) => m.userId).filter((id): id is string => !!id),
      ])
    : undefined;

  const compaction = await loadCompaction(conversationId, rows);
  const thread = buildChatThread(rows, convo.files, {
    authors,
    viewerId: userId,
    ownerId: access.ownerId,
    compactedThroughId: compaction?.boundaryMessageId ?? null,
  });
  const people = access.shared ? await chatPeople(conversationId) : null;

  return {
    id: convo.id,
    title: convo.title,
    incognito: convo.incognito,
    access,
    people,
    queue: queueSnapshot(conversationId),
    ...thread,
  };
}
