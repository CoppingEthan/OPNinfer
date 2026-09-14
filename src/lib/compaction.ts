import "server-only";
import { db } from "@/lib/db";
import { appLog } from "@/lib/applog";
import { devLog } from "@/lib/dev-log";
import { getAssistantConfig } from "@/lib/assistant";
import { getCachedTokenLimits } from "@/lib/limits";
import { recordUsage, runCompletion } from "@/lib/pipeline";
import { hasActiveTurn } from "@/lib/turn-stream";
import { orderThreadRows } from "@/lib/thread-order";
import { peopleById } from "@/lib/chat-access";
import { displayName } from "@/lib/chat-rules";
import type { ChatMessage, TokenUsage } from "@/lib/providers/types";
import {
  COMPACTION_SYSTEM,
  clipSummary,
  compactionUserPrompt,
  estimateRowsTokens,
  planChunks,
  selectBoundary,
  summaryMessages,
  type CompactRow,
} from "@/lib/compaction-core";

/**
 * Conversation compaction — the server half. See compaction-core.ts for the
 * rules and docs/V07_CONTEXT_COMPACTION.md for the investigation.
 *
 * Three entry points:
 *  - `loadCompaction` — the newest VALID compaction for a chat, given its
 *    ordered rows. Valid = its boundary message still exists; an edit or
 *    revert from before the boundary deletes that row, and with it the
 *    compaction's claim to describe the history. Nothing else to bookkeep.
 *  - `compactConversation` — summarise the older part with the front-end
 *    model (rolling: the previous summary rides in), record the usage under
 *    the `compaction` role, store the row. Called at the start of a turn
 *    whose history is over the admin's trigger, and by the sweep.
 *  - `startCompactionSweep` — the retroactive fix: once per boot, compact
 *    every chat already over the trigger, so the deploy is the fix.
 */

export interface StoredCompaction {
  id: string;
  summary: string;
  boundaryMessageId: string;
  messagesCovered: number;
  createdAt: Date;
  /** Index of the boundary row in the ordered rows handed in. */
  boundaryIndex: number;
}

export async function loadCompaction(
  conversationId: string,
  rows: readonly CompactRow[],
): Promise<StoredCompaction | null> {
  const row = await db.conversationCompaction.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const boundaryIndex = rows.findIndex((r) => r.id === row.boundaryMessageId);
  if (boundaryIndex === -1) return null; // boundary gone → compaction void
  return {
    id: row.id,
    summary: row.summary,
    boundaryMessageId: row.boundaryMessageId,
    messagesCovered: row.messagesCovered,
    createdAt: row.createdAt,
    boundaryIndex,
  };
}

/**
 * The history to REPLAY for a compacted chat: the summary pair, then the rows
 * after the boundary. `toChat` is the caller's row → ChatMessage mapping (the
 * chat route's, with its provenance notes and stopped-turn handling).
 */
export function compactedHistory<R extends CompactRow>(
  rows: readonly R[],
  compaction: StoredCompaction | null,
  toChat: (rows: R[]) => ChatMessage[],
): ChatMessage[] {
  if (!compaction) return toChat([...rows]);
  const kept = rows.slice(compaction.boundaryIndex + 1);
  return [
    ...summaryMessages(compaction.summary, compaction.messagesCovered).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    ...toChat(kept),
  ];
}

/** Tokens the reply model would be sent for this chat's history right now. */
export function replayedTokens(rows: readonly CompactRow[], compaction: StoredCompaction | null): number {
  if (!compaction) return estimateRowsTokens(rows);
  return (
    estimateRowsTokens(summaryMessages(compaction.summary, compaction.messagesCovered)) +
    estimateRowsTokens(rows.slice(compaction.boundaryIndex + 1))
  );
}

export interface CompactionResult {
  compaction: StoredCompaction;
  tokensBefore: number;
  tokensAfter: number;
  calls: number;
  cost: number;
  ms: number;
}

/** The summariser's output budget. Generous because the front-end role is a
 *  reasoning model on every portal (gpt-5.6-luna) and thinking counts
 *  against max_tokens — the lesson from the empty titles. 8k was not enough:
 *  the first production sweep logged "Reply cut off at the output limit" on
 *  a 123k-token chat and stored a 313-token summary of it. */
const SUMMARY_MAX_TOKENS = 16_000;
/** A summary this short for a chunk this big means the budget went on
 *  thinking and the text was cut — try once more with twice the room. */
const SUSPICIOUSLY_SHORT_CHARS = 600;

// One compaction per chat at a time, shared between a live turn and the
// sweep: a second caller waits for the first and gets the same result.
// globalThis-anchored like every other per-process registry here.
const inflight = ((globalThis as { __oiCompacting?: Map<string, Promise<CompactionResult | null>> })
  .__oiCompacting ??= new Map());

