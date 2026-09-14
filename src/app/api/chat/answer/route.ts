import { readJsonBounded } from "@/lib/validation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { answersAsUserMessage, normaliseAnswer, MAX_CUSTOM_CHARS } from "@/lib/ask";
import { peekAsk, settleAsk } from "@/lib/ask-mailbox";
import { chatAccess } from "@/lib/chat-access";
import { displayName } from "@/lib/chat-rules";
import { getTurn, publishTurn } from "@/lib/turn-stream";
import { devLog } from "@/lib/dev-log";
import type { AskAnswer } from "@/lib/ask";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  /** Which card is being answered — a stale card must not resolve a new one. */
  askId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        chosen: z.array(z.string().max(MAX_CUSTOM_CHARS)).max(8).optional(),
        skipped: z.boolean().optional(),
      }),
    )
    .max(8),
});

/**
 * POST /api/chat/answer — deliver the user's answer to a waiting `ask_user`
 * card, un-pausing the reply that is parked on it.
 *
 * Deliberately NOT drain-guarded: a turn that is already running must be able
 * to finish, which is the same reason resume/stop/interject stay open while an
 * update drains the instance.
 *
 * The chosen answer is persisted as a real user message. That is what the
 * transcript shows, and — more importantly — it is what LATER turns replay:
 * only user/assistant rows are fed back to the model, so without it the
 * assistant would forget its own question's answer on the very next message.
 * The tool result carries the answers within THIS turn, so the row is not
 * pushed into the live transcript as well.
 *
 * In a shared chat ANYONE in it may answer; the first answer settles the card
 * and every screen sees "Answered by …" (the `by` on the events).
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

  const access = await chatAccess(body.conversationId, session.user.id);
  if (!access) return Response.json({ error: "Conversation not found." }, { status: 404 });

  const waiting = peekAsk(body.conversationId);
  if (!waiting || waiting.id !== body.askId) {
    // The turn ended, was stopped, or the card timed out. Say so plainly so
    // the client can retire the card instead of leaving it clickable forever.
    devLog("info", "chat", "answer for a question that is no longer waiting", {
      conversationId: body.conversationId,
      askId: body.askId,
    });
    return Response.json({ error: "That question is no longer waiting.", stale: true }, { status: 409 });
  }

  // Normalise against what was actually ASKED: unoffered labels are recorded
  // as free text rather than trusted as choices, and a question the client
  // omitted counts as skipped.
  const answers: AskAnswer[] = waiting.questions.map((q, i) =>
    normaliseAnswer(q, body.answers[i] ?? { skipped: true }),
  );

  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true },
  });
  const by = { id: session.user.id, name: displayName(me ?? {}) };

  const content = answersAsUserMessage(answers);
  // `meta.askAnswer` marks this row as "already shown by the question card".
  // The row itself is load-bearing (see the note above — later turns replay
  // only user/assistant rows), but rendering it as its own bubble would put
  // the answer ABOVE the question that asked for it: the answer is persisted
  // mid-turn while the reply is only saved when the turn ends, so it sorts
  // first. The card already shows the chosen answer inline, in the position it
  // was asked, so the extra bubble is redundant as well as misplaced.
  const saved = await db.message.create({
    data: {
      conversationId: body.conversationId,
      role: "user",
      content,
      userId: session.user.id,
      meta: { askAnswer: true },
    },
  });

  // Publish the bubble through the TURN stream rather than returning it for the
  // caller to insert: every attached client (a second tab, a session that
  // resumes later) then sees the same thing, and the replay buffer carries it
  // across a refresh. Published BEFORE settling, so it is buffered ahead of the
  // `ask_done` the pipeline emits as soon as the tool returns.
  const turn = getTurn(body.conversationId);
  if (turn) {
    publishTurn(turn, {
      type: "ask_answer",
      askId: body.askId,
      messageId: saved.id,
      content,
      by,
    });
  }

  const delivered = settleAsk(body.conversationId, body.askId, answers, by);
  devLog("info", "chat", "question answered", {
    conversationId: body.conversationId,
    askId: body.askId,
    by: by.id,
    delivered,
    answers: answers.map((a) => `${a.header}: ${a.chosen.join(", ") || "(skipped)"}`),
  });

  return Response.json({ ok: delivered, messageId: saved.id, content });
}
