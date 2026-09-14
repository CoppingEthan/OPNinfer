import { CompactionDivider } from "@/components/chat/compaction-divider";
import { MessageBubble, type UIMessage } from "@/components/chat/message-bubble";

/**
 * Read-only replay of someone else's conversation, rendered with the REAL chat
 * component so an admin sees exactly what the user saw — same bubbles, tool-run
 * chips, generated images, visualisations, attachments and sources. Styling
 * lives in one place (`message-bubble.tsx`); this only supplies the thread
 * container the chat window would normally provide.
 *
 * Read-only falls out of the component's own contract rather than a flag:
 * `MessageBubble` gates Retry on `onRetry`, Edit on `onEdit` and the rating
 * buttons on `onRate`. Passing none of them means there is nothing here that
 * can mutate the conversation — Copy, timestamps and the sources panel are all
 * that remain interactive.
 */
export function ChatTranscript({
  messages,
  showAuthors = false,
  compactedThroughId = null,
}: {
  messages: UIMessage[];
  /** A shared chat: label who wrote each human message (v0.5). */
  showAuthors?: boolean;
  /** Conversation compaction: draw the divider after this message. */
  compactedThroughId?: string | null;
}) {
  if (messages.length === 0) {
    return (
      <p className="rounded-2xl border border-border bg-surface p-6 text-center text-sm text-muted">
        This conversation has no messages.
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-background py-6">
      <div className="mx-auto w-full max-w-[800px] space-y-4 px-4">
        {messages.map((m, i) => (
          <div key={m.id} className="space-y-4">
            <MessageBubble message={m} isLast={i === messages.length - 1} showAuthor={showAuthors} />
            {compactedThroughId && (m.dbId ?? m.id) === compactedThroughId ? <CompactionDivider /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
