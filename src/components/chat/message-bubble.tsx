"use client";

import {
  Component,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { THINKING_WORDS } from "@/lib/thinking-words";
import { VizFrame, type VizData } from "./viz-frame";
import { segmentReply } from "@/lib/reply-timeline";
import { summariseAnswer, type AskRecord } from "@/lib/ask";
import { ToolRunBlock, type ToolRunUI } from "./tool-run";
import { FileChip, FileContextModal, type Attachment } from "./file-chip";
import { GeneratedImage, type GenImage } from "./generated-image";
import { GeneratedFiles } from "./generated-files";
import { Avatar } from "./avatar";
import { shortName } from "@/lib/chat-rules";

/** A resource a tool touched — rendered as a clickable source. Web sources
 *  open the URL in a new tab; file sources open the in-app context viewer
 *  (the exact prepared text the assistant read). */
export interface SourceRef {
  url: string;
  title?: string;
  kind?: "web" | "file";
  fileId?: string;
}

/** One entry in a reply's live activity area (order = invocation order).
 *  `at` = reply-text length when the item was emitted — the timeline splits
 *  the prose there so narration between tool rounds stays in true order. */
export type ActivityItem =
  | { kind: "status"; label: string; at?: number }
  | { kind: "run"; run: ToolRunUI; at?: number }
  /** A question the assistant paused to ask (ask_user). The LIVE card lives
   *  above the composer; this is the record left in the reply, so a reload
   *  still shows what was asked next to the answer the user gave. */
  | { kind: "ask"; ask: AskRecord; at?: number }
  /** Deliverables surfaced mid-turn, at the point they were presented (owner
   *  ask 2026-09-02): an inline image (by genImages id) or download cards
   *  (by file ids). Rendered in place; images/files NOT referenced by an
   *  item keep the old placement (above / below the reply). */
  | { kind: "image"; id: string; at?: number }
  | { kind: "files"; ids: string[]; at?: number };

export interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Persisted DB id — needed to rate a reply or edit-revert a user turn. Set
   *  from the stream (`done`/`meta` events) or when loading a conversation. */
  dbId?: string;
  /** When the message was sent/received (ISO) — shown on hover. */
  createdAt?: string;
  /** Thumbs up/down the user has given this reply. */
  rating?: "up" | "down" | null;
  /** Live reasoning summary (Anthropic/Google). Captured but no longer shown —
   *  the animated status indicator stands in for it. */
  thinking?: string;
  /** Pipeline notice shown above the reply (e.g. escalation / failover). */
  notice?: string;
  /** Pre-model phase shown IN the thinking indicator (e.g. attachment
   *  ingestion: "Processing voice-note.m4a…"); null/absent → random gerund. */
  phase?: string | null;
  /** Live tool activity, in invocation order: plain status lines
   *  ("Searching the web…") interleaved with rich run blocks (the sandbox
   *  family's live code/console previews → collapsed diff/runtime chips). */
  activity?: ActivityItem[];
  /** Web sources the assistant touched (persisted via message meta). */
  sources?: SourceRef[];
  /** Inline visualisations extracted from the reply (sandboxed iframes). */
  viz?: VizData[];
  /** Files riding this message — the user's attachments on a user turn,
   *  assistant-generated outputs on a reply (linked via meta.fileIds). */
  files?: Attachment[];
  /** Images the assistant generated this turn (placeholder → blur-in). */
  genImages?: GenImage[];
  /** Who wrote a user turn — set in SHARED chats (v0.5) so every screen can
   *  label the bubble with an avatar and name. */
  author?: { id: string; name: string; image?: string | null };
}

/** Isolates rich media (generated images/files) so a render error there can
 *  never blank the whole chat page — the rest of the reply still shows. */
class MediaBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return <p className="mt-2 text-xs text-muted">(Couldn&apos;t display this attachment.)</p>;
    }
    return this.props.children;
  }
}

/**
 * One message. Memoised — see `MessageBubble` at the bottom of this file.
 */
