import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { ChatWindow } from "@/components/chat/chat-window";
import { getAssistantIdentity } from "@/lib/assistant";
import { getUsageVisibility, showUsageStats } from "@/lib/prefs";
import { chatWhereFor } from "@/lib/chat-access";
import { loadChatView } from "@/lib/chat-view";
import { displayName } from "@/lib/chat-rules";

export const dynamic = "force-dynamic";

/**
 * The conversation's own name in the browser tab (the root layout supplies the
 * "· OPNinfer" half via its title template).
 *
 * Access is re-checked here rather than trusting the id in the URL:
 * generateMetadata runs independently of the page, so the page's own check
 * does not cover it, and a title is small but it is still someone else's.
 * Members of a shared chat see its title like the owner does.
 *
 * Any failure returns {} and falls back to the bare app name — a tab title is
 * never worth breaking the page for.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const user = await requireUser();
    const convo = await db.conversation.findFirst({
      where: { id, ...chatWhereFor(user.id) },
      select: { title: true },
    });
    return convo?.title ? { title: convo.title } : {};
  } catch {
    return {};
  }
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  // Shared with the admin support viewer and the live reload endpoint
  // (src/lib/chat-view.ts → chat-thread.ts) so the renderings never drift.
  const view = await loadChatView(id, user.id);
  if (!view) notFound();

  const [assistant, usageVisibility, me] = await Promise.all([
    getAssistantIdentity(),
    getUsageVisibility(),
    db.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, image: true } }),
  ]);

  return (
    <ChatWindow
      key={view.id}
      conversationId={view.id}
      initialMessages={view.messages}
      initialPending={view.pending}
      initialFollowups={view.followups.slice(0, 3)}
      initialCompactedThroughId={view.compactedThroughId}
      initialQueue={view.queue}
      assistant={assistant}
      userName={me?.name || user.email?.split("@")[0]}
      me={{ id: user.id, name: displayName(me ?? { email: user.email }), image: me?.image ?? null }}
      role={view.access.role}
      shared={view.access.shared}
      showUsage={showUsageStats(usageVisibility, user.role === "admin")}
      ttsEnabled={!!process.env.TTS_URL}
    />
  );
}
