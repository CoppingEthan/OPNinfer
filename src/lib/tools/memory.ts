import "server-only";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { devLog } from "@/lib/dev-log";
import {
  MEMORY_TOPICS,
  clipTopic,
  formatMemoryBlock,
  isTopicKey,
  mergeLines,
  parseMemoryConfig,
  topicLabel,
  type MemoryConfig,
  type MemoryTopic,
  type MemoryTopicKey,
} from "@/lib/memory-topics";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx } from "./types";

/**
 * Per-user memory, v2 (0.5.1 — docs/V051_MEMORY.md): four named notes the
 * assistant keeps about each person, shown to it every turn and edited in
 * full — by the `memory_update` tool when someone tells it something lasting
 * (or asks it to remember / forget / correct), and by the idle-chat pass in
 * `memory-pass.ts` once a chat has been quiet for 30 minutes. Never in
 * incognito or shared chats, never context-curated (the callers enforce
 * both), never for a person who has paused their memory.
 */

export async function getMemoryConfig(): Promise<MemoryConfig> {
  return parseMemoryConfig(await getSetting<unknown>("memory_config"));
}

export async function loadTopics(userId: string): Promise<MemoryTopic[]> {
  const rows = await db.userMemoryTopic.findMany({
    where: { userId },
    select: { key: true, text: true, updatedAt: true },
  });
  return MEMORY_TOPICS.map((t) => {
    const row = rows.find((r) => r.key === t.key);
    return { key: t.key, text: row?.text ?? "", updatedAt: row?.updatedAt ?? null };
  });
}

/** Whether this person's memory is paused (their own switch OR the admin's). */
export async function memoryPausedFor(userId: string): Promise<boolean> {
  const [user, cfg] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { memoryPaused: true } }),
    getMemoryConfig(),
  ]);
  return !!user?.memoryPaused || cfg.paused;
}

/**
 * The system-prompt block injected each turn (null when there is nothing to
 * say — zero token cost for people the assistant knows nothing about).
 */
export async function buildMemoryBlock(userId: string): Promise<string | null> {
  const [topics, paused, cfg] = await Promise.all([loadTopics(userId), memoryPausedFor(userId), getMemoryConfig()]);
  // Clip on READ as well as on write (audit 2026-09-05): the migration's fold
  // and imports keep a note whole on purpose, but the PROMPT must honour the
  // cap — one person's 8,300-char fold was riding every turn. The settings
  // panel still shows the full text so they can trim it themselves.
  const capped = topics.map((t) => ({ ...t, text: clipTopic(t.text, cfg.topicChars) }));
  return formatMemoryBlock(capped, { paused, today: new Date().toISOString().slice(0, 10) });
}

/** Write one note in full (empty clears it). Clipped to the admin's cap
 *  unless `unbounded` (imports keep everything; the next pass tidies). */
export async function setTopic(
  userId: string,
  key: MemoryTopicKey,
  text: string,
  opts: { unbounded?: boolean } = {},
): Promise<string> {
  const cap = opts.unbounded ? 20_000 : (await getMemoryConfig()).topicChars;
  const clean = clipTopic(text, cap);
  if (!clean) {
    await db.userMemoryTopic.deleteMany({ where: { userId, key } });
    return "";
  }
  await db.userMemoryTopic.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, text: clean },
    update: { text: clean },
  });
  return clean;
}

/** Add plain lines to a note without repeating what it already has. */
export async function appendToTopic(userId: string, key: MemoryTopicKey, lines: string[]): Promise<void> {
  const cur = (await db.userMemoryTopic.findUnique({ where: { userId_key: { userId, key } } }))?.text ?? "";
  const next = mergeLines(cur, lines);
  if (next !== cur) await setTopic(userId, key, next, { unbounded: true });
}

/** Forget everything (Settings → Reset). */
export async function resetMemory(userId: string): Promise<number> {
  const res = await db.userMemoryTopic.deleteMany({ where: { userId } });
  return res.count;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOPIC_LIST = MEMORY_TOPICS.map((t) => `"${t.key}" (${t.label}: ${t.hint})`).join(", ");

export const MEMORY_VIEW_DEF: ToolDef = {
  name: "memory_view",
  description:
    "Show the four memory notes you keep about this user, in full. They are already in your context each turn — use this only to re-read a note precisely before rewriting it.",
  parameters: { type: "object", properties: {} },
};

export const MEMORY_UPDATE_DEF: ToolDef = {
  name: "memory_update",
  description:
    "Rewrite ONE of the memory notes you keep about this user, in full. Use it ONLY when they ASK you to remember, forget or correct something (\"remember that…\", \"forget my…\", \"note that I'm now…\"). " +
    "NOT when they merely describe themselves, their preferences or their situation while asking for something else — those are picked up automatically later; don't save them yourself. " +
    "Write the whole note as it should now read: keep what is still true, fold in the new, drop what is superseded (a changed job REPLACES the old one), date projects and decisions. Plain lines starting with \"- \". An empty text clears the note. " +
    "Never store health, religion, politics, sexuality, personal finances, ID or account numbers, criminal or immigration matters unless they explicitly ask you to remember it. " +
    "Confirm in a few words what you remembered or forgot. " +
    `Topics: ${TOPIC_LIST}.`,
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: [...MEMORY_TOPICS.map((t) => t.key)],
        description: "Which note to rewrite.",
      },
      text: {
        type: "string",
        description: "The note's complete new text (empty to clear it).",
      },
    },
    required: ["topic", "text"],
  },
};

// ---------------------------------------------------------------------------
// Executors (all scoped to ctx.userId — no cross-user access possible)
// ---------------------------------------------------------------------------

export async function executeMemoryView(
  _args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const topics = await loadTopics(ctx.userId);
  const filled = topics.filter((t) => t.text.trim());
  if (filled.length === 0) return "No memory notes for this user yet.";
  return filled
    .map((t) => `## ${topicLabel(t.key)} [${t.key}]${t.updatedAt ? ` (updated ${new Date(t.updatedAt).toISOString().slice(0, 10)})` : ""}\n${t.text}`)
    .join("\n\n");
}

export async function executeMemoryUpdate(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const key = args.topic;
  if (!isTopicKey(key)) {
    return `Error: topic must be one of ${MEMORY_TOPICS.map((t) => t.key).join(", ")}.`;
  }
  if (await memoryPausedFor(ctx.userId)) {
    return "Error: this user's memory is paused (Settings → Assistant memory) — nothing was saved. Tell them so, briefly.";
  }
  const text = String(args.text ?? "");
  const cap = (await getMemoryConfig()).topicChars;
  const saved = await setTopic(ctx.userId, key, text);
  devLog("info", "memory", `memory_update ${key}`, {
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    chars: saved.length,
  });
  if (!saved) return `Cleared the "${topicLabel(key)}" note.`;
  const clipped = clipTopic(text, 20_000).length > saved.length;
  return (
    `Updated the "${topicLabel(key)}" note (${saved.length}/${cap} characters).` +
    (clipped ? " It was over the size cap and has been shortened — keep notes brief." : "")
  );
}
