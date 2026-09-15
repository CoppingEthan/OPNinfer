/**
 * Workflows live inside the CHAT shell, not a shell of their own: the sidebar
 * is how you get here and how you get back, and a page that threw it away
 * would feel like leaving the app to edit a setting.
 */
import { requireUser } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { ChatShell } from "@/components/chat/chat-shell";
import { sidebarFolders, sidebarItems } from "@/lib/chat-items";

export const dynamic = "force-dynamic";

export default async function WorkflowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const [conversations, folders, me] = await Promise.all([
    // Your own chats and the ones shared with you; incognito never listed.
    sidebarItems(user.id),
    sidebarFolders(user.id),
    db.user.findUnique({ where: { id: user.id }, select: { name: true, image: true } }),
  ]);

  return (
    <ChatShell
      conversations={conversations}
      folders={folders}
      userId={user.id}
      email={user.email ?? ""}
      name={me?.name ?? undefined}
      role={user.role}
      image={me?.image ?? undefined}
      isAdmin={user.role === "admin"}
    >
      {children}
    </ChatShell>
  );
}
