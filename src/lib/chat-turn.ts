import "server-only";
import type { Prisma } from "@prisma/client";
import sharp from "sharp";
import { stat } from "node:fs/promises";
import { db } from "@/lib/db";
import { buildAssistantSystemBlock, getAssistantConfig } from "@/lib/assistant";
import { runAssistant, recordUsage, generateTitle } from "@/lib/pipeline";
import { buildFileManifest, loadImagesForTurn } from "@/lib/file-tools";
import { deleteStoredFile, resolveStoredPathForRead } from "@/lib/storage";
import { buildToolset } from "@/lib/tools/registry";
import { buildMemoryBlock, memoryPausedFor } from "@/lib/tools/memory";
import { orderThreadRows } from "@/lib/thread-order";
import { compactConversation, compactedHistory, loadCompaction, replayedTokens } from "@/lib/compaction";
import { getCachedTokenLimits } from "@/lib/limits";
import { buildSkillsBlock } from "@/lib/tools/skills";
import { estimateImageMs } from "@/lib/tools/images";
import { VizStreamParser, type VizEvent } from "@/lib/viz-stream";
import { VIZ_PROTOCOL_BLOCK } from "@/lib/tools/visualize";
import { buildProgressiveToolset } from "@/lib/tools/disclosure";
import type { ToolGroup } from "@/lib/tools/types";
import type { ToolRunRecord } from "@/lib/tool-run";
import { appLog } from "@/lib/applog";
import { devLog } from "@/lib/dev-log";
import { isDraining } from "@/lib/drain";
import { annotateAssistantContent, stoppedTurnNote } from "@/lib/provenance";
import { closeInterjectionMailbox, openInterjectionMailbox } from "@/lib/interject";
import { dismissAsk } from "@/lib/ask-mailbox";
import type { AskRecord } from "@/lib/ask";
import { chatAccess, chatMemberIds, peopleById, type Person } from "@/lib/chat-access";
import { canEditMessage, displayName, memoryAllowed } from "@/lib/chat-rules";
import { sidebarItemFor } from "@/lib/chat-items";
import { publishToChat, publishToUsers } from "@/lib/live";
import { queueSnapshot, removeQueued, requeueFront, shiftQueued } from "@/lib/chat-queue";
import {
  startTurn,
  publishTurn,
  endTurn,
  hasActiveTurn,
  armTurnHardStop,
  clearTurnHardStop,
  type TurnEvent,
  type TurnStream,
} from "@/lib/turn-stream";
import type { ChatMessage, TokenUsage } from "@/lib/providers/types";

/**
 * ONE assistant turn, start to finish — the body that used to live inline in
 * `POST /api/chat`. Pulled out (v0.5 shared chats) because a turn now starts
 * from TWO places: the HTTP route, and the server-side scheduled queue, which
 * runs the next lined-up message the moment a reply ends with no browser
 * involved. Everything the route did is still here, in the same order; the
 * route is now a thin auth + parse + subscribe wrapper.
 *
 * Generation is DETACHED from whoever started it: every event is published
 * into the conversation's TurnStream (`turn-stream.ts`) and the route merely
 * subscribes, so leaving the page never stops a reply.
 *
 * Shared-chat additions, all marked "v0.5" below: the user turn is stamped
 * with its author; the live feed tells the other people's screens about the
 * message and that a reply started (they attach to the same stream); a
 * message spliced in mid-turn drops its copy from the scheduled queue; a
 * question card records who answered; personal memory stays out of shared
 * chats; and when the turn ends the sidebar of every member is bumped and the
 * queue's next entry runs.
 */

export interface TurnInput {
  userId: string;
  conversationId: string | null;
  content?: string;
  /** Files uploaded via /api/files, attached to this turn (manifest/vision). */
  fileIds?: string[];
  /** User toggled "think harder" — server swaps to the admin's extended level. */
  extendedThinking?: boolean;
  /** Ephemeral chat — flagged so it's auto-deleted on leave and hidden from the sidebar. */
  incognito?: boolean;
  /** Retry: regenerate the last assistant reply (no new user turn is added). */
  regenerate?: boolean;
  /** Edit-and-revert: PERMANENTLY delete this user message and everything
   *  after it (including files attached to the removed turns), then send
   *  `content` (+ kept `fileIds`) as the new turn from that point. */
  editMessageId?: string;
  /** The browser tab that sent it — its own live echoes are skipped. */
  origin?: string;
}

export type TurnStartResult =
  | { ok: true; turn: TurnStream; conversationId: string }
  | { ok: false; status: number; error: string };

