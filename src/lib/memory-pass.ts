import "server-only";
import { orderThreadRows } from "@/lib/thread-order";
import { db } from "./db";
import { getAssistantConfig } from "./assistant";
import { recordUsage, runCompletion } from "./pipeline";
import { appLog } from "./applog";
import { devLog } from "./dev-log";
import { getSetting } from "./settings";
import {
  buildPassMessages,
  formatTranscript,
  parsePassOutput,
  type MemoryTopicKey,
} from "./memory-topics";
import { getMemoryConfig, loadTopics, memoryPausedFor, setTopic } from "./tools/memory";

/**
 * The idle-chat memory pass (memory v2, 0.5.1 — owner decision 2026-09-04:
 * "not after every reply; after 30 minutes of inactivity from that chat, and
 * no need to tell the user").
 *
 * Every five minutes the scheduler looks for chats whose NEWEST message is
 * at least 30 minutes old and newer than the chat's `memory_pass_at` stamp —
 * i.e. a stretch of conversation nobody has read for memory yet. For each,
 * the front-end (cheap) role reads that stretch beside the person's current
 * notes and returns the notes that should change; the change is applied
 * silently. Rules: never incognito (deleted anyway), never a shared chat
 * (memory is private), never for a person who paused, never when the admin
 * paused everyone or switched the memory group off. The stamp is written
 * BEFORE the model call, so a failing pass is not retried every tick — the
 * next message in that chat makes it due again.
 *
 * `MEMORY_PASS_IDLE_MINUTES` overrides the wait (the harness sets it small);
 * `runMemoryPassOnce()` is exported for the same reason.
 */

const IDLE_MINUTES = Math.max(1, Number(process.env.MEMORY_PASS_IDLE_MINUTES) || 30);
const TICK_MS = 5 * 60_000;
const BATCH = 10;
/** A chat quiet for longer than this is history, not "just finished": never
 *  picked. Without it the first tick after a deploy (or an outage) starts on
 *  the OLDEST never-passed chat — on one live portal that was 2,100 imported chats from
 *  January onwards, rewriting people's notes from months-old conversations
 *  and (see the stamp below) bumping each one to the top of every sidebar. */
const MAX_AGE_DAYS = Math.max(1, Number(process.env.MEMORY_PASS_MAX_AGE_DAYS) || 7);
/** Only read this much of a chat per pass — the newest part, if longer. */
const MAX_TURNS = 40;

interface Candidate {
  id: string;
  user_id: string;
  last_at: Date;
}

async function memoryGroupEnabled(): Promise<boolean> {
  const cfg = await getSetting<{ disabledGroups?: string[] }>("tools_config");
  return !(cfg?.disabledGroups ?? []).includes("memory");
}

/** Chats due a pass: quiet for IDLE_MINUTES, with something new since the last one. */
async function dueConversations(limit: number): Promise<Candidate[]> {
  return db.$queryRaw<Candidate[]>`
    select c.id::text as id, c.user_id::text as user_id, max(m.created_at) as last_at
    from conversations c
    join messages m on m.conversation_id = c.id
    where c.incognito = false
      and m.role in ('user', 'assistant')
      and not exists (select 1 from conversation_members cm where cm.conversation_id = c.id)
    group by c.id
    having max(m.created_at) < now() - make_interval(mins => ${IDLE_MINUTES}::int)
       and max(m.created_at) > now() - make_interval(days => ${MAX_AGE_DAYS}::int)
       and (c.memory_pass_at is null or max(m.created_at) > c.memory_pass_at)
    order by max(m.created_at) asc
    limit ${limit}
  `;
}

export interface PassOutcome {
  conversationId: string;
  userId: string;
  changed: MemoryTopicKey[];
  skipped?: string;
}