function MessageBubbleImpl({
  message,
  streaming,
  isLast = false,
  laterCount = 0,
  canListen = false,
  showAuthor = false,
  onRetry,
  onRate,
  onEdit,
}: {
  message: UIMessage;
  streaming?: boolean;
  /** Is this the last message in the thread? Controls Retry + always-on actions. */
  isLast?: boolean;
  /** Messages after this one — the edit form warns they'll be removed. */
  laterCount?: number;
  /** TTS engine available → offer the Listen button on finished replies. */
  canListen?: boolean;
  /** Shared chat: label each human message with who wrote it. */
  showAuthor?: boolean;
  /** Regenerate this reply (only wired for the last assistant message). */
  onRetry?: () => void;
  /** Persist a thumbs up/down (null clears it). */
  onRate?: (rating: "up" | "down" | null) => void;
  /** Edit-and-revert this user turn (permanently discards later messages). */
  onEdit?: (content: string, keptFileIds: string[]) => void;
}) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);

  // Paced reveal (§15): decouple the network arrival from the display. The
  // stream (which for Anthropic lands in big multi-word bursts) is drained
  // word-by-word at a rate that tracks the true token rate, so it always looks
  // fluid — fast models wash in quickly, slow ones trickle. The reveal keeps
  // running for a beat after `streaming` flips false to finish draining, then
  // the message re-renders as full markdown.
  const revealed = usePacedReveal(message.content, !!streaming);
  const caughtUp = revealed >= message.content.length;
  const revealing = !!streaming || !caughtUp;
  // Trim the trailing partial word so words only ever appear whole (never a
  // half-typed tail that would flicker). `displayText` is only shown while
  // revealing; once done, the full content re-renders as markdown below.
  const displayText = message.content.slice(0, revealed).replace(/\S+$/, "");

  return (
    <div
      data-role={message.role}
      className={`group/msg flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      {/* `min-w-0` is load-bearing: a flex item defaults to `min-width: auto`,
          so without it the bubble refuses to shrink below the width of a long
          unbroken string and the whole thread scrolls sideways. */}
      <div
        className={
          isUser
            ? "flex min-w-0 max-w-[85%] flex-col items-end"
            : "w-full min-w-0 text-foreground"
        }
      >
        {!isUser && message.notice ? (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
            {message.notice}
          </div>
        ) : null}
        {isUser ? (
          editing ? (
            <EditMessageForm
              message={message}
              laterCount={laterCount}
              onCancel={() => setEditing(false)}
              onSave={(content, keptFileIds) => {
                setEditing(false);
                onEdit?.(content, keptFileIds);
              }}
            />
          ) : (
            <>
              {showAuthor && message.author ? <AuthorLabel author={message.author} /> : null}
              {/* Attachments sit ABOVE the bubble but OUTSIDE it (no grey box). */}
              {message.files?.length ? (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {message.files.map((f) => (
                    <FileChip key={f.id} file={f} download />
                  ))}
                </div>
              ) : null}
              {message.content ? (
                <div className="max-w-full rounded-3xl bg-surface px-4 py-2.5 text-foreground">
                  {/* overflow-wrap:anywhere, not break-words — only `anywhere`
                      shrinks min-content, which is what the flex parent sizes
                      to. See the note on `.markdown` in globals.css. */}
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed">
                    {message.content}
                  </p>
                </div>
              ) : null}
              <UserMessageActions
                content={message.content}
                createdAt={message.createdAt}
                canEdit={!!onEdit}
                onEdit={() => setEditing(true)}
              />
            </>
          )
        ) : (
          <>
            {/* Images/files with a timeline position render INSIDE the
                timeline (where they were presented); only unpositioned ones
                — pre-2026-09-02 rows — keep the old above/below placement. */}
            {looseImages(message).length ? (
              <MediaBoundary>
                <div className="flex flex-col gap-1">
                  {looseImages(message).map((img) => (
                    <GeneratedImage key={img.id} image={img} />
                  ))}
                </div>
              </MediaBoundary>
            ) : null}
            {/* Timeline: prose and tool activity interleaved in TRUE order
                (Anthropic narrates between tool rounds — "let me check X" →
                calls → "now let's…" → calls → answer). Each activity item's
                `at` offset splits the reply text into slots. */}
            <ReplyTimeline
              message={message}
              streaming={!!streaming}
              revealing={revealing}
              displayText={displayText}
            />
            {message.viz?.map((v, i) => (
              <VizFrame key={i} viz={v} />
            ))}
            {looseFiles(message).length ? (
              <MediaBoundary>
                <GeneratedFiles files={looseFiles(message)} />
              </MediaBoundary>
            ) : null}
            {!revealing && message.content ? (
              <MessageActions
                content={message.content}
                rating={message.rating ?? null}
                // No handler → no rating buttons. This is what makes the admin
                // support viewer read-only without needing its own flag.
                canRate={!!onRate && !!message.dbId}
                canRetry={isLast && !!onRetry}
                alwaysShow={isLast}
                sources={message.sources}
                createdAt={message.createdAt}
                listenId={canListen ? message.dbId : undefined}
                onRetry={onRetry}
                onRate={onRate}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Live status while a reply is forming: a small spinning sparkle plus a
 * shimmering gerund that changes every couple of seconds (Claude-Code style),
 * shown until the first answer text arrives.
 */
/**
 * Post-reply action row: copy the reply (as markdown, so formatting survives a
 * paste), retry/regenerate the last reply, and rate it thumbs up/down. Shown
 * always under the last reply, on hover for earlier ones.
 */
/** One reply speaks at a time, app-wide: starting a new playback (or clicking
 *  stop, or unmounting the playing bubble) tears down the previous one. Pausing
 *  and clearing `src` aborts the fetch, which cancels synthesis server-side. */
let activeSpeech: { audio: HTMLAudioElement; reset: () => void } | null = null;
function stopActiveSpeech() {
  const current = activeSpeech;
  if (!current) return;
  activeSpeech = null;
  current.audio.pause();
  current.audio.src = "";
  current.audio.load();
  current.reset();
}

function MessageActions({
  content,
  rating,
  canRate,
  canRetry,
  alwaysShow,
  sources,
  createdAt,
  listenId,
  onRetry,
  onRate,
}: {
  content: string;
  rating: "up" | "down" | null;
  canRate: boolean;
  canRetry: boolean;
  alwaysShow: boolean;
  sources?: SourceRef[];
  createdAt?: string;
  /** Persisted message id to voice via /api/tts — absent hides the button. */
  listenId?: string;
  onRetry?: () => void;
  onRate?: (rating: "up" | "down" | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // idle → loading (fetching first chunks) → playing. Progressive playback:
  // the audio element starts as soon as enough streamed MP3 has buffered.
  const [speech, setSpeech] = useState<"idle" | "loading" | "playing">("idle");
  const myAudioRef = useRef<HTMLAudioElement | null>(null);

  // Navigating away mid-playback: stop OUR audio (not someone else's).
  useEffect(
    () => () => {
      if (activeSpeech && activeSpeech.audio === myAudioRef.current) stopActiveSpeech();
    },
    [],
  );

  const toggleListen = () => {
    if (speech !== "idle") {
      stopActiveSpeech();
      return;
    }
    stopActiveSpeech(); // a different reply may be speaking — one at a time
    const audio = new Audio(`/api/tts?messageId=${encodeURIComponent(listenId!)}`);
    myAudioRef.current = audio;
    const reset = () => setSpeech("idle");
    activeSpeech = { audio, reset };
    setSpeech("loading");
    const finish = () => {
      if (activeSpeech?.audio === audio) activeSpeech = null;
      reset();
    };
    audio.onplaying = () => setSpeech("playing");
    audio.onended = finish;
    audio.onerror = finish;
    void audio.play().catch(finish);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) — no-op */
    }
  };

  const btn =
    "inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground";
  const hasSources = !!sources?.length;

  return (
    <>
      <div
        className={`mt-1 flex items-center gap-0.5 transition-opacity ${
          alwaysShow || (hasSources && sourcesOpen) || speech !== "idle"
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover/msg:opacity-100"
        }`}
      >
        <button type="button" onClick={copy} aria-label="Copy" title={copied ? "Copied" : "Copy"} className={btn}>
          {copied ? <ClipboardCheckIcon /> : <CopyIcon />}
        </button>
        {listenId ? (
          <button
            type="button"
            onClick={toggleListen}
            aria-label={speech === "idle" ? "Listen" : "Stop listening"}
            title={speech === "idle" ? "Listen" : "Stop"}
            className={`${btn} ${speech === "playing" ? "text-accent hover:text-accent" : ""}`}
          >
            {speech === "loading" ? (
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
                aria-hidden="true"
              />
            ) : speech === "playing" ? (
              <SpeakerStopIcon />
            ) : (
              <SpeakerIcon />
            )}
          </button>
        ) : null}
        {canRetry ? (
          <button type="button" onClick={onRetry} aria-label="Retry" title="Retry" className={btn}>
            <RetryIcon />
          </button>
        ) : null}
        {canRate ? (
          <>
            <button
              type="button"
              onClick={() => onRate?.(rating === "up" ? null : "up")}
              aria-label="Good response"
              aria-pressed={rating === "up"}
              title="Good response"
              className={`${btn} ${rating === "up" ? "text-accent hover:text-accent" : ""}`}
            >
              <ThumbIcon dir="up" filled={rating === "up"} />
            </button>
            <button
              type="button"
              onClick={() => onRate?.(rating === "down" ? null : "down")}
              aria-label="Bad response"
              aria-pressed={rating === "down"}
              title="Bad response"
              className={`${btn} ${rating === "down" ? "text-red-500 hover:text-red-500" : ""}`}
            >
              <ThumbIcon dir="down" filled={rating === "down"} />
            </button>
          </>
        ) : null}
        {hasSources ? (
          <button
            type="button"
            onClick={() => setSourcesOpen((v) => !v)}
            aria-expanded={sourcesOpen}
            title={`${sources!.length} source${sources!.length === 1 ? "" : "s"}`}
            className="ml-1 inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-2 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <span className="flex -space-x-1.5">
              {sources!.slice(0, 3).map((s, i) =>
                s.kind === "file" ? (
                  <FileSourceGlyph key={i} className="h-4 w-4 rounded-full ring-1 ring-surface" />
                ) : (
                  <Favicon key={i} url={s.url} className="h-4 w-4 rounded-full ring-1 ring-surface" />
                ),
              )}
            </span>
            {sources!.length} source{sources!.length === 1 ? "" : "s"}
          </button>
        ) : null}
        <MsgTime iso={createdAt} className="ml-1.5" />
      </div>
      {hasSources && sourcesOpen ? <SourcesPanel sources={sources!} /> : null}
    </>
  );
}

/**
 * Hover action row under a USER message: relative timestamp, copy, and
 * edit-and-revert. Mirrors the assistant row's reveal-on-hover behaviour,
 * right-aligned under the bubble.
 */
/** Who wrote this (shared chats): first name + avatar, right-aligned over the
 *  bubble. Every human message gets one, your own included, so the transcript
 *  reads the same on every screen. */
function AuthorLabel({ author }: { author: NonNullable<UIMessage["author"]> }) {
  return (
    <div
      data-author={author.id}
      title={author.name}
      className="mb-1 flex items-center gap-1.5 pr-1 text-xs text-muted"
    >
      <span>{shortName({ name: author.name })}</span>
      <Avatar name={author.name} image={author.image} className="h-5 w-5" textClassName="text-[9px]" />
    </div>
  );
}

function UserMessageActions({
  content,
  createdAt,
  canEdit,
  onEdit,
}: {
  content: string;
  createdAt?: string;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) — no-op */
    }
  };
  const btn =
    "inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground";

  return (
    <div className="mt-1 flex items-center justify-end gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <MsgTime iso={createdAt} className="mr-1.5" />
      <button type="button" onClick={copy} aria-label="Copy" title={copied ? "Copied" : "Copy"} className={btn}>
        {copied ? <ClipboardCheckIcon /> : <CopyIcon />}
      </button>
      {canEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit message"
          title="Edit message"
          className={btn}
        >
          <EditIcon />
        </button>
      ) : null}
    </div>
  );
}

/**
 * In-place editor for a sent user message. Saving REVERTS the conversation:
 * this turn and everything after it are permanently replaced by the edited
 * message (attachments can be dropped too — removed ones are deleted).
 */
function EditMessageForm({
  message,
  laterCount,
  onCancel,
  onSave,
}: {
  message: UIMessage;
  laterCount: number;
  onCancel: () => void;
  onSave: (content: string, keptFileIds: string[]) => void;
}) {
  const [draft, setDraft] = useState(message.content);
  const [kept, setKept] = useState<Attachment[]>(message.files ?? []);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Focus with the caret at the end, sized to the content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed, kept.map((f) => f.id));
  };

  return (
    <div className="w-full rounded-3xl border border-accent/50 bg-surface shadow-sm">
      {kept.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {kept.map((f) => (
            <FileChip
              key={f.id}
              file={f}
              onRemove={() => setKept((prev) => prev.filter((k) => k.id !== f.id))}
            />
          ))}
        </div>
      ) : null}
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
        rows={1}
        aria-label="Edit message"
        className="max-h-52 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground focus:outline-none focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
        <span className="min-w-0 truncate text-[11px] text-muted">
          {laterCount > 0
            ? `Sending removes the ${laterCount === 1 ? "later message" : `${laterCount} later messages`} in this chat.`
            : "Sending replaces the current reply."}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!draft.trim()}
            className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </span>
      </div>
    </div>
  );
}

/** Compact "12 Jul, 14:32" stamp. Formatted client-side only (locale-safe —
 *  no SSR/client hydration mismatch); renders nothing without a timestamp. */
function MsgTime({ iso, className = "" }: { iso?: string; className?: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    setText(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d),
    );
  }, [iso]);
  if (!text) return null;
  return (
    <span className={`select-none whitespace-nowrap text-[11px] tabular-nums text-muted/80 ${className}`}>
      {text}
    </span>
  );
}

/** Live "what the assistant is doing" lines (tool invocations, in order) —
 *  understated Claude-style muted text above the reply, no card chrome. The
 *  last line spins while the reply is still forming; done lines get a faint
 *  tick. */
/**
 * Interleaved reply renderer: splits the reply text at each activity item's
 * `at` offset and renders prose → activity → prose in true chronological
 * order (reveal-aware — completed slots are full markdown, the slot under
 * the paced-reveal cursor streams, later slots wait).
 */
function ReplyTimeline({
  message,
  streaming,
  revealing,
  displayText,
}: {
  message: UIMessage;
  streaming: boolean;
  revealing: boolean;
  displayText: string;
}) {
  const activity = message.activity ?? [];
  // Collapse (owner ask 2026-09-02): the working steps — status lines, run
  // blocks, question records, and any narration between them — are there to
  // show something is happening. Once the reply is FINISHED they fold into
  // one row so the answer isn't buried under the work; the deliverables
  // (images/files presented mid-turn) and the final prose stay visible, and
  // the row expands on click. Expanded while streaming; a loaded reply
  // starts collapsed.
  const [expanded, setExpanded] = useState(false);

  if (!message.content && activity.length === 0) {
    return streaming && !message.viz?.length && !message.genImages?.length ? (
      <div className="markdown text-sm leading-relaxed">
        <ThinkingStatus label={message.phase} />
      </div>
    ) : null;
  }

  const slots = segmentReply(message.content.length, activity);
  const lastWithItems = slots.reduce((acc, s, i) => (s.items.length > 0 ? i : acc), -1);
  const workSteps = activity.filter((a) => !isDeliverable(a)).length;

  const renderText = (start: number, end: number): ReactNode => {
    const text = message.content.slice(start, end);
    if (!text) return null;
    if (!revealing || displayText.length >= end) {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
    }
    if (displayText.length > start) {
      return <StreamingMarkdown text={displayText.slice(start)} />;
    }
    return null; // the reveal hasn't reached this slot yet
  };

  if (!streaming && workSteps > 0 && !expanded) {
    // Folded: [worked-through row] [deliverables, in order] [final prose].
    const finalSlot = slots[slots.length - 1];
    const deliverables = activity.filter(isDeliverable);
    const finalText = renderText(finalSlot.start, finalSlot.end);
    return (
      <>
        <button
          type="button"
          data-activity-collapsed
          onClick={() => setExpanded(true)}
          className="my-2 flex items-center gap-1.5 text-[13px] leading-relaxed text-muted transition-colors hover:text-foreground"
          aria-expanded={false}
        >
          <Chevron open={false} />
          <span>
            Worked through {workSteps} step{workSteps === 1 ? "" : "s"}
          </span>
        </button>
        {deliverables.length > 0 ? <ToolActivity items={deliverables} live={false} message={message} /> : null}
        {finalText ? <div className="markdown text-sm leading-relaxed">{finalText}</div> : null}
      </>
    );
  }

  return (
    <>
      {!streaming && workSteps > 0 ? (
        <button
          type="button"
          data-activity-expanded
          onClick={() => setExpanded(false)}
          className="my-2 flex items-center gap-1.5 text-[13px] leading-relaxed text-muted transition-colors hover:text-foreground"
          aria-expanded={true}
        >
          <Chevron open={true} />
          <span>
            Worked through {workSteps} step{workSteps === 1 ? "" : "s"}
          </span>
        </button>
      ) : null}
      {slots.map((slot, i) => {
        const textNode = renderText(slot.start, slot.end);
        return (
          <div key={i}>
            {textNode ? <div className="markdown text-sm leading-relaxed">{textNode}</div> : null}
            {slot.items.length > 0 ? (
              <ToolActivity
                items={slot.items}
                live={streaming && i === lastWithItems && message.content.length <= slot.end}
                message={message}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function isDeliverable(a: ActivityItem): boolean {
  return a.kind === "image" || a.kind === "files";
}

/** Images / files with NO timeline position (rows from before 2026-09-02). */
function looseImages(message: UIMessage): GenImage[] {
  const placed = new Set((message.activity ?? []).flatMap((a) => (a.kind === "image" ? [a.id] : [])));
  return (message.genImages ?? []).filter((g) => !placed.has(g.id));
}
function looseFiles(message: UIMessage): Attachment[] {
  const placed = new Set((message.activity ?? []).flatMap((a) => (a.kind === "files" ? a.ids : [])));
  return (message.files ?? []).filter((f) => !placed.has(f.id));
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ToolActivity({ items, live, message }: { items: ActivityItem[]; live: boolean; message: UIMessage }) {
  return (
    <div className="my-2 space-y-1">
      {items.map((item, i) => {
        if (item.kind === "run") {
          return <ToolRunBlock key={item.run.id} run={item.run} />;
        }
        if (item.kind === "ask") {
          return <AskedBlock key={item.ask.id} ask={item.ask} />;
        }
        if (item.kind === "image") {
          const img = message.genImages?.find((g) => g.id === item.id);
          return img ? (
            <MediaBoundary key={`img-${item.id}`}>
              <div data-activity="image" className="py-1">
                <GeneratedImage image={img} />
              </div>
            </MediaBoundary>
          ) : null;
        }
        if (item.kind === "files") {
          const files = (message.files ?? []).filter((f) => item.ids.includes(f.id));
          return files.length ? (
            <MediaBoundary key={`files-${item.ids.join(",")}`}>
              <div data-activity="files" className="py-1">
                <GeneratedFiles files={files} />
              </div>
            </MediaBoundary>
          ) : null;
        }
        const active = live && i === items.length - 1;
        return (
          <div key={i} data-activity="status" className="flex items-center gap-2 text-[13px] leading-relaxed">
            {active ? (
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted border-t-transparent" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 text-muted/60" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 13l4 4L19 7" />
              </svg>
            )}
            <span className={active ? "text-muted oi-shimmer" : "text-muted"}>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The record a question card leaves behind in the reply.
 *
 * The live card sits above the composer and disappears once answered, so
 * without this a reload would show the assistant's half-finished reply followed
 * by a bare "Manchester" bubble and no sign of what was asked. Compact by
 * design: the question, and which option was taken.
 */
function AskedBlock({ ask }: { ask: AskRecord }) {
  // While the card is up it is doing the talking, one question at a time — so
  // this stays a single line. Repeating every question here as its own
  // "waiting" row just duplicates the card three times over.
  if (ask.status === "pending") {
    return (
      <div
        data-activity="ask"
        data-ask-record={ask.id}
        className="my-2 flex items-center gap-2 text-[13px] leading-relaxed"
      >
        <span className="shrink-0 text-muted/70" aria-hidden="true">
          <AskGlyph />
        </span>
        <span className="text-muted oi-shimmer">
          {ask.questions.length > 1
            ? `Waiting for your answer to ${ask.questions.length} questions…`
            : "Waiting for your answer…"}
        </span>
      </div>
    );
  }

  return (
    <div data-activity="ask" data-ask-record={ask.id} className="my-2 space-y-1.5">
      {ask.questions.map((q, i) => {
        const answer = ask.answers?.[i];
        const chosen = new Set(answer?.chosen ?? []);
        const unanswered = !answer || answer.skipped || chosen.size === 0;
        return (
          <div
            key={`${ask.id}-${i}`}
            className="rounded-xl border border-border/70 bg-surface/60 px-3 py-2"
          >
            <p className="flex items-start gap-2 text-[13px] leading-snug text-muted">
              <span className="mt-px shrink-0 text-muted/70" aria-hidden="true">
                <AskGlyph />
              </span>
              <span className="min-w-0">{q.question}</span>
            </p>
            <p className="mt-1 pl-5 text-[13px] leading-snug">
              {unanswered ? (
                <span className="text-muted italic">
                  {ask.status === "expired"
                    ? "No answer — the assistant chose for you"
                    : "Skipped — the assistant chose for you"}
                </span>
              ) : (
                <span className="text-fg">
                  {summariseAnswer(answer)}
                  {answer.custom && (
                    <span className="ml-1.5 text-xs text-muted">(typed)</span>
                  )}
                </span>
              )}
            </p>
          </div>
        );
      })}
      {ask.answeredBy ? (
        <p data-ask-answered-by={ask.answeredBy.id} className="pl-1 text-xs text-muted">
          Answered by {ask.answeredBy.name}
        </p>
      ) : null}
    </div>
  );
}

function AskGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M9.1 9a3 3 0 115.8 1c0 2-3 2.5-3 4" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r=".6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="9.5" />
    </svg>
  );
}

/** Site favicon via Google's public favicon endpoint (fetched by the
 *  browser); falls back to a globe glyph if it fails to load. */
function Favicon({ url, className }: { url: string; className: string }) {
  const [failed, setFailed] = useState(false);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* leave empty — render fallback */
  }
  if (!host || failed) {
    return (
      <svg viewBox="0 0 24 24" className={`${className} bg-surface-hover p-0.5 text-muted`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17-2.5-2.5-2.5-14.5 0-17Z" />
      </svg>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${className} bg-white object-contain`}
    />
  );
}

