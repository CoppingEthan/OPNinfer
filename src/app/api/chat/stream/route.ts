import { auth } from "@/auth";
import { chatAccess } from "@/lib/chat-access";
import { getTurn, turnStreamResponse } from "@/lib/turn-stream";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * GET /api/chat/stream?conversationId= — re-attach to a turn that's still
 * generating (or finished within the grace window). Replays every event
 * buffered so far, then follows live — so a user who navigated away, switched
 * chats, refreshed, or opened a second tab picks the stream up exactly where
 * it left off. 204 when there's nothing to resume (the loader already has the
 * saved reply).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
    return new Response(null, { status: 204 });
  }

  const turn = getTurn(conversationId);
  if (!turn) return new Response(null, { status: 204 });

  // Access: the registry is app-wide — never attach a user to a stream they
  // may not read. Anyone in the chat (owner or member) may follow it.
  const access = await chatAccess(conversationId, session.user.id);
  if (!access) return new Response(null, { status: 204 });

  return turnStreamResponse(turn, req.signal);
}
