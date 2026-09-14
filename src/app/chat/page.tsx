import { ChatWindow } from "@/components/chat/chat-window";
import { getAssistantIdentity } from "@/lib/assistant";
import { getUsageVisibility, showUsageStats } from "@/lib/prefs";
import { requireUser } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { displayName } from "@/lib/chat-rules";

export const dynamic = "force-dynamic";

export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ incognito?: string }>;
}) {
  const user = await requireUser();
  const { incognito } = await searchParams;
  const [assistant, me, usageVisibility] = await Promise.all([
    getAssistantIdentity(),
    db.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, image: true } }),
    getUsageVisibility(),
  ]);
  const userName = me?.name || me?.email?.split("@")[0] || undefined;

  return (
    <ChatWindow
      key={incognito === "1" ? "incognito" : "new"}
      conversationId={null}
      initialMessages={[]}
      assistant={assistant}
      userName={userName}
      me={{ id: user.id, name: displayName(me ?? { email: user.email }), image: me?.image ?? null }}
      role="owner"
      incognito={incognito === "1"}
      showUsage={showUsageStats(usageVisibility, user.role === "admin")}
      ttsEnabled={!!process.env.TTS_URL}
    />
  );
}