/** Expanded numbered source list. Web rows (favicon, title, domain) open in
 *  a new tab; file rows (doc glyph) open the in-app context viewer showing
 *  exactly what the assistant read. */
function SourcesPanel({ sources }: { sources: SourceRef[] }) {
  const [openFile, setOpenFile] = useState<{ id: string; name: string } | null>(null);
  const rowCls =
    "flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-hover";

  return (
    <>
      <div className="mt-2 overflow-hidden rounded-xl border border-border bg-surface">
        {sources.map((s, i) => {
          const num = (
            <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}</span>
          );
          if (s.kind === "file" && s.fileId) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => setOpenFile({ id: s.fileId!, name: s.title ?? "file" })}
                title="See exactly what the assistant read"
                className={rowCls}
              >
                {num}
                <FileSourceGlyph />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">
                    {s.title || "File"}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    In this chat — read by the assistant
                  </span>
                </span>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.04 12.32a1 1 0 0 1 0-.64C3.42 7.51 7.36 4.5 12 4.5s8.58 3.01 9.96 7.18a1 1 0 0 1 0 .64C20.58 16.49 16.64 19.5 12 19.5s-8.58-3.01-9.96-7.18Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            );
          }
          let host = "";
          // Only http(s) becomes a clickable link (audit 2026-09-05): every
          // producer validates today, but a restored or imported meta.sources
          // carrying `javascript:` must never turn into an anchor.
          let clickable = false;
          try {
            const u = new URL(s.url);
            host = u.hostname.replace(/^www\./, "");
            clickable = u.protocol === "http:" || u.protocol === "https:";
          } catch {
            host = s.url;
          }
          return (
            <a
              key={i}
              href={clickable ? s.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={rowCls}
            >
              {num}
              <Favicon url={s.url} className="h-4 w-4 shrink-0 rounded" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {s.title || s.url}
                </span>
                {s.title ? (
                  <span className="block truncate text-[11px] text-muted">{host}</span>
                ) : null}
              </span>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          );
        })}
      </div>
      {openFile ? (
        <FileContextModal
          fileId={openFile.id}
          filename={openFile.name}
          showDownload
          onClose={() => setOpenFile(null)}
        />
      ) : null}
    </>
  );
}

