"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { deleteFile } from "@/app/actions/files";
import { rateMessage } from "@/app/actions/messages";
import { MessageBubble, type UIMessage } from "./message-bubble";
import { CompactionDivider } from "./compaction-divider";
import type { ToolRunUI } from "./tool-run";
import { FileChip, type Attachment } from "./file-chip";
import { AskCard, type DraftAnswer, type PendingAsk } from "./ask-card";
import type { AskRecord } from "@/lib/ask";
import { FollowUps } from "./follow-ups";
import { useConversations } from "./conversations-store";
import { useLive, useLiveEvents, type LiveEventData } from "./live-provider";
import { canCancelQueued, canEditMessage } from "@/lib/chat-rules";
import type { QueuedMessageView } from "@/lib/chat-queue";
import Link from "next/link";
import { useAudioRecorder, RecordingWave, fmtElapsed } from "./mic-recorder";
import { playCompletionChime, isTabInactive } from "./chime";
import { uid } from "@/lib/uid";
import { APP_NAME, APP_VERSION, pageTitle } from "@/lib/version";
import { WELCOME_MESSAGES, formatWelcome } from "@/lib/welcome";
import { openArtifact } from "./artifact-panel";
import { ComposerMenu, type PickedWorkflow } from "./composer-menu";
import { previewKind } from "@/lib/artifact";

/** Characters of live console output held per run block (the UI shows 5 lines;
 *  the full output is capped and persisted server-side). */
const LIVE_OUTPUT_CAP = 16_000;

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface AssistantIdentity {
  name: string;
  logo?: string;
  configured: boolean;
  /** Conversation model has an extended level set → show the "Think" toggle. */
  canThinkHard: boolean;
}

/** Idle delay before the front-end model offers follow-up suggestions. */
const FOLLOWUP_IDLE_MS = 5 * 60 * 1000;

const SUGGESTIONS = [
  { label: "Brainstorm", prompt: "Help me brainstorm ideas about " },
  { label: "Summarize", prompt: "Summarize the following:\n\n" },
  { label: "Write code", prompt: "Write code that " },
  { label: "Draft an email", prompt: "Draft a professional email to " },
  { label: "Explain", prompt: "Explain in simple terms: " },
];

