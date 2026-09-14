import { readJsonBounded } from "@/lib/validation";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { chatWhereFor } from "@/lib/chat-access";
import { getAssistantConfig } from "@/lib/assistant";
import { generateFollowups, recordUsage } from "@/lib/pipeline";
import type { ChatMessage } from "@/lib/providers/types";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const bodySchema = z.object({ conversationId: z.string().uuid() });

/**
 * Front-end model: 3 follow-up suggestions for an idle conversation. Called by
 * the chat client after a period of inactivity (spec: front-end behaviours).
 *
 * Generated suggestions are PERSISTED on the newest assistant reply
 * (`meta.followups`) and served from there on later calls, so they survive
 * navigating away and back (the chat window remounts per conversation) and a
 * conversation is only ever billed one generation per reply. A new exchange
 * makes the stored set stale naturally — it no longer rides the last message.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const convo = await db.conversation.findFirst({
    where: { id: body.conversationId, ...chatWhereFor(userId) },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 12 } },
  });
  if (!convo) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }

  // Suggestions belong to the conversation's FINAL message, and only when
  // that's an assistant reply (mid-exchange there's nothing to suggest).
  const newest = convo.messages[0];
  const carrier = newest?.role === "assistant" ? newest : null;
  const stored =
    carrier && carrier.meta && typeof carrier.meta === "object" && !Array.isArray(carrier.meta)
      ? (carrier.meta as { followups?: unknown }).followups
      : null;
  if (Array.isArray(stored) && stored.length > 0) {
    return Response.json({ suggestions: stored.slice(0, 3) });
  }

  const history: ChatMessage[] = convo.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .reverse()
    .map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
  if (history.length === 0) return Response.json({ suggestions: [] });

  const config = await getAssistantConfig();
  const result = await generateFollowups(config, history);
  if (result?.usage) {
    await recordUsage({
      userId,
      role: "frontend",
      provider: result.role.provider,
      model: result.role.model,
      usage: result.usage,
    });
  }

  const suggestions = result?.suggestions ?? [];
  if (carrier && suggestions.length > 0) {
    const meta: Record<string, unknown> =
      carrier.meta && typeof carrier.meta === "object" && !Array.isArray(carrier.meta)
        ? { ...(carrier.meta as Record<string, unknown>) }
        : {};
    meta.followups = suggestions;
    await db.message
      .update({ where: { id: carrier.id }, data: { meta: meta as Prisma.InputJsonValue } })
      .catch(() => {}); // reply vanished mid-flight (deleted chat) — fine
  }
  return Response.json({ suggestions });
}
