import { db } from "./db";
import { orderThreadRows } from "@/lib/thread-order";
import { getAssistantConfig } from "./assistant";
import { runCompletion, recordUsage } from "./pipeline";
import { devLog } from "./dev-log";
import type { Rating } from "@/app/actions/messages";

/**
 * Thumbs-rating feedback loop (Admin → Feedback).
 *
 * The rated message is ephemeral (cascade-deletes with its conversation), so
 * the exchange is snapshotted into the permanent `message_feedback` table at
 * rating time, and the FRONTEND (cheap) role writes a short "why" analysis of
 * the conversation for the admin — asynchronously, so the thumb click stays
 * instant.
 */

const USER_EXCERPT_CHARS = 2_000;
const REPLY_EXCERPT_CHARS = 4_000;
const TRANSCRIPT_TURNS = 8;
const TRANSCRIPT_TURN_CHARS = 1_200;
const SUMMARY_MAX_CHARS = 1_500;

/** Create/update (or clear, when rating is null) the feedback entry for a
 *  rated reply. DB work is awaited; the AI analysis runs fire-and-forget. */
export async function recordFeedback(
  userId: string,
  messageId: string,
  rating: Rating | null,
): Promise<void> {
  if (!rating) {
    // Only THIS person's entry — in a shared chat a colleague's rating of the
    // same reply stands.
    await db.messageFeedback.deleteMany({ where: { messageId, userId } });
    return;
  }

  const msg = await db.message.findUnique({
    where: { id: messageId },
    include: {
      conversation: {
        select: { id: true, title: true, messages: { orderBy: { createdAt: "asc" } } },
      },
    },
  });
  if (!msg || msg.role !== "assistant") return;

  const turns = orderThreadRows(msg.conversation.messages).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const idx = turns.findIndex((m) => m.id === messageId);
  const upto = idx >= 0 ? turns.slice(0, idx + 1) : turns;
  const prevUser = [...upto].reverse().find((m) => m.role === "user");

  const row = await db.messageFeedback.upsert({
    // One entry per (reply, rater) since v0.5 — two people in a shared chat
    // can rate the same reply differently.
    where: { messageId_userId: { messageId, userId } },
    create: {
      messageId,
      conversationId: msg.conversation.id,
      conversationTitle: msg.conversation.title,
      userId,
      rating,
      model: msg.model,
      provider: msg.provider,
      userText: (prevUser?.content ?? "").slice(0, USER_EXCERPT_CHARS),
      assistantText: msg.content.slice(0, REPLY_EXCERPT_CHARS),
    },
    // Rating flipped (up↔down) → the old analysis is stale; clear + regenerate.
    update: { rating, userId, summary: null },
  });

  void generateFeedbackSummary(row.id, upto, rating, userId).catch((e) => {
    devLog("warn", "feedback", "summary generation failed", {
      feedbackId: row.id,
      error: e instanceof Error ? e.message : String(e),
    });
  });
}

/** Frontend-role pass over the conversation: why did this rating happen? */
async function generateFeedbackSummary(
  feedbackId: string,
  turns: { role: string; content: string }[],
  rating: Rating,
  userId: string,
): Promise<void> {
  const frontend = (await getAssistantConfig()).roles.frontend;
  if (!frontend) return; // no cheap model bound — the raw exchange still shows

  const transcript = turns
    .slice(-TRANSCRIPT_TURNS)
    .map((m) => {
      const text =
        m.content.length > TRANSCRIPT_TURN_CHARS
          ? m.content.slice(0, TRANSCRIPT_TURN_CHARS) + " …[truncated]"
          : m.content;
      return `${m.role === "user" ? "USER" : "ASSISTANT"}: ${text}`;
    })
    .join("\n\n");

  const { text, usage } = await runCompletion(
    frontend,
    [
      {
        role: "system",
        content:
          "You are a QA analyst for an AI assistant deployment. A user rated one of the assistant's replies. In 2–4 plain sentences for the ADMIN, explain: what the user was trying to do, what the rated reply did well or poorly, and the most likely reason for the rating. Be specific and neutral. Do not address the user, do not use headings or lists.",
      },
      {
        role: "user",
        content: `${transcript}\n\n---\nThe user rated the FINAL assistant reply above: ${rating === "up" ? "THUMBS UP (good response)" : "THUMBS DOWN (bad response)"}. Why, most likely?`,
      },
    ],
    400,
  );

  if (usage) {
    await recordUsage({
      userId,
      role: "frontend",
      provider: frontend.provider,
      model: frontend.model,
      usage,
    });
  }
  const summary = text.trim().slice(0, SUMMARY_MAX_CHARS);
  if (summary) {
    await db.messageFeedback.update({ where: { id: feedbackId }, data: { summary } });
  }
}