function FileSourceGlyph({
  className = "h-4 w-4 shrink-0 rounded",
}: {
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} bg-surface-hover p-0.5 text-muted`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}
function ClipboardCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.6 5.4a9 9 0 0 1 0 13.2" />
    </svg>
  );
}
function SpeakerStopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <rect x="15" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}
function RetryIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8m0 0V3m0 5h5" />
    </svg>
  );
}
function ThumbIcon({ dir, filled }: { dir: "up" | "down"; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 ${dir === "down" ? "rotate-180" : ""}`}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4.5-7a2.2 2.2 0 0 1 2 3l-1 4H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 21H7" />
    </svg>
  );
}

/**
 * Paced reveal buffer. `content` is the full text received so far; this returns
 * how many characters should currently be *shown*. A rAF loop advances the shown
 * cursor toward the received length at a speed proportional to the backlog
 * (received − shown), so the display keeps up with any token rate: a big burst
 * drains fast, a slow model trickles, and neither snaps in. Once the stream ends
 * (`streaming` false) it drains with a shorter time-constant so the final
 * markdown swap doesn't visibly lag. A small floor keeps very slow models from
 * stalling. Honours `prefers-reduced-motion` by revealing instantly.
 */
function usePacedReveal(content: string, streaming: boolean): number {
  const [shown, setShown] = useState(() => (streaming ? 0 : content.length));
  const shownRef = useRef(shown);
  const targetRef = useRef(content.length);
  const streamingRef = useRef(streaming);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);

  targetRef.current = content.length;
  streamingRef.current = streaming;
  // Message switched/reset (content shorter than the cursor): snap back so we
  // never render a stale slice of the previous message.
  if (shownRef.current > content.length) shownRef.current = content.length;

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      shownRef.current = targetRef.current;
      setShown(targetRef.current);
      return;
    }
    // Already caught up and nothing more incoming → no loop needed.
    if (rafRef.current != null) return;
    if (shownRef.current >= targetRef.current && !streamingRef.current) return;

    const tick = (ts: number) => {
      const last = lastRef.current ?? ts;
      const dt = Math.min(Math.max(ts - last, 0), 100); // clamp tab-switch gaps
      lastRef.current = ts;

      const target = targetRef.current;
      let cur = shownRef.current;
      const behind = target - cur;
      if (behind > 0) {
        const draining = !streamingRef.current;
        // Time-constant ~180ms while streaming, ~70ms once the stream has ended.
        let step = behind * (dt / (draining ? 70 : 180));
        step = Math.max(step, (dt / 1000) * 45); // ≥ ~45 chars/sec floor
        cur = Math.min(cur + step, target);
        shownRef.current = cur;
        setShown(Math.floor(cur));
      }

      if (shownRef.current >= targetRef.current && !streamingRef.current) {
        rafRef.current = null;
        lastRef.current = null;
        return; // idle — restarted by the effect when new content arrives
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastRef.current = null;
    };
  }, [content, streaming]);

  return shown;
}

