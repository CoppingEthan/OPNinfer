import { auth } from "@/auth";
import { orderThreadRows } from "@/lib/thread-order";
import { db } from "@/lib/db";
import { chatWhereFor } from "@/lib/chat-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/conversations/:id/export — download a conversation as JSON (spec:
 * chat kebab → Download). Anyone in the chat (owner or member) may export it.
 * Generated on the fly.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const convo = await db.conversation.findFirst({
    where: { id, ...chatWhereFor(session.user.id) },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { name: true, email: true } } },
      },
    },
  });
  if (!convo) return new Response("Not found", { status: 404 });

  const payload = {
    id: convo.id,
    title: convo.title,
    createdAt: convo.createdAt.toISOString(),
    updatedAt: convo.updatedAt.toISOString(),
    messages: orderThreadRows(convo.messages).map((m) => ({
      role: m.role,
      content: m.content,
      model: m.model,
      provider: m.provider,
      // Who wrote a user turn (shared chats) — name, else email; absent on
      // assistant rows and on rows whose author's account is gone.
      ...(m.author ? { author: m.author.name?.trim() || m.author.email } : {}),
      createdAt: m.createdAt.toISOString(),
    })),
  };

  const safe = convo.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "chat";
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