/** Provisional title used until the front-end model generates the real one. */
function fallbackTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/** Presented files that are displayable images render INLINE (the
 *  generated-image card flow) instead of as a download chip — a presented
 *  chart IS the chart. Sandbox-generated rows carry a generic
 *  application/octet-stream mime (syncPool; the worker's detection lands in
 *  detectedMime later), so the extension decides too. Returns the effective
 *  image mime, or null for "render as a card". */
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const INLINE_IMAGE_EXTS: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
function inlineImageMime(filename: string, mimeType: string): string | null {
  if (INLINE_IMAGE_MIMES.has(mimeType)) return mimeType;
  return INLINE_IMAGE_EXTS[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** A number that changes whenever the file's bytes do (mtime ms) — the
 *  image URL's ?v= cache-buster. Falls back to "now" if the stat fails. */
async function fileVersion(storagePath: string): Promise<number> {
  try {
    return Math.round((await stat(await resolveStoredPathForRead(storagePath))).mtimeMs);
  } catch {
    return Date.now();
  }
}

/** "W:H" for the inline-image placeholder box; safe fallback on any failure
 *  (corrupt file, race with the worker — the box just starts 4:3). */
async function imageAspectRatio(storagePath: string): Promise<string> {
  try {
    const meta = await sharp(await resolveStoredPathForRead(storagePath)).metadata();
    if (meta.width && meta.height) return `${meta.width}:${meta.height}`;
  } catch {
    /* fall through */
  }
  return "4:3";
}

/** How long the turn will hold for attachment ingestion before proceeding
 *  with whatever is ready (the manifest marks the stragglers honestly). */
const INGEST_WAIT_MAX_MS = 3 * 60_000;
const INGEST_POLL_MS = 1_000;

/** Hold the turn until this message's attachments finish ingesting (ready /
 *  unsupported / failed all count as "finished" — the manifest handles each
 *  honestly). Streams `phase` events, which the UI shows INSIDE the animated
 *  thinking indicator (and clears when the wait ends, so the shimmering
 *  gerund resumes — a tool line would go stale and stick). Returns early if
 *  the turn is stopped. */
async function waitForTurnFiles(
  send: (obj: TurnEvent) => void,
  fileIds: string[],
  signal: AbortSignal,
): Promise<void> {
  const t0 = Date.now();
  let announced = false;
  let announcedSlow = false;
  const done = (finalToolNote?: string) => {
    if (announced) send({ type: "phase", label: null });
    if (finalToolNote) send({ type: "tool", label: finalToolNote });
  };
  for (;;) {
    const busy = await db.file.findMany({
      where: { id: { in: fileIds }, status: { in: ["pending", "processing"] } },
      select: { filename: true },
    });
    if (busy.length === 0 || signal.aborted) return done();
    if (Date.now() - t0 > INGEST_WAIT_MAX_MS) {
      devLog("warn", "chat", "ingestion wait timed out", {
        fileIds,
        stillBusy: busy.map((b) => b.filename),
      });
      return done("Some attachments are still processing — answering with what's ready.");
    }
    if (!announced) {
      announced = true;
      send({
        type: "phase",
        label:
          busy.length === 1
            ? `Processing ${busy[0].filename}…`
            : `Processing ${busy.length} attachments…`,
      });
    } else if (!announcedSlow && Date.now() - t0 > 20_000) {
      announcedSlow = true;
      send({ type: "phase", label: "Still processing (transcription can take a minute)…" });
    }
    await new Promise((r) => setTimeout(r, INGEST_POLL_MS));
  }
}

/** Map stored messages into the provider-neutral chat shape (drop tool roles).
 *  Assistant turns that used tools get an LLM-side provenance note appended
 *  (from meta.sources) so the model doesn't disown its own sourced replies on
 *  later turns — tool rounds themselves aren't persisted. */
function toChatMessages(
  rows: { role: string; content: string; meta?: unknown }[],
): ChatMessage[] {
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant" || r.role === "system")
    // A reply can be saved with no text at all — one that was only a
    // visualisation or a generated image, or one stopped just after a tool
    // call. Replaying an empty assistant turn adds nothing and is rejected
    // outright by Anthropic and Google; the mappers now drop it too, but it
    // should never reach them.
    // …except a turn the user STOPPED before any prose: that row is kept and
    // replayed as a note saying so, or the model sees the request with no
    // reply at all and picks the job back up unasked (see provenance.ts).
    .filter(
      (r) => r.role !== "assistant" || r.content.trim().length > 0 || !!stoppedTurnNote(r.meta),
    )
    .map((r) => ({
      role: r.role as ChatMessage["role"],
      content:
        r.role === "assistant"
          ? annotateAssistantContent(
              r.content.trim().length > 0 ? r.content : (stoppedTurnNote(r.meta) ?? r.content),
              r.meta ?? null,
            )
          : r.content,
    }));
}

/** The author shape that rides the stream and the live feed. */
export interface TurnAuthor {
  id: string;
  name: string;
  image: string | null;
}

function toAuthor(p: Person | undefined, id: string): TurnAuthor {
  return p
    ? { id: p.id, name: displayName(p), image: p.image }
    : { id, name: "Former member", image: null };
}

/**
 * Start a turn. Validates, persists the user message, registers the
 * resumable stream and kicks generation off DETACHED — returns as soon as the
 * stream exists so the caller can subscribe (the route) or move on (the
 * queue). Errors before the stream exists come back as `{ ok: false }` with
 * an HTTP status the route can pass straight through.
 */
export async function startChatTurn(input: TurnInput): Promise<TurnStartResult> {
  const { userId } = input;
  const regenerate = input.regenerate === true;

  devLog("info", "chat", "turn requested", {
    userId,
    conversationId: input.conversationId ?? "(new)",
    regenerate,
    incognito: !!input.incognito,
    extendedThinking: !!input.extendedThinking,
    fileIds: input.fileIds?.length ?? 0,
    content: input.content?.slice(0, 300),
  });

  // One turn per conversation at a time — a second tab (or a double submit)
  // must not interleave a parallel generation. Checked BEFORE any DB write.
  if (input.conversationId && hasActiveTurn(input.conversationId)) {
    return { ok: false, status: 409, error: "A reply is already being generated in this conversation." };
  }

  // The model + reasoning come from the admin's assistant config — never the
  // client. The conversation role is required for the assistant to answer.
  const config = await getAssistantConfig();
  const convoRole = config.roles.conversation;
  if (!convoRole) {
    return { ok: false, status: 503, error: "The assistant isn't configured yet. Ask an admin." };
  }

  // Resolve or create the conversation, then load prior turns for context.
  let conversationId = input.conversationId ?? null;
  let title: string | null = null;
  let history: ChatMessage[] = [];
  // The ordered DB rows behind `history` (compaction works on rows, not on
  // the mapped messages, and may rebuild `history` at the start of the turn).
  let threadRows: { id: string; role: string; content: string; createdAt: Date; userId?: string | null; meta?: unknown }[] = [];
  // True when an existing conversation receives its first user turn — happens
  // when the conversation was created on file attach (pool-first) rather than
  // by this route. Such chats still need the provisional + AI title passes.
  let firstTurn = false;
  // Incognito chats never see or write persistent user memory — and neither
  // do shared chats (v0.5): your memory is private, the replies are not.
  let useMemory = input.incognito !== true;
  // The request's incognito flag is only trusted for a chat created NOW; for
  // an existing chat the stored row wins (audit 2026-09-05: a member could
  // send into a shared chat with `incognito:true` and silence every other
  // screen's bubble, "reply started" and unread dot).
  let incognito = !!input.incognito;
  // v0.5: who else is in the chat (sidebar bumps at the end).
  let memberIds: string[] = [userId];
  let shared = false;
  // Other screens are told the transcript changed under them (edit/retry).
  let threadChanged = false;

  const loadConvo = async (id: string) => {
    const access = await chatAccess(id, userId);
    if (!access) return null;
    const convo = await db.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        members: { select: { userId: true } },
      },
    });
    // ONE order for the model, the screen and every other reader — a tie
    // on created_at (imported chats) must never be left to the database
    // (thread-order.ts: it shuffled a 633-message chat differently on every
    // turn and defeated the prompt cache).
    if (!convo) return null;
    convo.messages = orderThreadRows(convo.messages);
    return { convo, access };
  };

  if (regenerate) {
    // Retry: replace the last assistant reply in an existing conversation. Drop
    // the trailing assistant message(s) and re-run the pipeline over the history
    // that ends with the user's turn — no new user message is added.
    if (!conversationId) return { ok: false, status: 400, error: "Nothing to retry." };
    const loaded = await loadConvo(conversationId);
    if (!loaded) return { ok: false, status: 404, error: "Conversation not found." };
    const { convo, access } = loaded;
    const rows = convo.messages;
    const drop: string[] = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].role === "assistant"; i--) {
      drop.push(rows[i].id);
    }
    if (drop.length > 0) {
      await db.message.deleteMany({ where: { id: { in: drop } } });
      threadChanged = true;
    }
    useMemory = memoryAllowed(convo);
    incognito = convo.incognito;
    shared = access.shared;
    memberIds = access.memberIds;
    threadRows = rows.filter((r) => !drop.includes(r.id));
    history = compactedHistory(threadRows, await loadCompaction(conversationId, threadRows), toChatMessages);
    if (history.length === 0) return { ok: false, status: 400, error: "Nothing to retry." };
  } else if (conversationId) {
    const loaded = await loadConvo(conversationId);
    if (!loaded) return { ok: false, status: 404, error: "Conversation not found." };
    const { convo, access } = loaded;
    useMemory = memoryAllowed(convo);
    incognito = convo.incognito;
    shared = access.shared;
    memberIds = access.memberIds;
    let rows = convo.messages;

    if (input.editMessageId) {
      // Edit = REVERT (owner decision: permanent, not a branch): drop the
      // edited user message and every message after it, then fall through to
      // the normal send path so `content` becomes the new turn. Files that
      // rode the removed messages are deleted too — uploads the user dropped
      // from the edit AND anything generated by the discarded replies — so
      // the pool/manifest keeps matching what the conversation shows.
      const cut = rows.findIndex(
        (r) => r.id === input.editMessageId && r.role === "user",
      );
      if (cut === -1) {
        return { ok: false, status: 404, error: "Message not found in this conversation." };
      }
      // v0.5: only your own message, and only when nobody else has written
      // after it — the revert must never delete a colleague's words.
      const allowed = canEditMessage({
        me: userId,
        message: rows[cut],
        later: rows.slice(cut + 1),
      });
      if (!allowed) {
        return {
          ok: false,
          status: 403,
          error: "You can only edit your own message, and not once someone else has written after it.",
        };
      }
      const dropped = rows.slice(cut);
      rows = rows.slice(0, cut);

      const kept = new Set(input.fileIds ?? []);
      const dropFileIds = new Set<string>();
      for (const r of dropped) {
        const meta = r.meta as {
          fileIds?: string[];
          images?: { fileId: string }[];
        } | null;
        for (const fid of meta?.fileIds ?? []) if (!kept.has(fid)) dropFileIds.add(fid);
        for (const im of meta?.images ?? []) if (!kept.has(im.fileId)) dropFileIds.add(im.fileId);
      }

      await db.message.deleteMany({
        where: { id: { in: dropped.map((r) => r.id) }, conversationId },
      });
      if (dropFileIds.size > 0) {
        const doomed = await db.file.findMany({
          where: { id: { in: [...dropFileIds] }, conversationId },
        });
        if (doomed.length > 0) {
          await db.file.deleteMany({ where: { id: { in: doomed.map((f) => f.id) } } });
          for (const f of doomed) {
            await deleteStoredFile(f.storagePath).catch(() => {});
          }
        }
      }
      threadChanged = true;
      devLog("info", "chat", "edit-revert", {
        userId,
        conversationId,
        editMessageId: input.editMessageId,
        droppedMessages: dropped.length,
        droppedFiles: dropFileIds.size,
      });
    }

    threadRows = rows;
    // A compacted chat replays its summary plus the recent turns; a compaction
    // whose boundary row an edit just deleted is void and the full history goes.
    history = compactedHistory(threadRows, await loadCompaction(conversationId, threadRows), toChatMessages);
    if (rows.length === 0) {
      firstTurn = true;
      title = fallbackTitle(input.content!);
      await db.conversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }
  } else {
    title = fallbackTitle(input.content!);
    const convo = await db.conversation.create({
      data: { userId, title, incognito: input.incognito ?? false },
    });
    conversationId = convo.id;
  }

  const newConversationId = conversationId;

  // v0.5: the author of this turn, for the bubble on everyone's screen and
  // the avatar beside it. Cached per turn for interjections by others too.
  const people = await peopleById([userId]);
  const author = toAuthor(people.get(userId), userId);
  const authorOf = async (id: string): Promise<TurnAuthor> => {
    if (!people.has(id)) {
      for (const [k, v] of await peopleById([id])) people.set(k, v);
    }
    return toAuthor(people.get(id), id);
  };

  // Persisted id of this turn's user message — sent to the client on the
  // `meta` event so the bubble can be edit-reverted later without a reload.
  let savedUserMessageId: string | null = null;
  let savedUserCreatedAt: Date | null = null;
  if (!regenerate) {
    // meta.fileIds ties the attachments to THIS user turn, so the UI can
    // render the chips with the message (not pinned above the composer).
    const savedUser = await db.message.create({
      data: {
        conversationId,
        role: "user",
        content: input.content!,
        userId,
        ...(input.fileIds?.length ? { meta: { fileIds: input.fileIds } } : {}),
      },
    });
    savedUserMessageId = savedUser.id;
    savedUserCreatedAt = savedUser.createdAt;

    if (input.fileIds && input.fileIds.length > 0) {
      // Attach by CHAT, not uploader: in a shared chat the files may be a
      // colleague's, and they live in this pool either way.
      await db.file.updateMany({
        where: { id: { in: input.fileIds }, OR: [{ conversationId }, { userId, conversationId: null }] },
        data: { conversationId },
      });
    }
  }

  const provisionalTitle = title;
  // "New" = first user turn, whether the conversation was created just now or
  // earlier by a file attach — both need the AI title pass.
  const isNew = !input.conversationId || firstTurn;

  // Register the resumable turn stream (src/lib/turn-stream.ts). Generation
  // below is DETACHED from the caller: it publishes every event into the
  // TurnStream and runs to completion even if every client disconnects — the
  // HTTP response (and any later resume GET) is just a subscriber. Stopping is
  // explicit (POST /api/chat/stop aborts turn.abort), so the provider call is
  // keyed to the TURN's signal, never a request signal. A refusal here means
  // another turn won the race since the early guard — same 409.
  const turn = startTurn(newConversationId);
  if (!turn) {
    return { ok: false, status: 409, error: "A reply is already being generated in this conversation." };
  }
  // Backstop: a hung provider must never leave the conversation "active"
  // forever (every later POST would 409). The pipeline has its own bounds.
  // Owned by the turn (not a local timer) so the Sandbox agent tool can
  // extend it for a long run and snap it back after.
  armTurnHardStop(turn, 15 * 60_000);

  // v0.5 — tell the other screens. A changed transcript (edit/retry) makes
  // them reload; a plain send hands them the bubble; then "a reply started"
  // makes every screen attach to the stream registered just above. The tab
  // that sent it already has the bubble and is about to subscribe itself.
  if (!incognito) {
    if (threadChanged) {
      publishToChat(newConversationId, { type: "thread_changed" }, { exceptClient: input.origin });
    } else if (savedUserMessageId) {
      // Scoped to THIS chat's files (audit 2026-09-05): the ids are
      // client-supplied, and an unscoped lookup would broadcast any file's
      // name/size/status to the chat for a guessed id.
      const files = input.fileIds?.length
        ? await db.file.findMany({
            where: { id: { in: input.fileIds }, conversationId },
            select: { id: true, filename: true, mimeType: true, sizeBytes: true, status: true },
          })
        : [];
      publishToChat(
        newConversationId,
        {
          type: "message",
          message: {
            id: savedUserMessageId,
            dbId: savedUserMessageId,
            role: "user",
            content: input.content ?? "",
            createdAt: (savedUserCreatedAt ?? new Date()).toISOString(),
            author,
            ...(files.length
              ? {
                  files: files.map((f) => ({
                    id: f.id,
                    filename: f.filename,
                    mimeType: f.mimeType,
                    sizeBytes: Number(f.sizeBytes),
                    status: f.status,
                  })),
                }
              : {}),
          },
        },
        { exceptClient: input.origin },
      );
    }
    publishToChat(newConversationId, { type: "turn_started" }, { exceptClient: input.origin });
    if (!input.conversationId) {
      // A brand-new chat: the sender's OTHER tabs learn of it now; this tab
      // adds it from the `meta` event.
      const item = await sidebarItemFor(newConversationId, userId);
      if (item) publishToUsers([userId], { type: "chat_item", item }, { exceptClient: input.origin });
    }
  }

  const runTurn = async () => {
      const send = (obj: TurnEvent) => publishTurn(turn, obj);

      send({
        type: "meta",
        conversationId: newConversationId,
        title: provisionalTitle,
        userMessageId: savedUserMessageId,
        author,
      });

      // Accept mid-turn interjections for the whole turn (incl. the ingestion
      // wait below) — the tool loops drain them between rounds; anything
      // unconsumed is dropped on close and the scheduled queue sends it as
      // its own turn afterwards.
      openInterjectionMailbox(newConversationId);

      // Users may hit send while attachments are still ingesting (voice notes
      // transcribe asynchronously; big docs take a moment). Hold the turn HERE
      // — with a live "Processing…" status line — so the model only starts
      // once it can actually see the content, instead of answering without it.
      if (!regenerate && input.fileIds?.length) {
        await waitForTurnFiles(send, input.fileIds, turn.abort.signal);
      }

      // Conversation compaction (2026-09-10): once the history the reply
      // model would be sent reaches the admin's trigger, summarise the older
      // part with the front-end model FIRST, so this very call stays under
      // budget. A failure is logged inside and the full history goes instead
      // — tidying must never block a reply.
      if (threadRows.length > 0) {
        const limits = await getCachedTokenLimits();
        const before = await loadCompaction(newConversationId, threadRows);
        if (replayedTokens(threadRows, before) >= limits.compactAtTokens) {
          send({ type: "phase", label: "Summarising earlier messages…" });
          const result = await compactConversation({
            conversationId: newConversationId,
            userId,
            rows: threadRows,
            reason: "turn",
          });
          send({ type: "phase", label: null });
          if (result) {
            history = compactedHistory(threadRows, result.compaction, toChatMessages);
            send({ type: "compacted", throughMessageId: result.compaction.boundaryMessageId });
          }
        }
      }

      // Files layer: a compact manifest of the chat's storage pool (system
      // block) plus the list_files/read_file tools; this turn's attached
      // images ride the user message natively for vision-capable models.
      // Memory: the user's persistent memory block rides along too (never in
      // incognito, never in a shared chat). Built AFTER the ingestion wait so
      // the manifest inlines the freshly prepared content (e.g. the transcript).
      const [fileManifest, memoryBlock, skillsBlock, turnImages, memoryPaused] = await Promise.all([
        buildFileManifest(newConversationId),
        useMemory ? buildMemoryBlock(userId) : Promise.resolve(null),
        buildSkillsBlock(),
        regenerate
          ? Promise.resolve([])
          : loadImagesForTurn(newConversationId, input.fileIds),
        // Memory v2: a person who paused keeps their notes but the remember
        // tool is withheld (the block tells the model why).
        useMemory ? memoryPausedFor(userId) : Promise.resolve(false),
      ]);

      // Per-turn toolset: everything enabled for this instance, wrapped in
      // progressive disclosure — cheap always-useful tools live from round 1,
      // the heavier groups (web/image/sandbox/capability) listed in a
      // directory the model activates itself via enable_tools. The MODEL
      // decides what it needs; nothing pre-filters its options. Memory is
      // hard-excluded in incognito and shared chats.
      const toolset = await buildToolset(
        // The turn's signal rides along so a tool that WAITS on something
        // external (ask_user parks on the user's answer) is released the moment
        // the turn is stopped, instead of sitting until its own timeout.
        { userId, conversationId: newConversationId, signal: turn.abort.signal },
        {
          includeFiles: !!fileManifest,
          excludeGroups: useMemory ? undefined : (["memory"] as ToolGroup[]),
          excludeTools: memoryPaused ? ["memory_update"] : undefined,
        },
      );
      const progressive = buildProgressiveToolset(toolset);

      // Files the assistant HANDS OVER this turn (present_files / download
      // auto-present). The pool is its private workspace — nothing it creates
      // is user-visible until presented (owner call, 2026-07-19: a 10-script
      // task must not flood the chat with 11 cards). Images present INLINE
      // (the generated-image card); everything else becomes a download card.
      const presentedIds = new Set<string>();
      const presentedFileRows: { id: string; filename: string; mimeType: string; sizeBytes: bigint; status: string }[] = [];

      const userTurn: ChatMessage = {
        role: "user",
        content: input.content ?? "",
        ...(turnImages.length ? { images: turnImages } : {}),
      };
      const core: ChatMessage[] = regenerate ? history : [...history, userTurn];
      const systemBlocks: ChatMessage[] = [
        // Who this assistant is + the admin's standing instructions (Admin →
        // Customise). FIRST, ahead of memory/files/tools, and carried into the
        // escalation hand-off and the failover path because both replay this
        // same `messages` array. The front-end role builds its own prompts, so
        // titles and follow-ups are unaffected.
        { role: "system" as const, content: buildAssistantSystemBlock(config) },
        ...(memoryBlock ? [{ role: "system" as const, content: memoryBlock }] : []),
        ...(skillsBlock ? [{ role: "system" as const, content: skillsBlock }] : []),
        ...(fileManifest ? [{ role: "system" as const, content: fileManifest }] : []),
        // v0.5: in a shared chat the model should know it is talking to
        // several people, and address them by name when it matters.
        ...(shared
          ? [{
              role: "system" as const,
              content:
                "This is a SHARED chat: several people from the organisation are in it and all of them see every reply. " +
                "User turns may come from different people; when a turn names its author, address that person and keep track of who asked for what. " +
                `The message you are answering now is from ${author.name}.`,
            }]
          : []),
        // Inline visuals: taught up-front (no tool since 2026-07-13) so the
        // model emits @@@VIZ markers directly and the chart streams from its
        // first token. Gated on the Tools-page group toggle.
        ...(!toolset.disabledGroups.includes("visualize")
          ? [{ role: "system" as const, content: VIZ_PROTOCOL_BLOCK }]
          : []),
        ...(progressive.directory
          ? [{ role: "system" as const, content: progressive.directory }]
          : []),
      ];
      const messages: ChatMessage[] = [...systemBlocks, ...core];

      let assistantText = "";
      const vizBlocks: { title: string; html: string }[] = [];
      // Sources touched by web tools this turn — streamed live and persisted
      // on the saved message so the "Sources" panel survives reloads.
      const allSources: { url: string; title?: string }[] = [];
      const seenSourceUrls = new Set<string>();
      // Generated images this turn (first-class display, not a file chip):
      // persisted on the message; their file ids are suppressed from the chip
      // list so they don't render twice.
      const genImages: { fileId: string; mimeType: string; aspectRatio: string; prompt: string; operation: string; version?: number }[] = [];
      const genImageFileIds = new Set<string>();
      // Tool runs (sandbox family): live code/console previews stream as
      // run_* events; the accumulated record (capped) persists on the message
      // so the collapsed chips + their expandable code/output survive reloads.
      const toolRuns = new Map<string, ToolRunRecord>();
      const RUN_TEXT_CAP = 20_000;
      // Question cards raised this turn (ask_user). Persisted in meta.asks and
      // positioned in the activity log, so a reload still shows WHAT was asked
      // next to the answer the user gave — otherwise the reply would resume
      // mid-thought above a bare "Manchester" bubble with no visible question.
      const asks = new Map<string, AskRecord>();
      // Ordered activity log with TEXT OFFSETS (owner ask 2026-07-19):
      // Anthropic narrates between tool rounds, so each status line / run
      // block records `at` = reply-text length when it was emitted. The UI
      // re-interleaves prose and activity chronologically, and the log
      // persists in meta.activity so the interleave survives reloads
      // (plain status lines used to vanish on refresh entirely).
      // Code-delta arrival timing per run block (owner report 2026-09-02:
      // "the code appears all at once"). One devLog line per run says when
      // the first and last deltas reached THIS server relative to the block
      // starting — the fact that settles whether a burst is upstream (the
      // model/API/CLI delivering the tool input late) or downstream (relay,
      // SSE, browser). Debug level, dev.log only.
      const runTiming = new Map<string, { start: number; first: number; last: number; deltas: number; bytes: number }>();
      const logRunTiming = (id: string, phase: "exec" | "done") => {
        const t = runTiming.get(id);
        if (!t) return;
        runTiming.delete(id);
        const r = toolRuns.get(id);
        devLog("debug", "chat", "run_code timing", {
          conversationId: newConversationId,
          id,
          tool: r?.tool,
          file: r?.file,
          phase,
          deltas: t.deltas,
          bytes: t.bytes,
          msToFirstDelta: t.first ? t.first - t.start : null,
          msFirstToLast: t.first ? t.last - t.first : null,
          msStartToEnd: Date.now() - t.start,
        });
      };
      const activityLog: (
        | { kind: "status"; label: string; at: number }
        | { kind: "run"; id: string; at: number }
        | { kind: "ask"; id: string; at: number }
        // Deliverables surfaced mid-turn (owner ask 2026-09-02): positioned in
        // the timeline where they were presented, not lumped above the reply.
        | { kind: "image"; id: string; at: number }
        | { kind: "files"; ids: string[]; at: number }
      )[] = [];
      const ACTIVITY_CAP = 300;
      const turnStartedAt = Date.now();
      const answer = { provider: convoRole.provider as string, model: convoRole.model };
      const total: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let totalCost = 0;
      let errored: string | null = null;
      // Escalation/failover banner — persisted so it survives reloads.
      let notice: string | null = null;

      try {
        // Visualisation extraction: text deltas run through the marker
        // parser — viz content becomes dedicated SSE events (rendered in a
        // sandboxed iframe) and is persisted on the message, never shown as
        // raw text.
        const vizParser = new VizStreamParser();
        const onVizEvents = (events: VizEvent[]) => {
          for (const ev of events) {
            if (ev.kind === "text") {
              assistantText += ev.data;
              send({ type: "text", delta: ev.data });
            } else if (ev.kind === "start") {
              // Title rides the START marker line (parser-extracted).
              vizBlocks.push({ title: ev.title ?? "Visualization", html: "" });
              send({ type: "viz_start", title: ev.title ?? "Visualization" });
            } else if (ev.kind === "viz") {
              if (vizBlocks.length === 0) vizBlocks.push({ title: "Visualization", html: "" });
              vizBlocks[vizBlocks.length - 1].html += ev.data;
              send({ type: "viz", delta: ev.data });
            } else {
              send({ type: "viz_end" });
            }
          }
        };

        for await (const chunk of runAssistant(config, messages, {
          signal: turn.abort.signal,
          userId,
          conversationId: newConversationId,
          extendedThinking: input.extendedThinking,
          // Live array — grows in place when the model calls enable_tools;
          // the tool loop re-reads it every round.
          tools: progressive.defs,
          executeTool: progressive.executeTool,
        })) {
          if (chunk.type === "text") {
            onVizEvents(vizParser.feed(chunk.delta));
          } else if (chunk.type === "thinking") {
            send({ type: "thinking", delta: chunk.delta });
          } else if (chunk.type === "notice") {
            notice = chunk.message;
            send({ type: "notice", message: chunk.message });
          } else if (chunk.type === "interjected") {
            // A queued user message was injected mid-turn — every screen
            // moves its bubble above the streaming reply; the scheduled
            // queue drops its copy (v0.5) since the running turn took it.
            const by = chunk.userId ? await authorOf(chunk.userId) : author;
            if (chunk.id && removeQueued(newConversationId, chunk.id)) {
              publishToChat(newConversationId, { type: "queue", items: queueSnapshot(newConversationId) });
            }
            send({ type: "interjected", messageId: chunk.messageId, content: chunk.content, author: by });
          } else if (chunk.type === "tool_status") {
            if (activityLog.length < ACTIVITY_CAP) {
              activityLog.push({ kind: "status", label: chunk.label, at: assistantText.length });
            }
            send({ type: "tool", label: chunk.label, at: assistantText.length });
          } else if (chunk.type === "run_start") {
            toolRuns.set(chunk.id, { id: chunk.id, tool: chunk.tool, ...(chunk.file ? { file: chunk.file } : {}) });
            runTiming.set(chunk.id, { start: Date.now(), first: 0, last: 0, deltas: 0, bytes: 0 });
            if (activityLog.length < ACTIVITY_CAP) {
              activityLog.push({ kind: "run", id: chunk.id, at: assistantText.length });
            }
            send({ ...chunk, at: assistantText.length });
          } else if (chunk.type === "run_code") {
            const r = toolRuns.get(chunk.id);
            if (r) {
              r.code = ((r.code ?? "") + chunk.delta).slice(0, RUN_TEXT_CAP);
              if (chunk.file) r.file = chunk.file;
            }
            const t = runTiming.get(chunk.id);
            if (t && chunk.delta) {
              const now = Date.now();
              if (!t.first) t.first = now;
              t.last = now;
              t.deltas++;
              t.bytes += chunk.delta.length;
            }
            send({ ...chunk });
          } else if (chunk.type === "run_exec") {
            const r = toolRuns.get(chunk.id);
            if (r) r.command = chunk.command;
            logRunTiming(chunk.id, "exec");
            send({ ...chunk });
          } else if (chunk.type === "run_out") {
            const r = toolRuns.get(chunk.id);
            if (r) r.output = ((r.output ?? "") + chunk.delta).slice(0, RUN_TEXT_CAP);
            send({ ...chunk });
          } else if (chunk.type === "run_done") {
            const r = toolRuns.get(chunk.id);
            if (r) {
              if (chunk.diff) r.diff = chunk.diff;
              if (chunk.exec) r.exec = chunk.exec;
              if (chunk.error) r.error = chunk.error;
            }
            logRunTiming(chunk.id, "done");
            send({ ...chunk });
          } else if (chunk.type === "ask") {
            // The reply is now PARKED on this card. Recorded in the timeline at
            // the text offset it appeared, so the persisted reply reads in the
            // order it actually happened.
            asks.set(chunk.id, { id: chunk.id, questions: chunk.questions, status: "pending" });
            if (activityLog.length < ACTIVITY_CAP) {
              activityLog.push({ kind: "ask", id: chunk.id, at: assistantText.length });
            }
            send({ type: "ask", id: chunk.id, questions: chunk.questions, at: assistantText.length });
          } else if (chunk.type === "ask_done") {
            const record = asks.get(chunk.id);
            if (record) {
              record.status = chunk.status;
              if (chunk.answers) record.answers = chunk.answers;
              if (chunk.by) record.answeredBy = chunk.by;
            }
            send({
              type: "ask_done",
              id: chunk.id,
              status: chunk.status,
              ...(chunk.answers ? { answers: chunk.answers } : {}),
              ...(chunk.by ? { by: chunk.by } : {}),
            });
          } else if (chunk.type === "image_start") {
            // Enrich with a time estimate learned from recent generations so
            // the placeholder can show a live "~Ns" countdown.
            const estimateMs = await estimateImageMs(chunk.operation).catch(() => 0);
            if (activityLog.length < ACTIVITY_CAP) {
              activityLog.push({ kind: "image", id: chunk.id, at: assistantText.length });
            }
            send({
              type: "image_start",
              id: chunk.id,
              aspectRatio: chunk.aspectRatio,
              prompt: chunk.prompt,
              operation: chunk.operation,
              estimateMs,
              at: assistantText.length,
            });
          } else if (chunk.type === "image_done") {
            // `version` rides the image URL (?v=) so the browser's in-page
            // image cache can't show stale bytes for a re-used file id.
            const version = Date.now();
            genImages.push({ ...chunk.artifact, version });
            genImageFileIds.add(chunk.artifact.fileId);
            // The timeline entry was logged under the START id; a reload joins
            // it to meta.images by FILE id, so re-key it now that we know it.
            for (const a of activityLog) if (a.kind === "image" && a.id === chunk.id) a.id = chunk.artifact.fileId;
            send({ type: "image_done", id: chunk.id, ...chunk.artifact, version });
          } else if (chunk.type === "image_error") {
            send({ type: "image_error", id: chunk.id, message: chunk.message });
          } else if (chunk.type === "sources") {
            const fresh = chunk.sources.filter((s) => !seenSourceUrls.has(s.url));
            if (fresh.length > 0) {
              for (const s of fresh) seenSourceUrls.add(s.url);
              allSources.push(...fresh);
              send({ type: "sources", sources: fresh });
            }
          } else if (chunk.type === "files_presented") {
            // Hand-over: resolve names → rows and surface them on the reply
            // IMMEDIATELY (mid-turn), split by kind — displayable images go
            // through the inline generated-image flow, the rest as cards.
            const rows = await db.file.findMany({
              where: { conversationId: newConversationId, filename: { in: chunk.names } },
            });
            const chips: typeof presentedFileRows = [];
            for (const row of rows) {
              if (presentedIds.has(row.id) || genImageFileIds.has(row.id)) continue;
              presentedIds.add(row.id);
              const imageMime = inlineImageMime(row.filename, row.mimeType);
              if (imageMime) {
                const aspectRatio = await imageAspectRatio(row.storagePath);
                // The file's mtime, not the row's updatedAt: present_files
                // fires MID-run and the row is only re-synced after the agent
                // finishes, so updatedAt still describes the previous bytes.
                const version = await fileVersion(row.storagePath);
                genImages.push({
                  fileId: row.id,
                  mimeType: imageMime,
                  aspectRatio,
                  prompt: row.filename,
                  operation: "present",
                  version,
                });
                genImageFileIds.add(row.id);
                // start+done back-to-back reuses the existing placeholder →
                // blur-in client flow with zero new event types.
                if (activityLog.length < ACTIVITY_CAP) {
                  activityLog.push({ kind: "image", id: row.id, at: assistantText.length });
                }
                send({ type: "image_start", id: row.id, aspectRatio, prompt: row.filename, operation: "present", estimateMs: 0, at: assistantText.length });
                send({ type: "image_done", id: row.id, fileId: row.id, mimeType: imageMime, aspectRatio, prompt: row.filename, operation: "present", version });
              } else {
                chips.push(row);
                presentedFileRows.push(row);
              }
            }
            if (chips.length > 0) {
              if (activityLog.length < ACTIVITY_CAP) {
                activityLog.push({ kind: "files", ids: chips.map((f) => f.id), at: assistantText.length });
              }
              send({
                type: "files",
                files: chips.map((f) => ({
                  id: f.id,
                  filename: f.filename,
                  mimeType: f.mimeType,
                  sizeBytes: Number(f.sizeBytes),
                  status: f.status,
                })),
                at: assistantText.length,
              });
            }
          } else if (chunk.type === "usage") {
            // The latest role to emit usage is the one that answered. Charged
            // to whoever sent the message that triggered this turn.
            answer.provider = chunk.provider;
            answer.model = chunk.model;
            totalCost += await recordUsage({
              userId,
              role: chunk.role,
              provider: chunk.provider,
              model: chunk.model,
              usage: chunk.usage,
              ...(chunk.billingSource ? { billingSource: chunk.billingSource } : {}),
              ...(chunk.agentSessionId ? { agentSessionId: chunk.agentSessionId } : {}),
            });
            total.inputTokens += chunk.usage.inputTokens;
            total.outputTokens += chunk.usage.outputTokens;
            total.cacheReadTokens += chunk.usage.cacheReadTokens;
            total.cacheWriteTokens += chunk.usage.cacheWriteTokens;
          } else if (chunk.type === "error") {
            errored = chunk.message;
            devLog("error", "chat", "reply error", { userId, conversationId: newConversationId, error: chunk.message });
            send({ type: "error", message: chunk.message });
          }
        }
        onVizEvents(vizParser.flush());
      } catch (e) {
        errored = e instanceof Error ? e.message : "Streaming failed.";
        devLog("error", "chat", "stream threw", { userId, conversationId: newConversationId, error: errored });
        send({ type: "error", message: errored });
      }

      let savedMessageId: string | null = null;
      try {
        // NOTE: no post-turn diff auto-attach any more — only PRESENTED files
        // ride the reply (streamed live above); the rest stay workspace-only.

        // A user Stop before any prose: persist the row anyway, flagged, so
        // the replay can say "this was stopped" instead of dropping it.
        const stoppedEarly = turn.abort.signal.aborted && assistantText.length === 0;
        if (
          assistantText.length > 0 ||
          vizBlocks.length > 0 ||
          genImages.length > 0 ||
          toolRuns.size > 0 ||
          asks.size > 0 ||
          stoppedEarly
        ) {
          // Visualisations + web sources + generated files/images + tool runs
          // survive reloads via meta.
          const meta = {
            ...(stoppedEarly ? { stopped: true } : {}),
            ...(vizBlocks.length > 0 ? { viz: vizBlocks } : {}),
            ...(allSources.length > 0 ? { sources: allSources } : {}),
            ...(presentedFileRows.length > 0 ? { fileIds: presentedFileRows.map((f) => f.id) } : {}),
            ...(genImages.length > 0 ? { images: genImages } : {}),
            // Plain-object copy: Prisma's InputJsonValue rejects interface
            // arrays (no index signature) — same dance as meta.followups.
            ...(toolRuns.size > 0
              ? { toolRuns: [...toolRuns.values()] as unknown as Prisma.InputJsonValue }
              : {}),
            ...(asks.size > 0
              ? { asks: [...asks.values()] as unknown as Prisma.InputJsonValue }
              : {}),
            ...(activityLog.length > 0
              ? { activity: activityLog as unknown as Prisma.InputJsonValue }
              : {}),
            ...(notice ? { notice } : {}),
          };
          const saved = await db.message.create({
            data: {
              conversationId: newConversationId,
              role: "assistant",
              content: assistantText,
              model: answer.model,
              provider: answer.provider,
              ...(Object.keys(meta).length > 0 ? { meta } : {}),
            },
          });
          savedMessageId = saved.id;
          await db.conversation.update({
            where: { id: newConversationId },
            data: { updatedAt: new Date() },
          });
        } else if (!errored) {
          // The turn produced literally nothing (no text, viz, or images) and
          // no error was surfaced — the pipeline's forced-answer pass should
          // make this unreachable, but the user must never watch tool status
          // lines end in silence with nothing persisted.
          devLog("error", "chat", "turn ended empty — nothing to save", {
            userId,
            conversationId: newConversationId,
          });
          send({
            type: "error",
            message: "The assistant didn't produce an answer this time. Please try again.",
          });
        }

        if (total.inputTokens || total.outputTokens || total.cacheReadTokens) {
          send({ type: "usage", ...total, cost: totalCost });
        }

        // Front-end model: replace the provisional title on a new conversation.
        if (isNew && assistantText.length > 0) {
          const t = await generateTitle(config, input.content!, assistantText);
          if (t?.title) {
            await db.conversation.update({
              where: { id: newConversationId },
              data: { title: t.title },
            });
            send({ type: "title", title: t.title });
            if (t.usage) {
              await recordUsage({
                userId,
                role: "frontend",
                provider: t.role.provider,
                model: t.role.model,
                usage: t.usage,
              });
            }
          }
        }
      } catch (e) {
        // The conversation can vanish mid-turn (incognito leave / delete
        // racing a live reply) — the cascade removes it before the save
        // lands. The reply has nowhere to live; not an error worth surfacing.
        const code = (e as { code?: string } | null)?.code;
        if (code === "P2003" || code === "P2025") {
          devLog("info", "chat", "conversation deleted mid-turn — reply discarded", {
            userId,
            conversationId: newConversationId,
          });
        } else if (!errored) {
          send({
            type: "error",
            message: e instanceof Error ? e.message : "Failed to save message.",
          });
        }
      }

      // Rich per-turn record — the Admin → Logs "Chats" view renders these
      // (user, tokens by tier, cost, duration, tool count, escalation note).
      await appLog("info", "chat", "Assistant reply", {
        userId,
        details: {
          conversationId: newConversationId,
          provider: answer.provider,
          model: answer.model,
          inputTokens: total.inputTokens,
          cacheReadTokens: total.cacheReadTokens,
          cacheWriteTokens: total.cacheWriteTokens,
          outputTokens: total.outputTokens,
          cost: totalCost,
          durationMs: Date.now() - turnStartedAt,
          toolCalls: activityLog.length,
          ...(notice ? { notice } : {}),
        },
      });

      send({ type: "done", messageId: savedMessageId });

      // v0.5: every member's sidebar moves the chat up (and shows the unread
      // dot to those not looking at it — the live route marks viewers read).
      if (!incognito && memberIds.length > 1) {
        publishToUsers(memberIds, {
          type: "activity",
          conversationId: newConversationId,
          updatedAt: new Date().toISOString(),
          byUserId: userId,
        });
      }
  };

  // Detached execution. A failure must still END the turn — an entry left
  // "active" would 409 every future message in this conversation.
  void (async () => {
    try {
      await runTurn();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Streaming failed.";
      devLog("error", "chat", "turn runner threw", {
        userId,
        conversationId: newConversationId,
        error: message,
      });
      publishTurn(turn, { type: "error", message });
      publishTurn(turn, { type: "done", messageId: null });
    } finally {
      clearTurnHardStop(turn);
      closeInterjectionMailbox(newConversationId);
      // A turn that died (stopped, errored, conversation deleted) may have been
      // parked on a question card. Release it, or its promise never settles and
      // the tool's await leaks for the life of the process.
      dismissAsk(newConversationId);
      endTurn(turn);
      // v0.5: the next scheduled message, if anyone lined one up.
      void runNextQueued(newConversationId);
    }
  })();

  return { ok: true, turn, conversationId: newConversationId };
}