/**
 * Find the boundary between markdown that's safe to render now (completed blocks)
 * and the block still being typed. Returns [committed, tail]. We commit up to the
 * last blank-line boundary, but never split inside an open ``` code fence (an odd
 * fence count) — there we commit everything before the open fence so the code
 * being typed stays as the tail until it closes.
 */
function splitStreamMarkdown(text: string): [string, string] {
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    const open = text.lastIndexOf("```");
    return [text.slice(0, open), text.slice(open)];
  }
  const boundary = text.lastIndexOf("\n\n");
  if (boundary === -1) return ["", text];
  return [text.slice(0, boundary + 2), text.slice(boundary + 2)];
}

/**
 * Every streamed token calls `setMessages`, which re-renders the whole thread.
 * `react-markdown` re-parses on every render — it memoises nothing internally —
 * so without this, one token cost a full remark parse of EVERY earlier reply in
 * the conversation. On a long chat (the migrated instance has plenty) that is
 * O(messages x content) per token, and the paced reveal stutters.
 *
 * The comparator ignores the IDENTITY of the callbacks and compares only
 * whether each is present, because the call site builds small closures per
 * render (`(r) => rate(m.dbId, r)`). That is safe here: `onRate` and `onEdit`
 * are stable underneath (edit reads the thread from a ref), and `onRetry` is
 * only ever passed to the last message, whose props change when the stream
 * ends. Presence still matters — it decides whether a button is rendered.
 */
