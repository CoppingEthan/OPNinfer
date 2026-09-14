import { auth } from "@/auth";
import { loadChatView } from "@/lib/chat-view";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * GET /api/chat/thread?conversationId= — the chat as this person sees it,
 * as JSON (v0.5). The chat page renders the same shape server-side; this is
 * for the open screen to RELOAD itself when the live feed says the transcript
 * changed under it (someone edited or retried) or after a reconnect, without
 * a full page load. 404 when the person may not see the chat any more.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const conversationId = new URL(req.url).searchParams.get("conversationId");
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
    return Response.json({ error: "conversationId required." }, { status: 400 });
  }
  const view = await loadChatView(conversationId, session.user.id);
  if (!view) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(
    {
      id: view.id,
      title: view.title,
      role: view.access.role,
      shared: view.access.shared,
      ownerId: view.access.ownerId,
      messages: view.messages,
      pending: view.pending,
      followups: view.followups.slice(0, 3),
      queue: view.queue,
      people: view.people,
      compactedThroughId: view.compactedThroughId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
