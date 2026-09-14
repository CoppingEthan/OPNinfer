import { auth } from "@/auth";
import { subscribeLogs } from "@/lib/applog";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** SSE stream of live application-log events (admin only). */
export async function GET(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: "ready" });
      const unsub = subscribeLogs((e) => send({ type: "log", event: e }));
      // Heartbeat keeps the connection open through proxies.
      const hb = setInterval(() => send({ type: "ping" }), 25_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsub();
        clearInterval(hb);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
