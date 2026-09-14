import { readJsonBounded } from "@/lib/validation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { chatAccess } from "@/lib/chat-access";
import { offerInterjection } from "@/lib/interject";
import { devLog } from "@/lib/dev-log";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(8_000),
});

/**
 * POST /api/chat/interject — offer a message typed while a turn is streaming
 * for MID-TURN injection (the tool loops drain it between rounds, so "actually
 * October, direct only" course-corrects the running task instead of waiting
 * for the wrong answer to finish). `accepted:false` → no turn is listening.
 *
 * The chat window itself now goes through POST /api/chat/queue, which offers
 * the message here AND holds it in the server-side scheduled queue (so an
 * offer a prose reply never consumes is still sent afterwards). This route
 * stays as the bare offer for anything that only wants the steer.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Anyone in the chat may steer its running turn.
  const access = await chatAccess(body.conversationId, session.user.id);
  if (!access) return Response.json({ error: "Conversation not found." }, { status: 404 });

  const accepted = offerInterjection(body.conversationId, {
    id: randomUUID(),
    userId: session.user.id,
    content: body.content,
  });
  devLog("info", "chat", "interjection offered", {
    conversationId: body.conversationId,
    userId: session.user.id,
    accepted,
    content: body.content.slice(0, 200),
  });
  return Response.json({ accepted });
}