/**
 * Compact one conversation. `rows` must be the FULL ordered thread (as
 * `orderThreadRows` returns it) — user/assistant rows only are summarised;
 * anything else in the range is passed over. Returns null when there is
 * nothing to do or the summariser is unavailable (logged, never thrown: a
 * reply must not be blocked by tidying).
 */
export async function compactConversation(opts: {
  conversationId: string;
  /** Who pays for the summarisation call (the turn's sender; the owner for the sweep). */
  userId: string;
  rows: readonly CompactRow[];
  /** Override the admin's keep budget (tests). */
  keepTokens?: number;
  reason: "turn" | "sweep";
}): Promise<CompactionResult | null> {
  const existing = inflight.get(opts.conversationId);
  if (existing) return existing;
  const p = doCompact(opts).finally(() => inflight.delete(opts.conversationId));
  inflight.set(opts.conversationId, p);
  return p;
}

async function doCompact(opts: {
  conversationId: string;
  userId: string;
  rows: readonly CompactRow[];
  keepTokens?: number;
  reason: "turn" | "sweep";
}): Promise<CompactionResult | null> {
  const t0 = Date.now();
  const rows = opts.rows.filter((r) => r.role === "user" || r.role === "assistant");
  if (rows.length === 0) return null;

  const config = await getAssistantConfig();
  const role = config.roles.frontend ?? config.roles.conversation;
  if (!role) {
    await appLog("warn", "chat", "Compaction skipped: no front-end model is configured.", {
      details: { conversationId: opts.conversationId },
    });
    return null;
  }
  const limits = await getCachedTokenLimits();
  const keepTokens = opts.keepTokens ?? limits.compactKeepTokens;

  const previous = await loadCompaction(opts.conversationId, rows);
  const tokensBefore = replayedTokens(rows, previous);
  const boundary = selectBoundary(rows, keepTokens, previous?.boundaryIndex ?? -1);
  if (boundary < 0) return null;

  // Rows the new summary must absorb: everything after the previous boundary
  // up to and including the new one. The previous summary rides in as the
  // "summary so far", so nothing older is re-read.
  const from = (previous?.boundaryIndex ?? -1) + 1;
  const toSummarise = rows.slice(from, boundary + 1);
  if (toSummarise.length === 0) return null;

  // Authors, for a shared chat only (a private chat's turns are all the owner's).
  const authorIds = [...new Set(toSummarise.map((r) => r.userId).filter((id): id is string => !!id))];
  const shared = authorIds.length > 1;
  const people = shared ? await peopleById(authorIds) : undefined;
  const authorOf = (r: CompactRow) => {
    if (!people || r.role !== "user" || !r.userId) return null;
    const p = people.get(r.userId);
    return p ? displayName(p) : "Former member";
  };

  const chunks = planChunks(toSummarise, authorOf);
  let summary: string | null = previous?.summary ?? null;
  let calls = 0;
  let cost = 0;
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  try {
    for (let i = 0; i < chunks.length; i++) {
      const messages: ChatMessage[] = [
        { role: "system", content: COMPACTION_SYSTEM },
        { role: "user", content: compactionUserPrompt(summary, chunks[i], i, chunks.length) },
      ];
      let { text, usage } = await runCompletion(role, messages, SUMMARY_MAX_TOKENS);
      calls++;
      const book = async (u: TokenUsage | null) => {
        if (!u) return;
        total.inputTokens += u.inputTokens;
        total.outputTokens += u.outputTokens;
        total.cacheReadTokens += u.cacheReadTokens;
        total.cacheWriteTokens += u.cacheWriteTokens;
        cost += await recordUsage({ userId: opts.userId, role: "compaction", provider: role.provider, model: role.model, usage: u });
      };
      await book(usage);
      if (text.trim().length < SUSPICIOUSLY_SHORT_CHARS && chunks[i].length > 4_000) {
        devLog("warn", "chat", "compaction summary suspiciously short — retrying with a larger budget", {
          conversationId: opts.conversationId, chars: text.trim().length, chunk: i,
        });
        ({ text, usage } = await runCompletion(role, messages, SUMMARY_MAX_TOKENS * 2));
        calls++;
        await book(usage);
      }
      const next = clipSummary(text);
      if (!next) throw new Error("the summariser returned an empty summary");
      summary = next;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appLog("warn", "chat", "Compaction failed — the full history was sent instead.", {
      userId: opts.userId,
      details: { conversationId: opts.conversationId, error: message, calls, reason: opts.reason },
    });
    return null;
  }
  if (!summary) return null;

  // Someone else may have compacted this chat while we were reading it — the
  // in-flight map covers this process, but the harness found the dev
  // server's boot sweep and a test-process compaction summarising the same
  // 396 rows five seconds apart. If a compaction newer than our start now
  // covers at least as much, ours is redundant: keep theirs, drop ours.
  const rival = await loadCompaction(opts.conversationId, rows);
  if (rival && rival.createdAt.getTime() >= t0 && rival.boundaryIndex >= boundary) {
    devLog("info", "chat", "compaction superseded by a concurrent one", { conversationId: opts.conversationId });
    return { compaction: rival, tokensBefore, tokensAfter: replayedTokens(rows, rival), calls, cost, ms: Date.now() - t0 };
  }

  const boundaryRow = rows[boundary];
  const messagesCovered = boundary + 1;
  const saved = await db.conversationCompaction.create({
    data: {
      conversationId: opts.conversationId,
      summary,
      boundaryMessageId: boundaryRow.id,
      boundaryAt: new Date(boundaryRow.createdAt),
      messagesCovered,
      tokensBefore,
      tokensAfter: 0, // filled below once the replay shape is known
      provider: role.provider,
      model: role.model,
    },
  });
  const compaction: StoredCompaction = {
    id: saved.id,
    summary,
    boundaryMessageId: boundaryRow.id,
    messagesCovered,
    createdAt: saved.createdAt,
    boundaryIndex: boundary,
  };
  const tokensAfter = replayedTokens(rows, compaction);
  await db.conversationCompaction.update({ where: { id: saved.id }, data: { tokensAfter } });

  const ms = Date.now() - t0;
  const details = {
    conversationId: opts.conversationId,
    reason: opts.reason,
    messagesCovered,
    messagesSummarisedNow: toSummarise.length,
    tokensBefore,
    tokensAfter,
    summaryChars: summary.length,
    calls,
    model: role.model,
    cost,
    ms,
  };
  await appLog("info", "chat", "Conversation compacted", { userId: opts.userId, details });
  devLog("info", "chat", "compaction", details);
  return { compaction, tokensBefore, tokensAfter, calls, cost, ms };
}

// ---- the sweep ---------------------------------------------------------------

const SWEEP_DELAY_MS = 90_000;
const SWEEP_MAX_PER_BOOT = 50;

/**
 * Compact every conversation whose replayed history is over the trigger.
 * Newest activity first (the chats people are actually in benefit first),
 * one at a time, never a chat with a live turn (the turn will do it), never
 * an incognito chat (it dies when they leave). Writes only to its own table,
 * so nothing's "last activity" moves — the memory-pass lesson.
 */
export async function sweepOversizedConversations(opts: { limit?: number } = {}): Promise<{
  examined: number;
  compacted: number;
  cost: number;
}> {
  const limits = await getCachedTokenLimits();
  const trigger = limits.compactAtTokens;
  const limit = opts.limit ?? SWEEP_MAX_PER_BOOT;
  // Cheap pre-filter in SQL (chars/4 ≥ trigger); the exact check, with any
  // existing compaction applied, happens per chat below.
  const candidates = await db.$queryRaw<{ conversation_id: string }[]>`
    select m.conversation_id
    from messages m
    join conversations c on c.id = m.conversation_id
    where m.role in ('user', 'assistant') and c.incognito = false
    group by m.conversation_id
    having sum(length(m.content)) >= ${trigger * 4}
    order by max(m.created_at) desc
    limit ${limit * 4}`;

  let examined = 0;
  let compacted = 0;
  let cost = 0;
  for (const { conversation_id: id } of candidates) {
    if (compacted >= limit) break;
    if (hasActiveTurn(id)) continue;
    const convo = await db.conversation.findUnique({
      where: { id },
      select: { userId: true, messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (!convo) continue;
    examined++;
    const rows = orderThreadRows(convo.messages);
    const existing = await loadCompaction(id, rows);
    if (replayedTokens(rows, existing) < trigger) continue;
    const result = await compactConversation({ conversationId: id, userId: convo.userId, rows, reason: "sweep" });
    if (result) {
      compacted++;
      cost += result.cost;
    }
  }
  return { examined, compacted, cost };
}

/** Once per process, a while after boot: the retroactive fix. */
export function startCompactionSweep(): void {
  const g = globalThis as { __oiCompactionSweep?: boolean };
  if (g.__oiCompactionSweep) return;
  g.__oiCompactionSweep = true;
  const timer = setTimeout(() => {
    void sweepOversizedConversations()
      .then((r) => {
        console.log(`[compaction] sweep: examined ${r.examined}, compacted ${r.compacted}, cost $${r.cost.toFixed(4)}`);
        if (r.compacted > 0) {
          void appLog("info", "chat", "Compaction sweep finished", { details: r }).catch(() => {});
        }
      })
      .catch((error) => {
        console.error("[compaction] sweep failed:", error);
      });
  }, SWEEP_DELAY_MS);
  timer.unref?.();
}
