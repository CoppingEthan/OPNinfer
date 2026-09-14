import { auth } from "@/auth";
import { db } from "@/lib/db";
import { chatAccess } from "@/lib/chat-access";
import { broadcastPresence, subscribeLive, type LiveEvent } from "@/lib/live";
import { devLog } from "@/lib/dev-log";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/chat/live?viewing=<conversationId>&client=<tabId> — the per-tab
 * live feed (v0.5 shared chats; see src/lib/live.ts for the event fan-out).
 *
 * One connection per open chat tab, held for as long as the tab is on the
 * chat pages; the tab reconnects with a new `viewing` when it moves between
 * chats. Sidebar-level events (a chat shared with you, one taken away,
 * activity, titles, deletions) arrive whatever you are looking at; chat-level
 * events (someone's message, a reply started, the queue, people, presence)
 * only for the chat you are viewing — and only if you may see it.
 *
 * Opening a shared chat marks it READ for you (the sidebar's unread dot), as
 * does each reply that lands while you are looking at it.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const url = new URL(req.url);
  const rawViewing = url.searchParams.get("viewing");
  const clientId = (url.searchParams.get("client") ?? "").slice(0, 64) || "anon";

  let viewing: string | null = null;
  if (rawViewing && /^[0-9a-f-]{36}$/i.test(rawViewing)) {
    const access = await chatAccess(rawViewing, userId);
    if (access) viewing = access.id;
  }

  const markRead = async () => {
    if (!viewing) return;
    await db.conversationMember
      .updateMany({ where: { conversationId: viewing, userId }, data: { lastReadAt: new Date() } })
      .catch(() => {});
  };
  await markRead();

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (ev: LiveEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          closed = true;
        }
      };
      unsubscribe = subscribeLive({
        userId,
        clientId,
        viewing,
        send: (ev) => {
          write(ev);
          // A reply landing in the chat this tab is looking at: read.
          if (ev.type === "activity" && ev.conversationId === viewing) void markRead();
        },
      });
      write({ type: "hello", viewing, clientId });
      if (viewing) broadcastPresence(viewing);
      heartbeat = setInterval(() => write({ type: "ping" }), HEARTBEAT_MS);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      if (viewing) broadcastPresence(viewing);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (viewing) broadcastPresence(viewing);
    devLog("debug", "chat", "live feed detached", { userId, viewing, clientId });
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
