import { readJsonBounded } from "@/lib/validation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { chatAccess } from "@/lib/chat-access";
import { canCancelQueued, displayName } from "@/lib/chat-rules";
import { enqueueMessage, queueSnapshot, removeQueued } from "@/lib/chat-queue";
import { offerInterjection, withdrawInterjection } from "@/lib/interject";
import { publishToChat } from "@/lib/live";
import { hasActiveTurn } from "@/lib/turn-stream";
import { devLog } from "@/lib/dev-log";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(100_000),
  fileIds: z.array(z.string().uuid()).max(20).optional(),
  extendedThinking: z.boolean().optional(),
});

/**
 * POST /api/chat/queue — a message sent while a reply is streaming (v0.5,
 * docs/V05_SHARED_CHATS.md "Scheduling and steering").
 *
 * The portal holds it: it is OFFERED to the running turn as a steer (unless
 * it carries attachments — those can't ride an injection) AND lined up in
 * the chat's scheduled queue, which sends it as its own turn the moment the
 * reply ends if the turn never consumed the offer. Everyone in the chat sees
 * the chip. `queued:false` means no reply is running any more — send it
 * normally.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const access = await chatAccess(body.conversationId, userId);
  if (!access) return Response.json({ error: "Conversation not found." }, { status: 404 });
  if (!hasActiveTurn(body.conversationId)) return Response.json({ queued: false });
  // NB: the turn can end during the awaits below; the enqueue is re-checked
  // after it lands (audit 2026-09-05) — an entry queued just after the drain
  // would otherwise sit until some LATER turn ended and then run out of context.

  const me = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true },
  });
  const id = randomUUID();
  const fileIds = body.fileIds ?? [];
  const steering =
    fileIds.length === 0 && offerInterjection(body.conversationId, { id, userId, content: body.content });
  const origin = req.headers.get("x-oi-client")?.slice(0, 64) || undefined;
  const ok = enqueueMessage({
    id,
    conversationId: body.conversationId,
    userId,
    author: { id: userId, name: displayName(me ?? {}), image: me?.image ?? null },
    content: body.content,
    fileIds,
    extendedThinking: body.extendedThinking === true,
    steering,
    origin,
    createdAt: Date.now(),
  });
  if (!ok) {
    if (steering) withdrawInterjection(body.conversationId, id);
    return Response.json({ error: "Too many messages are already scheduled in this chat." }, { status: 429 });
  }
  if (!hasActiveTurn(body.conversationId)) {
    // The turn ended (and drained the queue) while we were looking the
    // author up — this entry would sit until the NEXT reply ended. Hand the
    // text back so the client sends it as a normal turn instead.
    removeQueued(body.conversationId, id);
    if (steering) withdrawInterjection(body.conversationId, id);
    return Response.json({ queued: false });
  }
  devLog("info", "chat", "message scheduled", {
    conversationId: body.conversationId,
    userId,
    id,
    steering,
    files: fileIds.length,
    content: body.content.slice(0, 200),
  });
  publishToChat(body.conversationId, { type: "queue", items: queueSnapshot(body.conversationId) });
  return Response.json({ queued: true, id, steering });
}

const deleteSchema = z.object({
  conversationId: z.string().uuid(),
  id: z.string().uuid(),
});

/** DELETE /api/chat/queue — cancel a scheduled message: your own, or any as
 *  the owner. Also takes back its steer offer if the turn hasn't used it. */
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof deleteSchema>;
  try {
    body = deleteSchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const access = await chatAccess(body.conversationId, session.user.id);
  if (!access) return Response.json({ error: "Conversation not found." }, { status: 404 });

  const current = queueSnapshot(body.conversationId).find((x) => x.id === body.id);
  if (!current) return Response.json({ cancelled: false });
  if (!canCancelQueued(access.role, current.userId, session.user.id)) {
    return Response.json({ error: "You can only cancel your own scheduled message." }, { status: 403 });
  }
  removeQueued(body.conversationId, body.id);
  withdrawInterjection(body.conversationId, body.id);
  publishToChat(body.conversationId, { type: "queue", items: queueSnapshot(body.conversationId) });
  return Response.json({ cancelled: true });
}