export const MessageBubble = memo(MessageBubbleImpl, (a, b) => {
  return (
    a.message === b.message &&
    a.streaming === b.streaming &&
    a.isLast === b.isLast &&
    a.laterCount === b.laterCount &&
    a.canListen === b.canListen &&
    a.showAuthor === b.showAuthor &&
    !!a.onRetry === !!b.onRetry &&
    !!a.onRate === !!b.onRate &&
    !!a.onEdit === !!b.onEdit
  );
});

/**
 * Progressive markdown while streaming: completed blocks (before the last blank
 * line) render as real markdown the moment they finish, while the block still
 * being typed stays as fading plain text (§15). The committed markdown is
 * memoised on its own string so it only re-parses when a new block completes,
 * not on every revealed word.
 */
function StreamingMarkdown({ text }: { text: string }) {
  const [committed, tail] = useMemo(() => splitStreamMarkdown(text), [text]);
  const committedNode = useMemo(
    () =>
      committed ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{committed}</ReactMarkdown>
      ) : null,
    [committed],
  );
  return (
    <>
      {committedNode}
      {tail ? <StreamingText text={tail} /> : null}
    </>
  );
}

/**
 * Split the revealed text into whitespace/word runs and give each its own
 * fade-in so words wash in one after another (0→100% opacity). Keying each span
 * by its index keeps already-shown tokens mounted, so their fade plays exactly
 * once and never restarts as later tokens arrive.
 */