/**
 * The scheduled queue's turn: the next entry runs as its author, with no
 * browser involved — every open screen learns of it through the live feed
 * (`message`, then `turn_started`) exactly as if that person had just pressed
 * send. A failure to start (the chat was deleted, the assistant unconfigured)
 * is logged and the queue moves on; during a deploy drain nothing new starts.
 */
async function runNextQueued(conversationId: string): Promise<void> {
  const next = shiftQueued(conversationId);
  if (!next) return;
  publishToChat(conversationId, { type: "queue", items: queueSnapshot(conversationId) });
  if (isDraining()) {
    devLog("warn", "chat", "scheduled message dropped — instance is draining", {
      conversationId,
      userId: next.userId,
    });
    return;
  }
  devLog("info", "chat", "running scheduled message", {
    conversationId,
    userId: next.userId,
    content: next.content.slice(0, 200),
  });
  const res = await startChatTurn({
    userId: next.userId,
    conversationId,
    content: next.content,
    fileIds: next.fileIds,
    extendedThinking: next.extendedThinking,
  });
  if (!res.ok && res.status === 409) {
    // A human's send won the registry between the shift and the start
    // (startChatTurn awaits config before it registers). The entry must run
    // after THAT turn, not vanish — put it back at the front.
    requeueFront(next);
    publishToChat(conversationId, { type: "queue", items: queueSnapshot(conversationId) });
    devLog("info", "chat", "scheduled message requeued behind a live send", { conversationId, userId: next.userId });
    return;
  }
  if (!res.ok) {
    devLog("warn", "chat", "scheduled message could not start", {
      conversationId,
      userId: next.userId,
      error: res.error,
    });
    publishToChat(conversationId, { type: "queue_failed", content: next.content, error: res.error });
    void runNextQueued(conversationId);
  }
}