export function ChatWindow({
  conversationId,
  initialMessages,
  initialPending = [],
  initialFollowups = [],
  initialCompactedThroughId = null,
  initialQueue = [],
  assistant,
  userName,
  me,
  role = null,
  shared: initialShared = false,
  showUsage = false,
  incognito = false,
  ttsEnabled = false,
}: {
  conversationId: string | null;
  initialMessages: UIMessage[];
  /** Files uploaded but never sent (attach → reload) — restored into the
   *  composer strip so they ride the next message. Sent files render on
   *  their message bubble instead. */
  initialPending?: Attachment[];
  /** Follow-up suggestions persisted on the final reply — shown immediately
   *  on load so navigating away and back doesn't lose them. */
  initialFollowups?: string[];
  /** Conversation compaction: the last message the assistant now sees only
   *  as a summary — a divider is drawn after it (null = not compacted). */
  initialCompactedThroughId?: string | null;
  assistant: AssistantIdentity;
  userName?: string;
  /** Show the per-reply token/cost line (admin-gated via Customise). */
  showUsage?: boolean;
  /** Ephemeral chat — auto-deleted on leave/close, kept out of the sidebar. */
  incognito?: boolean;
  /** TTS engine configured server-side → offer the Listen button on replies. */
  ttsEnabled?: boolean;
  /** Scheduled messages waiting in this chat (held by the server, v0.5). */
  initialQueue?: QueuedMessageView[];
  /** Who is at this screen — stamps own bubbles, decides what may be edited. */
  me?: { id: string; name: string; image: string | null };
  /** Owner or member of this chat (null until a brand-new chat exists). */
  role?: "owner" | "member" | null;
  /** The chat has people in it besides you (v0.5 shared chats): label the
   *  bubbles and name the queue's authors. */
  shared?: boolean;
}) {
  const { upsert, bump, patch } = useConversations();
  const { clientId } = useLive();
  // A brand-new chat's sidebar row, in the shape the layout builds.
  const newItem = useCallback(
    (id: string, title: string) => ({
      id,
      title,
      pinned: false,
      updatedAt: new Date().toISOString(),
      shared: false,
      mine: true,
      ownerId: me?.id ?? "",
      memberCount: 0,
    }),
    [me?.id],
  );
  const [convId, setConvId] = useState<string | null>(conversationId);
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  // Mirrors `messages` for callbacks that must not be rebuilt on every token.
  // Assigned during render on purpose: an effect would lag a click by a frame.
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server says it's mid-deploy (503 + maintenance). Distinct
  // from `error` so a planned update reads as "back shortly", not a fault.
  const [maintenance, setMaintenance] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<UsageInfo | null>(null);
  const [followups, setFollowups] = useState<string[]>(initialFollowups);
  const [compactedThroughId, setCompactedThroughId] = useState<string | null>(initialCompactedThroughId);
  // The empty screen waits one tick for the client to mount: until then it
  // shows a loader (never a default greeting), then picks a random welcome and
  // eases the content in. `mounted` is false during SSR + first client render,
  // so there's no hydration mismatch.
  const [welcomeIdx, setWelcomeIdx] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setWelcomeIdx(Math.floor(Math.random() * WELCOME_MESSAGES.length));
    setMounted(true);
  }, []);

  const [attachments, setAttachments] = useState<Attachment[]>(initialPending);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // "Think harder" toggle — sends a boolean; the server picks the actual level.
  const [thinkHard, setThinkHard] = useState(false);
  // Microphone capture (spec §6) + a queued/scheduled follow-up (spec §14).
  const recorder = useAudioRecorder();
  // Scheduled messages (v0.5): held by the SERVER per chat and shown to
  // everyone in it — this is the latest snapshot the live feed delivered.
  const [queue, setQueue] = useState<QueuedMessageView[]>(initialQueue);
  // The chat has people in it besides you (flips live as people are added).
  const [sharedNow, setSharedNow] = useState(initialShared);
  // You were removed from the chat, or it was deleted, while you had it open.
  const [accessLost, setAccessLost] = useState<"removed" | "deleted" | null>(null);
  const accessLostRef = useRef(false);
  // A question the assistant is PAUSED on (ask_user). While this is set the
  // reply is parked server-side waiting for the answer, so the card sits above
  // the composer and a typed reply answers it instead of queueing.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [askBusy, setAskBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // A workflow chosen from the + menu, for the NEXT message only. Deliberately
  // per-message rather than sticky: a playbook you forgot was on would quietly
  // shape every reply, and you would blame the model.
  const [picked, setPicked] = useState<PickedWorkflow | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepth = useRef(0);
  // Tracks a live incognito conversation so it can be deleted on leave/close.
  const incognitoIdRef = useRef<string | null>(null);
  // The question card's own position/draft, mirrored up so a typed reply can
  // answer the question actually on screen. A ref, not state — writing it must
  // never re-render the card that reports it.
  const askDraftRef = useRef<{ index: number; answers: DraftAnswer[] }>({
    index: 0,
    answers: [],
  });
  const onAskProgress = useCallback((state: { index: number; answers: DraftAnswer[] }) => {
    askDraftRef.current = state;
  }, []);

  // Surface a mic permission/error into the composer error line.
  useEffect(() => {
    if (recorder.error) setError(recorder.error);
  }, [recorder.error]);

  // Incognito cleanup: delete the ephemeral chat when the user navigates away
  // (unmount) or closes/reloads the tab (pagehide → sendBeacon). Billing/audit
  // records survive, exactly like a normal delete.
  useEffect(() => {
    if (!incognito) return;
    const wipe = () => {
      const id = incognitoIdRef.current;
      if (id) navigator.sendBeacon("/api/chat/incognito-cleanup", JSON.stringify({ id }));
    };
    window.addEventListener("pagehide", wipe);
    return () => {
      window.removeEventListener("pagehide", wipe);
      wipe();
    };
  }, [incognito]);

  // Seed from the server snapshot when the CONVERSATION changes — not whenever
  // new props arrive.
  //
  // `initialMessages` is built fresh by a Server Component, so it has a new
  // identity on every RSC re-render, not just on navigation: any
  // `router.refresh()` (changing your profile picture) or `revalidatePath`
  // (starring or renaming a chat) produced one. With that in the deps, the
  // effect re-ran mid-reply, aborted the reader, and replaced the live thread
  // with the server's copy — the half-written reply vanished, nothing
  // re-attached (the resume effect's deps hadn't changed), the composer looked
  // idle, and the next message hit "a reply is already being generated" until
  // the server turn finished on its own.
  const messagesRef = useRef<UIMessage[]>(initialMessages);
  messagesRef.current = messages;
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === conversationId) return;
    seededFor.current = conversationId;
    setConvId(conversationId);
    setMessages(initialMessages);
    setError(null);
    setLastUsage(null);
    setAttachments(initialPending);
    setFollowups(initialFollowups);
    setCompactedThroughId(initialCompactedThroughId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, initialMessages, initialPending, initialFollowups, initialCompactedThroughId]);

  useEffect(() => {
    return () => {
      // Leaving this conversation: DETACH the local reader only — generation
      // is server-side (resumable turns) and runs to completion; coming back
      // re-attaches via /api/chat/stream.
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // Deliberately NOT keyed on `initialMessages`: that identity changes on
    // every server re-render, and aborting the reader on one of those is what
    // killed live replies.
  }, [conversationId]);

  const uploadFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      setError(null);
      // Every file lives in a conversation's storage pool. Attaching in a
      // brand-new chat creates the conversation server-side ("create on
      // attach") — adopt its id locally so the rest of the flow (more uploads,
      // the first message) targets the same pool.
      let poolId = convId;
      try {
        for (const file of Array.from(files)) {
          const params = new URLSearchParams();
          if (poolId) params.set("conversationId", poolId);
          else if (incognito) params.set("incognito", "1");
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch(`/api/files?${params.toString()}`, {
            method: "POST",
            body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            // Mid-deploy uploads are refused the same way sends are.
            if (res.status === 503 && data.maintenance) {
              setMaintenance(data.error as string);
              break;
            }
            setError(data.error ?? `Upload failed (${res.status}).`);
            continue;
          }
          if (data.conversationCreated && data.conversationId) {
            poolId = data.conversationId as string;
            setConvId(poolId);
            if (incognito) {
              // Ephemeral: track for cleanup, keep it out of the sidebar.
              incognitoIdRef.current = poolId;
            } else {
              upsert(newItem(poolId, "New chat"));
              window.history.replaceState(null, "", `/chat/${poolId}`);
            }
          }
          setAttachments((prev) => [...prev, data as Attachment]);
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [convId, incognito, upsert, newItem],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    void deleteFile(id);
  }, []);

  // Poll ingestion status while any chip is still being prepared — composer
  // attachments AND chips already sitting on messages (sent uploads, files
  // the assistant generated) — so spinners flip to ready live.
  const messageFileKey = messages
    .flatMap((m) => m.files ?? [])
    .filter((f) => f.status === "pending" || f.status === "processing")
    .map((f) => f.id)
    .join(",");
  useEffect(() => {
    const inFlight = [
      ...attachments.filter((a) => a.status === "pending" || a.status === "processing"),
      ...messageFileKey.split(",").filter(Boolean).map((id) => ({ id })),
    ];
    if (inFlight.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const ids = inFlight.map((a) => a.id).join(",");
        const res = await fetch(`/api/files/status?ids=${ids}`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          files: { id: string; status: string }[];
        };
        if (!data.files?.length) return;
        const byId = new Map(data.files.map((f) => [f.id, f.status]));
        setMessages((prev) =>
          prev.map((m) => {
            if (!m.files?.some((f) => byId.get(f.id) && byId.get(f.id) !== f.status)) return m;
            return {
              ...m,
              files: m.files.map((f) => {
                const next = byId.get(f.id);
                return next && next !== f.status ? { ...f, status: next } : f;
              }),
            };
          }),
        );
        setAttachments((prev) =>
          prev.map((a) => {
            const next = byId.get(a.id);
            return next && next !== a.status ? { ...a, status: next } : a;
          }),
        );
      } catch {
        /* transient — next tick retries */
      }
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, messageFileKey]);

  // Stop recording → speech-to-text (Whisper) → transcript lands in the input
  // box. If the STT engine is off/unreachable, fall back to the pre-STT
  // behaviour: attach the recording as a stored audio file so nothing is lost.
  const [transcribing, setTranscribing] = useState(false);
  const finishRecording = useCallback(async () => {
    const blob = await recorder.stop();
    if (!blob) return;
    const ext = blob.type.includes("ogg") ? "ogg" : "webm";
    const file = new File([blob], `recording-${Date.now()}.${ext}`, {
      type: blob.type || "audio/webm",
    });

    setTranscribing(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("audio", file);
      const res = await fetch("/api/stt", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (res.ok && typeof data.text === "string") {
        if (data.text) {
          setInput((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${data.text}` : data.text!));
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
              el.focus();
              autosize(el);
            }
          });
        } else {
          setError("No speech detected in the recording.");
        }
        return;
      }
      // STT unavailable/failed — keep the audio as a normal attachment.
      await uploadFiles([file]);
      setError(
        data.error
          ? `${data.error} Attached the recording instead.`
          : "Transcription failed — attached the recording instead.",
      );
    } catch {
      await uploadFiles([file]);
      setError("Transcription failed — attached the recording instead.");
    } finally {
      setTranscribing(false);
    }
  }, [recorder, uploadFiles]);

  const empty = messages.length === 0;

  // ── Stick-to-bottom scroll management ─────────────────────────────────
  // While a reply streams, a rAF loop EASES the thread toward the bottom (no
  // hard jumps as the page grows). Any upward scroll (wheel, touchpad, touch
  // pan, scrollbar drag) RELEASES the follow instantly so reading back is
  // never fought; scrolling back down to the bottom re-arms it, and while
  // released a floating ↓ button offers a one-click return.
  const followRef = useRef(true);
  // scrollTop values WE wrote — a passive scroll event can't say what caused
  // it, so this is how the handler tells our follow writes from user scrolls.
  const selfScrollRef = useRef(-1);
  const prevTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const updateJump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(!followRef.current && dist > 120);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setShowJump(false);
    // Idle → glide down natively; mid-stream the rAF easing takes over on the
    // very next frame (a programmatic scrollTop write cancels the native glide).
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: "smooth" });
  }, []);

  // Attach on `empty` too: in a brand-new chat the scroller only mounts with
  // the first message, after a mount-only effect has already come and gone.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    prevTopRef.current = el.scrollTop;

    const onScroll = () => {
      const top = el.scrollTop;
      const delta = top - prevTopRef.current;
      prevTopRef.current = top;
      const dist = el.scrollHeight - top - el.clientHeight;
      const ours = Math.abs(top - selfScrollRef.current) <= 1;
      if (!ours && delta < 0 && dist > 2) {
        // The user headed up — let go. `dist > 2` skips the browser's own
        // clamp-scroll when content shrinks (that lands AT the bottom).
        followRef.current = false;
      } else if (!ours && delta > 0 && dist <= 8) {
        // They came back to the bottom under their own steam — re-arm.
        followRef.current = true;
      }
      updateJump();
    };
    // Wheel-up (mouse or touchpad) fires BEFORE the scroll it causes —
    // releasing here wins the race against the follow loop, which would
    // otherwise pin the thread back down before small deltas could add up.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [empty, updateJump]);

  // A new message (send / regenerate / navigation) jumps straight to the
  // bottom if the user was following along — a deliberate act, so instant.
  useEffect(() => {
    const el = scrollRef.current;
    if (followRef.current && el) {
      el.scrollTop = el.scrollHeight;
      selfScrollRef.current = el.scrollTop;
      prevTopRef.current = el.scrollTop;
    }
  }, [messages.length]);

  useEffect(() => {
    let raf = 0;
    let lastTarget = -1;
    const until = streaming ? Infinity : performance.now() + 700;
    const loop = () => {
      const el = scrollRef.current;
      if (el) {
        const target = el.scrollHeight - el.clientHeight;
        // Velocity-matched easing: move by this frame's content growth PLUS a
        // fraction of the remaining gap, so the gap decays geometrically no
        // matter how fast the reveal runs (a plain proportional step stalls
        // behind fast streams and the newest line slips below the fold).
        const grow = lastTarget < 0 ? 0 : Math.max(0, target - lastTarget);
        lastTarget = target;
        if (followRef.current) {
          const diff = target - el.scrollTop;
          if (diff > 0.5) {
            const step = Math.min(diff, grow + Math.max(diff * 0.25, 2));
            el.scrollTop = diff - step < 1 ? target : el.scrollTop + step;
            selfScrollRef.current = el.scrollTop;
            prevTopRef.current = el.scrollTop;
          }
        } else {
          updateJump(); // released: height grows with no scroll event — keep the ↓ button honest
        }
      }
      if (streaming || performance.now() < until) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [streaming, updateJump]);

  // Stop the running reply. Generation is detached from this connection
  // (resumable streams), so aborting our fetch would merely DETACH — the
  // server would keep generating. Stop is an explicit server-side act; the
  // partial reply is saved and `done` closes the stream cleanly. Local abort
  // only as fallback (no active turn server-side, e.g. after a restart).
  const stop = useCallback(() => {
    const id = convId;
    if (!id) {
      abortRef.current?.abort();
      return;
    }
    void fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: id }),
    })
      .then((r) => r.json())
      .then((d: { stopped?: boolean }) => {
        if (!d?.stopped) abortRef.current?.abort();
      })
      .catch(() => abortRef.current?.abort());
  }, [convId]);

  const scheduleFollowups = useCallback((id: string | null, delayMs = FOLLOWUP_IDLE_MS) => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (!id) return;
    idleTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/followups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: id }),
        });
        if (!res.ok) return;
        const data: { suggestions?: string[] } = await res.json();
        if (Array.isArray(data.suggestions)) setFollowups(data.suggestions.slice(0, 3));
      } catch {
        /* best-effort */
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Re-arm the idle timer on mount/switch: the window remounts per
  // conversation, so the in-flight timer died with the previous mount (found
  // live: leave a chat, come back, suggestions never appear). Anchor the
  // delay to the FINAL reply's age — a chat idle past the threshold generates
  // almost immediately on return; a fresher one waits out the remainder. The
  // /api/followups route serves persisted suggestions without re-billing.
  useEffect(() => {
    if (!conversationId || incognito) return;
    if (initialFollowups.length > 0) return; // already restored + shown
    const last = initialMessages[initialMessages.length - 1];
    if (!last || last.role !== "assistant" || !last.createdAt) return;
    const elapsed = Date.now() - new Date(last.createdAt).getTime();
    scheduleFollowups(conversationId, Math.max(FOLLOWUP_IDLE_MS - elapsed, 2_000));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const autosize = (ta: HTMLTextAreaElement) => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  // Consume a turn's SSE stream (from the POST that started it, or from a
  // GET /api/chat/stream resume) into the assistant placeholder. Generation
  // runs server-side detached from this connection — dropping the reader only
  // detaches; stopping is the explicit /api/chat/stop endpoint.
  const processStream = useCallback(
    async (
      res: Response,
      assistantId: string,
      startConvId: string | null,
      wasNew: boolean,
      /** Local id of the user bubble this turn persisted — the `meta` event
       *  carries its DB id so the message can be edit-reverted later. */
      userLocalId?: string,
    ) => {
      let resolvedConvId = startConvId;

      try {
        if (!res.body) throw new Error("No response stream.");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.startsWith("data:") ? frame.slice(5).trim() : "";
            if (!line) continue;

            const evt = JSON.parse(line);
            if (evt.type === "meta") {
              resolvedConvId = evt.conversationId;
              if (evt.userMessageId && userLocalId) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === userLocalId ? { ...m, dbId: evt.userMessageId } : m,
                  ),
                );
              }
              if (wasNew && evt.conversationId) {
                setConvId(evt.conversationId);
                if (incognito) {
                  // Ephemeral: track for cleanup, keep it out of the sidebar,
                  // and don't rewrite the URL (stay on /chat?incognito=1).
                  incognitoIdRef.current = evt.conversationId;
                } else {
                  upsert(newItem(evt.conversationId, evt.title || "New chat"));
                  window.history.replaceState(null, "", `/chat/${evt.conversationId}`);
                }
              } else if (evt.conversationId && evt.title && !incognito) {
                // Attach-created chat receiving its first message: the convo
                // already exists client-side, but its provisional title does
                // not — refresh the sidebar entry.
                patch(evt.conversationId, { title: evt.title, updatedAt: new Date().toISOString() });
              }
            } else if (evt.type === "title") {
              // A brand-new chat is titled by the front-end model partway
              // through the first reply; without this the tab sits as the bare
              // app name until the next page load. Incognito is excluded for
              // the same reason it is kept out of the sidebar — the tab title
              // is one more place the subject of the chat would show up.
              if (!incognito) document.title = pageTitle(evt.title);
              if (resolvedConvId && !incognito) {
                patch(resolvedConvId, { title: evt.title, updatedAt: new Date().toISOString() });
              }
            } else if (evt.type === "notice") {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, notice: evt.message } : m)),
              );
            } else if (evt.type === "tool") {
              // Live tool activity ("Searching the web…") — appended in order,
              // positioned at the reply-text offset it occurred (interleave).
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        activity: [
                          ...(m.activity ?? []),
                          { kind: "status", label: evt.label as string, at: (evt.at as number) ?? m.content.length },
                        ],
                      }
                    : m,
                ),
              );
            } else if (evt.type === "run_start") {
              // A sandbox tool run begins: the rich live-preview block.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        activity: [
                          ...(m.activity ?? []),
                          {
                            kind: "run",
                            at: (evt.at as number) ?? m.content.length,
                            run: {
                              id: evt.id as string,
                              tool: evt.tool as string,
                              ...(evt.file ? { file: evt.file as string } : {}),
                              code: "",
                              output: "",
                              phase: "code",
                            },
                          },
                        ],
                      }
                    : m,
                ),
              );
            } else if (
              evt.type === "run_code" ||
              evt.type === "run_exec" ||
              evt.type === "run_out" ||
              evt.type === "run_done"
            ) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId || !m.activity?.length) return m;
                  const activity = m.activity.map((item) => {
                    if (item.kind !== "run" || item.run.id !== evt.id) return item;
                    const run = { ...item.run };
                    if (evt.type === "run_code") {
                      run.code += (evt.delta as string) ?? "";
                      if (evt.file) run.file = evt.file as string;
                    } else if (evt.type === "run_exec") {
                      run.phase = "exec";
                      run.command = evt.command as string;
                    } else if (evt.type === "run_out") {
                      // Only the tail is ever shown, and only the tail is worth
                      // keeping: a chatty run (`pip install`, a build) streams
                      // megabytes, and every chunk used to append to an
                      // unbounded string that the 5-line preview then re-split
                      // in full — O(n²) over the run, holding the whole log for
                      // the life of the message. The server caps what it
                      // persists at 20k; this caps what the tab holds live.
                      run.output = (run.output + ((evt.delta as string) ?? "")).slice(
                        -LIVE_OUTPUT_CAP,
                      );
                    } else {
                      run.phase = "done";
                      if (evt.diff) run.diff = evt.diff as ToolRunUI["diff"];
                      if (evt.exec) run.exec = evt.exec as ToolRunUI["exec"];
                      if (evt.error) run.error = evt.error as string;
                    }
                    return { ...item, run };
                  });
                  return { ...m, activity };
                }),
              );
            } else if (evt.type === "ask") {
              // The reply is now parked on a question. Card above the composer,
              // plus a placeholder in the timeline at the offset it appeared
              // (which is what persists, so a reload shows what was asked).
              const record: AskRecord = {
                id: evt.id as string,
                questions: evt.questions as AskRecord["questions"],
                status: "pending",
              };
              askDraftRef.current = { index: 0, answers: record.questions.map(() => ({})) };
              setAskBusy(false);
              setPendingAsk({ id: record.id, questions: record.questions });
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        activity: [
                          ...(m.activity ?? []).filter(
                            (it) => !(it.kind === "ask" && it.ask.id === record.id),
                          ),
                          { kind: "ask", at: (evt.at as number) ?? m.content.length, ask: record },
                        ],
                      }
                    : m,
                ),
              );
            } else if (evt.type === "ask_done") {
              // Answered, dismissed or timed out — retire the live card and
              // freeze the record with whatever came back.
              setPendingAsk((cur) => (cur && cur.id === evt.id ? null : cur));
              setAskBusy(false);
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId || !m.activity?.length) return m;
                  return {
                    ...m,
                    activity: m.activity.map((it) =>
                      it.kind === "ask" && it.ask.id === evt.id
                        ? {
                            ...it,
                            ask: {
                              ...it.ask,
                              status: evt.status as AskRecord["status"],
                              ...(evt.answers ? { answers: evt.answers as AskRecord["answers"] } : {}),
                              // Who answered (shared chats) — "Answered by …".
                              ...(evt.by ? { answeredBy: evt.by as AskRecord["answeredBy"] } : {}),
                            },
                          }
                        : it,
                    ),
                  };
                }),
              );
            } else if (evt.type === "ask_answer") {
              // The answer was persisted (later turns replay only user and
              // assistant rows, so the assistant would otherwise forget its own
              // question's answer) — but it gets NO bubble of its own. The
              // question card already shows the chosen answer inline, where the
              // question was asked; a separate bubble would sit above that card,
              // because the answer row is written mid-turn while the reply is
              // only saved at the end.
              //
              // (v0.5: the scheduled queue is held by the server, so there is
              // no local fallback copy to clear here any more.)
            } else if (evt.type === "compacted") {
              // The turn summarised the older part of this chat before replying:
              // draw the divider where the summary now begins.
              if (typeof evt.throughMessageId === "string") setCompactedThroughId(evt.throughMessageId);
            } else if (evt.type === "phase") {
              // Pre-model phase (attachment ingestion): shown inside the
              // thinking indicator; label null → back to the gerund shimmer.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, phase: evt.label ?? null } : m,
                ),
              );
            } else if (evt.type === "interjected") {
              // A queued message was spliced into the RUNNING turn: show its
              // bubble above the streaming reply (the server drops its copy
              // from the scheduled queue; the `queue` live event follows).
              setMessages((prev) => {
                // Replayed on resume: the interjected turn was persisted
                // mid-run, so the loader may already have its row.
                if (prev.some((m) => m.dbId === evt.messageId || m.id === evt.messageId)) {
                  return prev;
                }
                const userMsg: UIMessage = {
                  id: uid(),
                  role: "user",
                  content: evt.content,
                  dbId: evt.messageId,
                  createdAt: new Date().toISOString(),
                  ...(evt.author ? { author: evt.author as UIMessage["author"] } : {}),
                };
                const idx = prev.findIndex((m) => m.id === assistantId);
                return idx < 0
                  ? [...prev, userMsg]
                  : [...prev.slice(0, idx), userMsg, ...prev.slice(idx)];
              });
            } else if (evt.type === "sources") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, sources: [...(m.sources ?? []), ...(evt.sources ?? [])] }
                    : m,
                ),
              );
            } else if (evt.type === "files") {
              // Files the assistant created this turn — chips on its reply.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        files: [...(m.files ?? []), ...(evt.files ?? [])],
                        // …and WHERE they were presented (timeline position).
                        activity: [
                          ...(m.activity ?? []),
                          {
                            kind: "files",
                            ids: ((evt.files ?? []) as { id: string }[]).map((f) => f.id),
                            at: (evt.at as number) ?? m.content.length,
                          },
                        ],
                      }
                    : m,
                ),
              );
              // Open the newest previewable one beside the chat, at its latest
              // version. Images are skipped on purpose — they render inline in
              // the reply, where they are the answer rather than an attachment
              // to it — so a turn that only presents pictures opens nothing.
              {
                const presented = (evt.files ?? []) as {
                  id: string;
                  filename: string;
                  mimeType?: string | null;
                }[];
                const openable = presented.find(
                  (f) => previewKind(f.mimeType, f.filename) !== "none",
                );
                if (openable) openArtifact(openable.id);
              }
            } else if (evt.type === "image_start") {
              // Show the aspect-ratio placeholder box immediately.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        genImages: [
                          ...(m.genImages ?? []),
                          {
                            id: evt.id,
                            aspectRatio: evt.aspectRatio,
                            prompt: evt.prompt,
                            operation: evt.operation,
                            status: "pending",
                            estimateMs: evt.estimateMs,
                            startedAt: Date.now(),
                          },
                        ],
                        // Positioned in the timeline at the point it appeared.
                        activity: (m.activity ?? []).some((a) => a.kind === "image" && a.id === evt.id)
                          ? m.activity
                          : [...(m.activity ?? []), { kind: "image", id: evt.id as string, at: (evt.at as number) ?? m.content.length }],
                      }
                    : m,
                ),
              );
            } else if (evt.type === "image_done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        genImages: (m.genImages ?? []).map((g) =>
                          g.id === evt.id
                            ? { ...g, status: "ready", fileId: evt.fileId, ...(evt.version ? { version: evt.version as number } : {}) }
                            : g,
                        ),
                      }
                    : m,
                ),
              );
            } else if (evt.type === "image_error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        genImages: (m.genImages ?? []).map((g) =>
                          g.id === evt.id ? { ...g, status: "error", error: evt.message } : g,
                        ),
                      }
                    : m,
                ),
              );
            } else if (evt.type === "viz_start") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, viz: [...(m.viz ?? []), { title: evt.title ?? "Visualization", html: "", done: false }] }
                    : m,
                ),
              );
            } else if (evt.type === "viz") {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId || !m.viz?.length) return m;
                  const viz = [...m.viz];
                  const last = viz[viz.length - 1];
                  viz[viz.length - 1] = { ...last, html: last.html + (evt.delta ?? "") };
                  return { ...m, viz };
                }),
              );
            } else if (evt.type === "viz_end") {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantId || !m.viz?.length) return m;
                  const viz = [...m.viz];
                  viz[viz.length - 1] = { ...viz[viz.length - 1], done: true };
                  return { ...m, viz };
                }),
              );
            } else if (evt.type === "text") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + evt.delta, ...(m.phase ? { phase: null } : {}) }
                    : m,
                ),
              );
            } else if (evt.type === "thinking") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, thinking: (m.thinking ?? "") + evt.delta } : m,
                ),
              );
            } else if (evt.type === "usage") {
              setLastUsage({
                inputTokens: evt.inputTokens,
                outputTokens: evt.outputTokens,
                cacheReadTokens: evt.cacheReadTokens,
                cacheWriteTokens: evt.cacheWriteTokens,
                cost: evt.cost,
              });
            } else if (evt.type === "done") {
              // Persisted assistant message id — needed so the reply can be rated.
              if (evt.messageId) {
                setMessages((prev) => {
                  // Resume race: the page loaded AFTER the reply was saved but
                  // the turn was still in its grace window — the replayed copy
                  // duplicates the loaded row. Keep the loaded one.
                  const alreadyLoaded = prev.some(
                    (m) =>
                      m.id !== assistantId &&
                      (m.dbId === evt.messageId || m.id === evt.messageId),
                  );
                  return alreadyLoaded
                    ? prev.filter((m) => m.id !== assistantId)
                    : prev.map((m) =>
                        m.id === assistantId
                          ? {
                              ...m,
                              dbId: evt.messageId,
                              createdAt: m.createdAt ?? new Date().toISOString(),
                            }
                          : m,
                      );
                });
              }
            } else if (evt.type === "error") {
              setError(evt.message);
            }
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : "Something went wrong.");
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // A turn that ended without a run_done (stream error, stop, an
        // escalation dropping its buffered calls) must not leave a live
        // code/console preview spinning forever — collapse it as-is. A question
        // card is the same hazard, and worse: it would stay clickable with
        // nothing on the other end.
        setAskBusy(false);
        setPendingAsk(null);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId &&
            m.activity?.some(
              (a) =>
                (a.kind === "run" && a.run.phase !== "done") ||
                (a.kind === "ask" && a.ask.status === "pending"),
            )
              ? {
                  ...m,
                  activity: m.activity.map((a) =>
                    a.kind === "run" && a.run.phase !== "done"
                      ? { ...a, run: { ...a.run, phase: "done" as const } }
                      : a.kind === "ask" && a.ask.status === "pending"
                        ? { ...a, ask: { ...a.ask, status: "dismissed" as const } }
                        : a,
                  ),
                }
              : m,
          ),
        );
        if (resolvedConvId && !incognito) {
          bump(resolvedConvId, new Date().toISOString());
          scheduleFollowups(resolvedConvId);
        }
        // Chime if the reply landed while the user was on another tab (§13).
        if (isTabInactive()) playCompletionChime();
      }
    },
    [incognito, upsert, patch, newItem, bump, scheduleFollowups],
  );

  // Start a turn (fresh send or retry/regenerate). The caller has already
  // appended the assistant placeholder (id === assistantId).
  const runStream = useCallback(
    async (
      payload: {
        content?: string;
        fileIds?: string[];
        regenerate?: boolean;
        editMessageId?: string;
        workflowId?: string;
      },
      assistantId: string,
      userLocalId?: string,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const startConvId = convId;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          // This tab's id: the live feed won't echo our own message and
          // "reply started" back to us (we already have both).
          headers: { "Content-Type": "application/json", "X-OI-Client": clientId },
          body: JSON.stringify({
            conversationId: startConvId,
            content: payload.content,
            fileIds: payload.fileIds,
            regenerate: payload.regenerate,
            editMessageId: payload.editMessageId,
            extendedThinking: thinkHard,
            incognito,
            // A hand-picked workflow applies to THIS message. A retry re-runs
            // the same turn, so it carries over; an edit is a new message and
            // does not.
            workflowId: payload.workflowId,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 503 && data.maintenance) {
            // A deploy is in progress. Give the message back rather than
            // leaving an empty reply bubble and losing what they typed.
            setMaintenance(data.error as string);
            setMessages((prev) =>
              prev.filter((m) => m.id !== assistantId && m.id !== userLocalId),
            );
            if (payload.content) {
              setInput((prev) => prev || payload.content!);
              requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (el) autosize(el);
              });
            }
            setStreaming(false);
            abortRef.current = null;
            return;
          }
          throw new Error(data.error ?? `Request failed (${res.status}).`);
        }
        setMaintenance(null);
        await processStream(res, assistantId, startConvId, !startConvId, userLocalId);
      } catch (e) {
        // processStream cleans up after itself — this handles pre-stream
        // failures (request rejected before any SSE arrived).
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : "Something went wrong.");
        }
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [convId, thinkHard, incognito, processStream, clientId],
  );

  // Re-attach to a reply that's still generating server-side — the user
  // navigated away mid-turn (other chat, refresh, second tab) and came back.
  // Replays everything missed, then follows live; 204 = nothing to resume.
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/chat/stream?conversationId=${encodeURIComponent(conversationId)}`,
          { signal: controller.signal },
        );
        if (cancelled || res.status !== 200 || !res.body) return;
        abortRef.current = controller;
        const assistantId = uid();
        setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);
        setStreaming(true);
        await processStream(res, assistantId, conversationId, false);
      } catch {
        /* nothing to resume, or we detached */
      }
    })();
    return () => {
      cancelled = true;
      // Detach only — generation is server-side and keeps running.
      controller.abort();
    };
  }, [conversationId, processStream]);

  const send = useCallback(
    async (content: string) => {
      if (!assistant.configured) {
        setError("The assistant isn't configured yet.");
        return;
      }
      setError(null);
      setLastUsage(null);
      setFollowups([]);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      const sent = attachments;
      const fileIds = sent.map((a) => a.id);
      setAttachments([]);
      // Attachments ride the user turn they were sent with — the chips move
      // from the composer strip onto the message bubble.
      const userLocalId = uid();
      const userMsg: UIMessage = {
        id: userLocalId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        ...(me ? { author: me } : {}),
        ...(sent.length ? { files: sent } : {}),
      };
      const assistantId = uid();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setStreaming(true);
      // The chosen workflow rides THIS message and is then cleared, so it can
      // never quietly shape a later one.
      const useWorkflow = picked?.id;
      setPicked(null);
      await runStream({ content, fileIds, workflowId: useWorkflow }, assistantId, userLocalId);
    },
    // `picked` belongs here: it is read inside the callback, so leaving it out
    // would freeze it at null and a chosen workflow would never be sent.
    [assistant.configured, attachments, runStream, me, picked],
  );

  // Retry: regenerate the last reply. Drops the trailing assistant message(s)
  // and re-streams over the same user turn (no duplicate user message).
  const regenerate = useCallback(() => {
    if (streaming || !convId || !assistant.configured) return;
    setError(null);
    setLastUsage(null);
    setFollowups([]);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const assistantId = uid();
    setMessages((prev) => {
      const next = [...prev];
      while (next.length > 0 && next[next.length - 1].role === "assistant") next.pop();
      return [...next, { id: assistantId, role: "assistant", content: "" }];
    });
    setStreaming(true);
    void runStream({ regenerate: true }, assistantId);
  }, [streaming, convId, assistant.configured, runStream]);

  // Edit-and-revert a sent user message (owner decision: permanent, not a
  // branch). Optimistically truncates the thread at that turn, swaps in the
  // edited message, and re-runs the assistant; the server deletes the
  // discarded rows + their files before streaming the fresh reply.
  const editMessage = useCallback(
    (index: number, content: string, keptFiles: Attachment[]) => {
      if (streaming || !assistant.configured || !convId) return;
      // Read the CURRENT thread, not the one captured when this callback was
      // built: that keeps the callback stable, which is what lets MessageBubble
      // be memoised (see its comparator) — and it is also more correct, since
      // the array is read at click time.
      const target = messagesRef.current[index];
      if (!target || target.role !== "user" || !target.dbId) return;
      setError(null);
      setLastUsage(null);
      setFollowups([]);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      const userLocalId = uid();
      const userMsg: UIMessage = {
        id: userLocalId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        ...(me ? { author: me } : {}),
        ...(keptFiles.length ? { files: keptFiles } : {}),
      };
      const assistantId = uid();
      setMessages((prev) => [
        ...prev.slice(0, index),
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setStreaming(true);
      void runStream(
        {
          content,
          fileIds: keptFiles.map((f) => f.id),
          editMessageId: target.dbId,
        },
        assistantId,
        userLocalId,
      );
    },
    [streaming, assistant.configured, convId, runStream, me],
  );

  // Thumbs up/down on a reply (optimistic; persisted to messages.meta).
  const rate = useCallback((dbId: string, rating: "up" | "down" | null) => {
    setMessages((prev) => prev.map((m) => (m.dbId === dbId ? { ...m, rating } : m)));
    void rateMessage(dbId, rating);
  }, []);

  // A message sent while a reply is streaming (§14, v0.5): the SERVER holds
  // it — offered to the running task as a steer and otherwise sent as its own
  // turn the moment the reply ends, so nothing depends on this tab staying
  // open and everyone in the chat sees the chip. `queued:false` means the
  // reply already finished: send it normally.
  const scheduleMessage = useCallback(
    async (content: string) => {
      if (!convId) return;
      const sent = attachments;
      setAttachments([]);
      try {
        const res = await fetch("/api/chat/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OI-Client": clientId },
          body: JSON.stringify({
            conversationId: convId,
            content,
            fileIds: sent.map((a) => a.id),
            extendedThinking: thinkHard,
            workflowId: picked?.id,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { queued?: boolean; error?: string };
        if (!res.ok) {
          setError(data.error ?? "Couldn't schedule that message.");
          setAttachments(sent);
          return;
        }
        if (!data.queued) {
          setAttachments(sent);
          await send(content);
        }
      } catch {
        setError("Couldn't schedule that message.");
        setAttachments(sent);
      }
    },
    [convId, attachments, clientId, thinkHard, send],
  );

  const cancelQueued = useCallback(
    (id: string) => {
      if (!convId) return;
      void fetch("/api/chat/queue", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, id }),
      }).catch(() => {});
    },
    [convId],
  );

  // Attach to a reply running server-side that THIS tab did not start —
  // someone else's send, or a scheduled message the server ran. Replays what
  // was missed, then follows live. No-op while already following one.
  const attachToTurn = useCallback(
    async (id: string) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/api/chat/stream?conversationId=${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (res.status !== 200 || !res.body) {
          if (abortRef.current === controller) abortRef.current = null;
          return;
        }
        const assistantId = uid();
        setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);
        setStreaming(true);
        setFollowups([]);
        await processStream(res, assistantId, id, false);
      } catch {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [processStream],
  );

  // Reload the thread from the server: the transcript changed on another
  // screen (edit / retry) or the live feed reconnected. A reply streaming
  // into this screen right now is kept.
  const reloadThread = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/thread?conversationId=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setAccessLost("removed");
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages: UIMessage[];
        followups?: string[];
        queue?: QueuedMessageView[];
        shared?: boolean;
        compactedThroughId?: string | null;
      };
      setMessages((prev) => {
        const loadedIds = new Set(data.messages.map((m) => m.dbId ?? m.id));
        const live = abortRef.current
          ? prev.filter((m) => m.role === "assistant" && !m.dbId && !loadedIds.has(m.id))
          : [];
        return [...data.messages, ...live];
      });
      setQueue(data.queue ?? []);
      setSharedNow(!!data.shared);
      setCompactedThroughId(data.compactedThroughId ?? null);
      if (!abortRef.current) setFollowups((data.followups ?? []).slice(0, 3));
    } catch {
      /* the next event, or the next reload, catches up */
    }
  }, []);

  // The live feed (v0.5): what the OTHER screens in this chat did.
  useLiveEvents((ev: LiveEventData) => {
    const id = convId;
    if (!id || ev.conversationId !== id) return;
    // Once this screen has lost access nothing further is rendered from the
    // feed (the server also detaches the connection; belt and braces).
    if (accessLostRef.current && ev.type !== "chat_removed" && ev.type !== "chat_deleted") return;
    switch (ev.type) {
      case "message": {
        const msg = ev.message as UIMessage;
        setMessages((prev) =>
          prev.some((m) => (msg.dbId && m.dbId === msg.dbId) || m.id === msg.id) ? prev : [...prev, msg],
        );
        setFollowups([]);
        break;
      }
      case "turn_started":
        void attachToTurn(id);
        break;
      case "queue":
        setQueue((ev.items as QueuedMessageView[]) ?? []);
        break;
      case "queue_failed":
        setError(
          `Couldn't send the scheduled message "${String(ev.content ?? "").slice(0, 60)}": ${String(ev.error ?? "")}`,
        );
        break;
      case "people":
        setSharedNow(!!ev.shared);
        break;
      case "thread_changed":
      case "resync":
        void reloadThread(id);
        break;
      case "chat_removed":
        accessLostRef.current = true;
        setAccessLost("removed");
        abortRef.current?.abort();
        break;
      case "chat_deleted":
        accessLostRef.current = true;
        setAccessLost("deleted");
        abortRef.current?.abort();
        break;
    }
  });

  /**
   * Deliver answers to the waiting question card. The card is retired by the
   * `ask_done` event that follows, not here, so the pause and the UI can never
   * disagree — except when the server says the card is stale (the turn ended
   * under it), where nothing more is coming and it has to go now.
   */
  const answerAsk = useCallback(
    async (askId: string, answers: DraftAnswer[]) => {
      if (!convId) return;
      setAskBusy(true);
      try {
        const res = await fetch("/api/chat/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, askId, answers }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { stale?: boolean };
          if (data.stale) {
            // The turn ended under the card — nothing is waiting, so retire it.
            setPendingAsk((cur) => (cur && cur.id === askId ? null : cur));
          } else {
            // A network blip or a 500. Keep the card UP: it used to be removed
            // while the message said "please try again", leaving nothing to try
            // again with — the composer no longer routed typed text to the ask,
            // and the reply sat parked until the five-minute timeout.
            setAskBusy(false);
            setError("Couldn't send that answer. Please try again.");
          }
        }
      } catch {
        setAskBusy(false);
        setError("Couldn't send that answer. Please try again.");
      }
    },
    [convId],
  );

  /** Dismiss the card outright: every question skipped, so the assistant picks
   *  sensible defaults and carries on rather than waiting out the timeout. */
  const dismissAsk = useCallback(() => {
    const ask = pendingAsk;
    if (!ask || askBusy) return;
    void answerAsk(
      ask.id,
      ask.questions.map(() => ({ skipped: true })),
    );
  }, [pendingAsk, askBusy, answerAsk]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // "Or reply directly…": with a question on screen, a typed message IS the
    // answer to the one currently showing — it must not queue behind the reply
    // that's waiting for it. Anything not yet reached counts as skipped, which
    // is what typing past the menu means.
    if (pendingAsk && !askBusy) {
      const { index, answers } = askDraftRef.current;
      const next = pendingAsk.questions.map((_, i) =>
        i < index ? (answers[i] ?? { skipped: true }) : i === index ? { chosen: [trimmed] } : { skipped: true },
      );
      void answerAsk(pendingAsk.id, next);
      return;
    }
    if (streaming && convId) {
      // Reply in progress → the server schedules it (and offers it to the
      // running task as a steer — the chip says which path it took).
      void scheduleMessage(trimmed);
      return;
    }
    void send(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as FormEvent);
    }
  };

  // Paste-to-attach: a screenshot (or files copied from the file manager)
  // pasted into the composer becomes an attachment — no drag/drop or picker
  // needed. Plain text pastes are untouched. Chromium names clipboard images
  // "image.png"; stamp those so multiple pastes stay distinguishable.
  const onPaste = (e: React.ClipboardEvent) => {
    if (!assistant.configured) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const named = files.map((f) => {
      if (!/^image\.[a-z0-9]+$/i.test(f.name)) return f;
      const ext = f.name.split(".").pop();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      return new File([f], `pasted-${stamp}.${ext}`, { type: f.type });
    });
    void uploadFiles(named);
  };

  const pickSuggestion = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autosize(ta);
    });
  };

  // --- drag & drop ---------------------------------------------------------
  const onDragEnter = (e: React.DragEvent) => {
    if (!assistant.configured) return;
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (dragging) e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!assistant.configured) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void uploadFiles(e.dataTransfer.files);
  };

  const firstName = userName?.trim().split(/\s+/)[0] ?? "";
  const greeting = firstName
    ? formatWelcome(WELCOME_MESSAGES[welcomeIdx], firstName)
    : "How can I help today?";

  const composer = (
    <div>
      {/* A question the reply is parked on. Directly above the composer so it
          can't be scrolled away from, with the composer still live underneath
          for "Or reply directly…". */}
      {pendingAsk ? (
        <AskCard
          ask={pendingAsk}
          busy={askBusy}
          onProgress={onAskProgress}
          onSubmit={(answers) => void answerAsk(pendingAsk.id, answers)}
          onDismiss={dismissAsk}
        />
      ) : null}
      {maintenance ? (
        // A planned update is not a failure — amber and calm, not a red error,
        // and it says when to come back rather than what went wrong.
        <p
          role="status"
          data-maintenance
          className="mb-2 flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <Spinner />
          {maintenance}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}

      {attachments.length > 0 || uploading || transcribing ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((f) => (
            <FileChip key={f.id} file={f} onRemove={() => removeAttachment(f.id)} />
          ))}
          {uploading ? (
            <span className="inline-flex items-center rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
              Uploading…
            </span>
          ) : null}
          {transcribing ? (
            <span className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted">
              <span className="h-3 w-3 animate-spin rounded-full border border-muted border-t-transparent" />
              Transcribing…
            </span>
          ) : null}
        </div>
      ) : null}

      {queue.length > 0 ? (
        <div className="mb-2 space-y-1" data-queue>
          {queue.map((q) => {
            const own = q.userId === me?.id;
            const who = sharedNow || !own ? ` — ${own ? "you" : q.author.name}` : "";
            return (
              <div
                key={q.id}
                data-queued={q.id}
                data-queued-steering={q.steering ? "1" : "0"}
                data-queued-by={q.userId}
                className="flex items-center justify-between gap-2 rounded-2xl border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-foreground">
                  <span className="font-medium text-accent">
                    {q.steering ? "Steering the task" : "Scheduled"}
                    {who}:
                  </span>{" "}
                  {q.content}
                  {q.fileCount > 0 ? (
                    <span className="text-muted"> (+{q.fileCount} file{q.fileCount === 1 ? "" : "s"})</span>
                  ) : null}
                </span>
                {canCancelQueued(role, q.userId, me?.id ?? "") ? (
                  <button
                    type="button"
                    onClick={() => cancelQueued(q.id)}
                    aria-label="Cancel scheduled message"
                    className="shrink-0 rounded px-1.5 py-0.5 text-muted transition-colors hover:text-foreground"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <form
        onSubmit={onSubmit}
        onPaste={onPaste}
        className="rounded-3xl border border-border bg-surface shadow-sm transition-colors focus-within:border-accent/50"
      >
        {recorder.recording ? (
          <div className="flex items-center gap-3 px-3 py-3">
            <button
              type="button"
              onClick={recorder.cancel}
              aria-label="Cancel recording"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <XIcon />
            </button>
            <div className="min-w-0 flex-1">
              <RecordingWave analyser={recorder.analyser} />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {fmtElapsed(recorder.elapsedMs)}
            </span>
            <button
              type="button"
              onClick={() => void finishRecording()}
              aria-label="Stop and transcribe"
              title="Stop and transcribe"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
            >
              <CheckIcon />
            </button>
          </div>
        ) : (
          <>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autosize(e.target);
          }}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={!assistant.configured}
          placeholder={
            !assistant.configured
              ? "Assistant not configured"
              : pendingAsk
                ? "Or reply directly…"
                : "How can I help you today?"
          }
          className="max-h-52 w-full resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus-visible:outline-none disabled:opacity-60"
        />
        {picked ? (
          <div className="px-2.5 pb-1.5">
            <span
              data-picked-workflow={picked.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent"
            >
              <span className="shrink-0 opacity-80">Using workflow</span>
              <span className="truncate font-medium">{picked.name}</span>
              <button
                type="button"
                aria-label="Don't use this workflow"
                onClick={() => setPicked(null)}
                className="shrink-0 rounded-full p-0.5 transition-colors hover:bg-accent/20"
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M4.5 4.5l7 7m0-7-7 7" />
                </svg>
              </button>
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex items-center gap-2">
            <ComposerMenu
              disabled={streaming || uploading || !assistant.configured}
              onAttach={() => fileInputRef.current?.click()}
              onPickWorkflow={setPicked}
            />
            {assistant.canThinkHard ? (
              <button
                type="button"
                onClick={() => setThinkHard((v) => !v)}
                aria-pressed={thinkHard}
                title="Extended thinking — slower, but more thorough"
                disabled={!assistant.configured}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors disabled:opacity-50 ${
                  thinkHard
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                <BrainIcon />
                Think
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2.5">
            {showUsage && lastUsage ? (
              // "in" = EVERY prompt token the model processed: uncached +
              // cache reads + cache WRITES (a first turn writes nearly the
              // whole prompt to cache — omitting writes showed "2 in").
              <span
                className="hidden text-xs text-muted sm:inline"
                title={`Prompt: ${lastUsage.inputTokens} uncached + ${lastUsage.cacheReadTokens} cache read + ${lastUsage.cacheWriteTokens} cache write. Output includes thinking tokens and every tool round this turn.`}
              >
                {lastUsage.inputTokens + lastUsage.cacheReadTokens + lastUsage.cacheWriteTokens} in ·{" "}
                {lastUsage.outputTokens} out · ${lastUsage.cost.toFixed(5)}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Dictate a message"
              title="Dictate a message (speech-to-text)"
              onClick={() => void recorder.start()}
              disabled={streaming || uploading || transcribing || !assistant.configured}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
            >
              <MicIcon />
            </button>
            {streaming && !input.trim() ? (
              // Streaming with nothing typed → the button stops the reply.
              <button
                type="button"
                onClick={stop}
                aria-label="Stop"
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground transition-colors hover:bg-foreground/20"
              >
                <StopIcon />
              </button>
            ) : (
              // Idle, OR streaming with text typed: SEND. Mid-stream it
              // queues/steers (handleSubmit's streaming path) — clicking must
              // never accidentally stop the running reply.
              <button
                type="submit"
                aria-label="Send"
                disabled={!input.trim() || !assistant.configured}
                className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void uploadFiles(e.target.files)}
        />
      </form>
    </div>
  );

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {incognito ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-accent/20 bg-accent/5 px-4 py-1.5 text-xs font-medium text-accent">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8.5c2 0 3-1 4.5-1S10 9 12 9s2.5-1.5 4.5-1.5S19 8.5 21 8.5v3c0 3-2.5 5-5 5-1.6 0-2.4-.9-4-.9s-2.4.9-4 .9c-2.5 0-5-2-5-5z" />
          </svg>
          Incognito — this chat is deleted when you leave.
        </div>
      ) : null}

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent px-10 py-7 text-center">
            <p className="text-sm font-medium text-foreground">Drop files to attach</p>
          </div>
        </div>
      ) : null}

      {accessLost ? (
        // Removed from the chat, or the owner deleted it, while it was open
        // (v0.5). The thread is gone from under us; say so and offer the way
        // out rather than leaving a composer that would only 404.
        <div className="flex h-full flex-col items-center justify-center px-4" data-access-lost={accessLost}>
          <div className="oi-fade-in max-w-md rounded-2xl border border-border bg-surface px-6 py-5 text-center">
            <p className="text-sm font-medium text-foreground">
              {accessLost === "deleted"
                ? "This chat was deleted by its owner."
                : "You no longer have access to this chat."}
            </p>
            <Link
              href="/chat"
              className="mt-3 inline-block rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Back to chats
            </Link>
          </div>
        </div>
      ) : empty ? (
        <div className="flex h-full flex-col items-center justify-center px-4">
          {mounted ? (
            <div className="oi-fade-in w-full max-w-[720px]">
              <div className="mb-7 flex items-center justify-center gap-3">
                <AssistantMark assistant={assistant} className="h-9 w-9" />
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting}</h1>
              </div>
              {composer}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => pickSuggestion(s.prompt)}
                    disabled={!assistant.configured}
                    className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm text-muted transition-colors hover:border-accent/40 hover:text-foreground disabled:opacity-50"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {!assistant.configured ? (
                <p className="mt-6 text-center text-sm text-muted">
                  An admin needs to configure the assistant in Admin → Models.
                </p>
              ) : null}
              <p className="mt-7 text-center text-xs text-muted/70">
                {APP_NAME} · v{APP_VERSION}
              </p>
            </div>
          ) : (
            <div role="status" aria-label="Loading" className="flex items-center justify-center">
              <Spinner />
            </div>
          )}
        </div>
      ) : (
        <>
          <div ref={scrollRef} data-chat-scroll className="oi-scroll flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[800px] space-y-4 px-4 py-6">
              {messages.map((m, i) => {
                const last = i === messages.length - 1;
                return (
                  <div key={m.id} className="space-y-4">
                  <MessageBubble
                    message={m}
                    streaming={streaming && last && m.role === "assistant"}
                    isLast={last}
                    laterCount={messages.length - 1 - i}
                    canListen={ttsEnabled}
                    showAuthor={sharedNow}
                    onRetry={
                      last && m.role === "assistant" && !streaming ? regenerate : undefined
                    }
                    onRate={m.dbId ? (r) => rate(m.dbId!, r) : undefined}
                    onEdit={
                      m.role === "user" &&
                      m.dbId &&
                      !streaming &&
                      assistant.configured &&
                      // Your own message, and nobody else's words after it —
                      // the revert deletes everything below (shared chats).
                      canEditMessage({
                        me: me?.id ?? "",
                        message: { role: "user", userId: m.author?.id ?? me?.id ?? "" },
                        later: messages.slice(i + 1).map((x) => ({
                          role: x.role,
                          userId: x.role === "user" ? (x.author?.id ?? me?.id ?? "") : null,
                        })),
                      })
                        ? (content, keptIds) =>
                            editMessage(
                              i,
                              content,
                              (m.files ?? []).filter((f) => keptIds.includes(f.id)),
                            )
                        : undefined
                    }
                  />
                  {compactedThroughId && (m.dbId ?? m.id) === compactedThroughId ? (
                    <CompactionDivider />
                  ) : null}
                  </div>
                );
              })}
              {followups.length > 0 && !streaming ? (
                <FollowUps suggestions={followups} onPick={(s) => void send(s)} />
              ) : null}
              {/* Sticky INSIDE the scroller (not a floating sibling) so wheel
                  events over the button still chain to the thread scroll. The
                  h-0 anchor keeps it out of layout; items-end hangs the button
                  upward so it never clips below the scrollport edge. */}
              <div className="pointer-events-none sticky bottom-3 z-10 flex h-0 items-end justify-center">
                <button
                  type="button"
                  onClick={jumpToBottom}
                  aria-label="Scroll to bottom"
                  aria-hidden={!showJump}
                  tabIndex={showJump ? 0 : -1}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-md transition-all duration-200 hover:border-accent/40 hover:text-foreground ${
                    showJump
                      ? "pointer-events-auto translate-y-0 opacity-100"
                      : "pointer-events-none translate-y-1.5 opacity-0"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 5v14M6 13l6 6 6-6" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <div className="oi-safe-b px-4 pt-1">
            <div className="mx-auto w-full max-w-[760px]">
              {composer}
              <p className="mt-1.5 text-center text-xs text-muted">
                Enter to send · Shift+Enter for a new line · {assistant.name} can make mistakes.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AssistantMark({
  assistant,
  className,
}: {
  assistant: AssistantIdentity;
  className?: string;
}) {
  if (assistant.logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={`/api/branding/${assistant.logo}`}
        alt=""
        className={`rounded-lg object-contain ${className ?? ""}`}
      />
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent ${className ?? ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-2/3 w-2/3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 4.8L19 9.7l-4.1 2.9L16 18l-4-3-4 3 1.1-5.4L5 9.7l5.1-1.9z" />
      </svg>
    </span>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function Spinner() {
  return (
    <span
      className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent"
      aria-hidden="true"
    />
  );
}
function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 4 8a2.5 2.5 0 0 0 1 2 2.5 2.5 0 0 0 0 4 2.5 2.5 0 0 0 1.5 2.5A2.5 2.5 0 0 0 9 19a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2ZM15 3a2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 20 8a2.5 2.5 0 0 1-1 2 2.5 2.5 0 0 1 0 4 2.5 2.5 0 0 1-1.5 2.5A2.5 2.5 0 0 1 15 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    </svg>
  );
}
