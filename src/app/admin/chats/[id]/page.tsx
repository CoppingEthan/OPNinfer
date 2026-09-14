import Link from "next/link";
import { orderThreadRows } from "@/lib/thread-order";
import { loadCompaction } from "@/lib/compaction";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-helpers";
import { sudoExpiresAt } from "@/lib/sudo";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { buildChatThread } from "@/lib/chat-thread";
import { peopleById } from "@/lib/chat-access";
import { PageHeader } from "@/components/admin/page-header";
import { SudoBanner } from "@/components/admin/sudo-gate";
import { ChatTranscript } from "@/components/admin/chat-transcript";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chat · Admin" };

export default async function AdminChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await requireAdmin();
  const expiresAt = await sudoExpiresAt(admin.id);
  // No grant → back to the list, which presents the password gate.
  if (!expiresAt) redirect("/admin/chats");

  const convo = await db.conversation.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
      files: { orderBy: { createdAt: "asc" } },
      members: { select: { userId: true } },
    },
  });
  if (!convo || convo.incognito) notFound();
  const rows = orderThreadRows(convo.messages);

  // A shared chat: label who wrote what, exactly as its members see it.
  const shared = convo.members.length > 0;
  const authors = shared
    ? await peopleById([
        convo.user.id,
        ...convo.members.map((m) => m.userId),
        ...rows.map((m) => m.userId).filter((u): u is string => !!u),
      ])
    : undefined;

  // Record the access BEFORE rendering — reading someone's chat is the event
  // worth logging, whether or not the page finishes rendering.
  await audit("admin.view_chat", {
    userId: admin.id,
    details: {
      conversationId: convo.id,
      title: convo.title,
      ownerId: convo.user.id,
      ownerEmail: convo.user.email,
    },
  });

  // Same builder the user's own chat page uses, so this is their exact view.
  // What the assistant is actually sent for this chat (compaction): the
  // divider the user sees, plus the summary itself — a support reader needs
  // to know what the model could and could not see.
  const compaction = await loadCompaction(convo.id, rows);
  const { messages } = buildChatThread(rows, convo.files, {
    authors,
    compactedThroughId: compaction?.boundaryMessageId ?? null,
  });
  const owner = convo.user.name?.trim() || convo.user.email;
  const others = convo.members.length > 0 ? convo.members.length - 1 : 0;

  return (
    <div>
      <PageHeader
        title={convo.title || "Untitled chat"}
        subtitle={`${owner}${others > 0 ? ` · shared with ${others} ${others === 1 ? "person" : "people"}` : ""} · ${messages.length} message${messages.length === 1 ? "" : "s"} · started ${convo.createdAt.toISOString().slice(0, 10)}`}
      />
      <SudoBanner expiresAt={expiresAt} />

      <div className="mb-4">
        <Link
          href={`/admin/chats?user=${convo.user.id}`}
          className="text-sm text-muted underline-offset-2 hover:underline"
        >
          ← All of {owner}&rsquo;s chats
        </Link>
      </div>

      {compaction ? (
        <details className="mb-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm" data-compaction-summary>
          <summary className="cursor-pointer text-muted">
            The assistant sees the first {compaction.messagesCovered} messages only as a summary
            (written {compaction.createdAt.toISOString().slice(0, 10)}) — click to read it
          </summary>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-xs leading-relaxed">{compaction.summary}</pre>
        </details>
      ) : null}
      <ChatTranscript messages={messages} showAuthors={shared} compactedThroughId={compaction?.boundaryMessageId ?? null} />
    </div>
  );
}
