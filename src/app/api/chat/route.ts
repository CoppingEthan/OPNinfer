import { readJsonBounded } from "@/lib/validation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { devLog } from "@/lib/dev-log";
import { drainResponse, isDraining } from "@/lib/drain";
import { startChatTurn } from "@/lib/chat-turn";
import { turnStreamResponse } from "@/lib/turn-stream";

export const dynamic = "force-dynamic";
// Streaming responses must not be statically cached or buffered.
export const fetchCache = "force-no-store";

const bodySchema = z
  .object({
    conversationId: z.string().uuid().nullable().optional(),
    content: z.string().trim().max(100_000).optional(),
    /** Files uploaded via /api/files, attached to this turn (manifest/vision). */
    fileIds: z.array(z.string().uuid()).max(20).optional(),
    /** User toggled "think harder" — server swaps to the admin's extended level. */
    extendedThinking: z.boolean().optional(),
    /** Ephemeral chat — flagged so it's auto-deleted on leave and hidden from the sidebar. */
    incognito: z.boolean().optional(),
    /** Retry: regenerate the last assistant reply (no new user turn is added). */
    regenerate: z.boolean().optional(),
    /** Edit-and-revert: PERMANENTLY delete this user message and everything
     *  after it (including files attached to the removed turns), then send
     *  `content` (+ kept `fileIds`) as the new turn from that point. */
    editMessageId: z.string().uuid().optional(),
    /** The person picked one of their own workflows from the composer's +
     *  menu. Unlike the per-turn WORKFLOWS list, which the model may or may
     *  not act on, this one is loaded and injected as an instruction — the
     *  whole point of choosing it by hand is that it is not a suggestion. */
    workflowId: z.string().uuid().optional(),
  })
  .refine(
    (d) => (d.regenerate ? !!d.conversationId : !!d.content && d.content.trim().length > 0),
    { message: "Message cannot be empty." },
  )
  .refine((d) => !(d.editMessageId && d.regenerate), {
    message: "editMessageId and regenerate are mutually exclusive.",
  })
  .refine((d) => !d.editMessageId || !!d.conversationId, {
    message: "editMessageId requires a conversationId.",
  });

/**
 * POST /api/chat — start an assistant turn and stream it back as SSE.
 *
 * The turn itself lives in `src/lib/chat-turn.ts` (v0.5: the scheduled queue
 * starts turns too, with no request behind them). This route authenticates,
 * validates, hands over, and then merely SUBSCRIBES to the resumable stream —
 * generation runs detached, so a client that leaves only detaches.
 *
 * `X-OI-Client` is the sending tab's id: the live feed skips echoing that
 * tab's own message and "reply started" back to it.
 */
export async function POST(req: Request) {
  // Mid-deploy: refuse to START a reply that the imminent restart would kill.
  // Turns already running are untouched, and the endpoints they depend on
  // (resume, stop, interject) stay open — see src/lib/drain.ts.
  if (isDraining()) return drainResponse();

  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  void db.user
    .update({ where: { id: userId }, data: { lastActiveAt: new Date() } })
    .catch(() => {});

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readJsonBounded(req));
  } catch (e) {
    const message =
      e instanceof z.ZodError ? e.issues[0]?.message : "Invalid request body.";
    // Say WHICH field and WHY: a bare "Invalid request body" once cost a
    // debugging round when a harness's post-Stop message was refused.
    devLog("warn", "chat", "bad request body", {
      userId,
      error: message,
      issues:
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          : [e instanceof Error ? e.message : String(e)],
    });
    return Response.json({ error: message }, { status: 400 });
  }

  const origin = req.headers.get("x-oi-client")?.slice(0, 64) || undefined;
  const started = await startChatTurn({
    ...body,
    conversationId: body.conversationId ?? null,
    userId,
    origin,
  });
  if (!started.ok) {
    return Response.json({ error: started.error }, { status: started.status });
  }
  return turnStreamResponse(started.turn, req.signal);
}
