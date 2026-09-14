"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import { audit } from "@/lib/audit";
import { messageWhereFor } from "@/lib/chat-access";
import { recordFeedback } from "@/lib/feedback";

export type Rating = "up" | "down";

/**
 * Record (or clear) a person's thumbs-up/down on an assistant reply.
 *
 * Ratings are PER PERSON since v0.5 (shared chats — two people can rate the
 * same reply differently): stored under `meta.ratings[userId]`. The old
 * single `meta.rating` is kept in step for the chat's OWNER only, so nothing
 * that reads it (older rows, exports) changes meaning. Mirrored to the audit
 * log so admins can see reply-quality signal. `null` clears your own rating.
 */
export async function rateMessage(
  messageId: string,
  rating: Rating | null,
): Promise<{ ok: boolean }> {
  const user = await requireUser();

  const msg = await db.message.findFirst({
    where: { id: messageId, role: "assistant", ...messageWhereFor(user.id) },
    select: { id: true, meta: true, conversation: { select: { userId: true } } },
  });
  if (!msg) return { ok: false };

  const meta: Record<string, unknown> =
    msg.meta && typeof msg.meta === "object" && !Array.isArray(msg.meta)
      ? { ...(msg.meta as Record<string, unknown>) }
      : {};
  const ratings: Record<string, Rating> =
    meta.ratings && typeof meta.ratings === "object" && !Array.isArray(meta.ratings)
      ? { ...(meta.ratings as Record<string, Rating>) }
      : {};
  if (rating) ratings[user.id] = rating;
  else delete ratings[user.id];
  if (Object.keys(ratings).length > 0) meta.ratings = ratings;
  else delete meta.ratings;
  if (msg.conversation.userId === user.id) {
    if (rating) meta.rating = rating;
    else delete meta.rating;
  }

  await db.message.update({
    where: { id: msg.id },
    data: { meta: meta as Prisma.InputJsonValue },
  });

  await audit("message.rate", {
    userId: user.id,
    details: { messageId: msg.id, rating },
  });

  // Admin → Feedback: snapshot the exchange + kick off the AI "why" analysis
  // (the entry survives chat deletion; the summary generates in the background).
  await recordFeedback(user.id, msg.id, rating);

  return { ok: true };
}
