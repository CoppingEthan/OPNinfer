import { readJsonBounded } from "@/lib/validation";
import { z } from "zod";
import { auth } from "@/auth";
import { chatAccess } from "@/lib/chat-access";
import { abortTurn } from "@/lib/turn-stream";
import { devLog } from "@/lib/dev-log";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ conversationId: z.string().uuid() });

/**
 * POST /api/chat/stop — stop the conversation's running turn. Generation is
 * detached from the client connection (resumable streams), so the stop button
 * can't work by aborting its fetch any more — that would merely detach. This
 * aborts the TURN: the provider call gets an AbortError, the pipeline winds
 * down, and the route saves the partial text (same semantics the old
 * fetch-abort had) and emits `done` to every attached subscriber.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Anyone in the chat may stop its running reply (shared chats: a member
  // watching a runaway task must not have to wait for the owner).
  const access = await chatAccess(body.conversationId, session.user.id);
  if (!access) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  const stopped = abortTurn(body.conversationId);
  devLog("info", "chat", "stop requested", {
    userId: session.user.id,
    conversationId: body.conversationId,
    stopped,
  });
  return Response.json({ stopped });
}