function StreamingText({ text }: { text: string }) {
  const tokens = useMemo(() => text.match(/\s+|\S+/g) ?? [], [text]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {tokens.map((tok, i) => (
        <span key={i} className="oi-token-in">
          {tok}
        </span>
      ))}
    </span>
  );
}

/** Pick a random gerund, avoiding an immediate repeat. */
function randomWord(avoid?: string): string {
  let w = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
  if (avoid && THINKING_WORDS.length > 1) {
    while (w === avoid) w = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
  }
  return w;
}

function ThinkingStatus({ label }: { label?: string | null }) {
  const [word, setWord] = useState(() => randomWord());
  const [shown, setShown] = useState(0);
  // A pipeline phase (e.g. "Processing voice-note.m4a…") replaces the random
  // gerund while it lasts; when it clears, the gerund rotation resumes.
  const full = label || `${word}…`;

  // Swap in a fresh random word every 3 seconds (paused while a phase shows).
  useEffect(() => {
    if (label) return;
    const id = setInterval(() => setWord((prev) => randomWord(prev)), 3000);
    return () => clearInterval(id);
  }, [label]);

  // Typewriter: reveal the whole word (+ ellipsis) one char at a time over ~1s
  // each time the word changes.
  useEffect(() => {
    setShown(0);
    const total = full.length;
    if (total === 0) return;
    const step = Math.max(1000 / total, 24);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= total) clearInterval(id);
    }, step);
    return () => clearInterval(id);
  }, [full]);

  return (
    <span className="inline-flex items-center gap-2 text-sm" aria-live="polite">
      <SparkleIcon />
      <span className="oi-shimmer font-medium">{full.slice(0, shown)}</span>
    </span>
  );
}

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 animate-spin text-accent"
      style={{ animationDuration: "2.4s" }}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2c.5 5 4.5 9.5 10 10-5.5.5-9.5 4.5-10 10-.5-5.5-4.5-9.5-10-10 5.5-.5 9.5-4.5 10-10z" />
    </svg>
  );
}