/** Run the pass over one chat. Exported for the harness; the scheduler calls it. */
export async function runMemoryPassForConversation(conversationId: string): Promise<PassOutcome> {
  const convo = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, incognito: true, memoryPassAt: true, members: { select: { userId: true } } },
  });
  if (!convo) return { conversationId, userId: "", changed: [], skipped: "gone" };
  const base: PassOutcome = { conversationId, userId: convo.userId, changed: [] };
  if (convo.incognito || convo.members.length > 0) return { ...base, skipped: "private-scope" };

  // Stamp first (see the note at the top) — with a RAW update, never
  // `db.conversation.update`: Prisma auto-stamps `@updatedAt` on any update,
  // and `updated_at` is "last activity" to the sidebar and to Admin → Chats.
  // The first working night of the pass (2026-09-04) bumped 600 chats from
  // January–March to "just now" that way, ten every five minutes, all
  // evening, until the owner asked what on earth was going on.
  // The cheap gates come BEFORE the stamp (audit 2026-09-05): stamping first
  // is for MODEL failures (don't retry a bad call every tick). Stamping a
  // paused person's chat would make everything said while paused permanently
  // ineligible once they resume — "pause keeps the notes, stops learning"
  // would silently become "discards". These are two DB reads; the chat
  // simply stays due until the switch flips back.
  if (!(await memoryGroupEnabled())) return { ...base, skipped: "memory-off" };
  if (await memoryPausedFor(convo.userId)) return { ...base, skipped: "paused" };

  const since = convo.memoryPassAt;
  const stampedAt = new Date();
  await db.$executeRaw`update conversations set memory_pass_at = ${stampedAt} where id = ${conversationId}::uuid`;

  const rows = await db.message.findMany({
    where: {
      conversationId,
      role: { in: ["user", "assistant"] },
      ...(since ? { createdAt: { gt: since } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_TURNS,
    select: { id: true, role: true, content: true, createdAt: true },
  });
  const turns = orderThreadRows(rows);
  // Nothing a person actually said → nothing to learn (a stopped turn, a
  // regenerate). Cheap to check, saves a model call.
  const userChars = turns.filter((t) => t.role === "user").reduce((n, t) => n + t.content.trim().length, 0);
  if (userChars < 12) return { ...base, skipped: "nothing-said" };

  const config = await getAssistantConfig();
  const role = config.roles.frontend ?? config.roles.conversation;
  if (!role) return { ...base, skipped: "no-role" };

  const [topics, memCfg] = await Promise.all([loadTopics(convo.userId), getMemoryConfig()]);
  const messages = buildPassMessages({
    today: stampedAt.toISOString().slice(0, 10),
    topics,
    transcript: formatTranscript(turns),
    topicChars: memCfg.topicChars,
  });

  const { text, usage } = await runCompletion(role, messages, 2000);
  if (usage) {
    await recordUsage({
      userId: convo.userId,
      role: "memory",
      provider: role.provider,
      model: role.model,
      usage,
    });
  }
  const parsed = parsePassOutput(text);
  if (parsed === null) {
    devLog("warn", "memory", "pass returned no usable JSON", {
      conversationId,
      userId: convo.userId,
      preview: text.slice(0, 200),
    });
    return { ...base, skipped: "unparsable" };
  }

  const changed: MemoryTopicKey[] = [];
  for (const [key, value] of Object.entries(parsed) as [MemoryTopicKey, string][]) {
    const before = topics.find((t) => t.key === key)?.text ?? "";
    const after = await setTopic(convo.userId, key, value);
    if (after !== before) changed.push(key);
  }
  devLog("info", "memory", changed.length ? "pass updated notes" : "pass: nothing lasting", {
    conversationId,
    userId: convo.userId,
    turns: turns.length,
    changed,
  });
  return { ...base, changed };
}

let ticking = false;

/** One scheduler tick: every due chat, oldest first, a batch at a time. */
export async function runMemoryPassOnce(): Promise<PassOutcome[]> {
  if (ticking) return [];
  ticking = true;
  const out: PassOutcome[] = [];
  try {
    if (!(await memoryGroupEnabled())) return out;
    const due = await dueConversations(BATCH);
    for (const c of due) {
      try {
        out.push(await runMemoryPassForConversation(c.id));
      } catch (e) {
        // Warn, not error: a flaky model call must not email the admin, and
        // the stamp already stops it retrying every tick.
        await appLog("warn", "memory", "Idle-chat memory pass failed.", {
          userId: c.user_id,
          details: { conversationId: c.id, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  } catch (e) {
    devLog("error", "memory", "pass tick failed", { error: e instanceof Error ? e.message : String(e) });
  } finally {
    ticking = false;
  }
  return out;
}

const globalForScheduler = globalThis as { __oiMemoryPassTimer?: ReturnType<typeof setInterval> };

/** Start the in-process scheduler (Node runtime only; survives dev hot-reload). */
export function startMemoryPassScheduler(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalForScheduler.__oiMemoryPassTimer) return;
  const timer = setInterval(() => void runMemoryPassOnce(), TICK_MS);
  timer.unref?.();
  globalForScheduler.__oiMemoryPassTimer = timer;
  setTimeout(() => void runMemoryPassOnce(), 60_000).unref?.();
}
