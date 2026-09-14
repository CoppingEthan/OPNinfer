import "server-only";
import { runCompletion } from "@/lib/pipeline";
import { getCachedTokenLimits } from "@/lib/limits";
import type { AssistantConfig } from "@/lib/assistant";
import type { ChatMessage, TokenUsage } from "@/lib/providers/types";

/**
 * Context curation (v0.3 step 5b) — keeps long tool loops affordable. When
 * the transcript grows past a threshold, older LARGE tool results are
 * replaced with short LLM summaries (frontend role); the most recent N stay
 * at full fidelity; memory ops are never touched. Works on OPNinfer's
 * NEUTRAL ChatMessage[] BEFORE provider mapping — one code path for all
 * three providers (a big simplification over per-format curation).
 */

/** Env override for the curation trigger. Normally unset — the admin's
 *  `maxInputTokens` limit (Admin → Models) drives it. */
const TRIGGER_ENV = process.env.CURATION_TRIGGER_TOKENS
  ? Number(process.env.CURATION_TRIGGER_TOKENS)
  : null;
const KEEP_RECENT = Number(process.env.CURATION_KEEP_RECENT ?? 5);
const MIN_RESULT_CHARS = Number(process.env.CURATION_MIN_RESULT_SIZE ?? 500);
const SUMMARY_MAX_TOKENS = 250;
const CURATED_PREFIX = "[Tool result curated to save context]";
/** Tools whose results must never be summarized away. */
const NEVER_CURATE = new Set([
  "memory_view", "memory_update", "search_my_chats",
]);

/** Rough token estimate: chars/4 for text, flat cost per attached image. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.toolCalls) chars += m.toolCalls.reduce((s, c) => s + c.arguments.length + 40, 0);
    images += m.images?.length ?? 0;
  }
  return Math.ceil(chars / 4) + images * 1_000;
}

/** Pick which tool messages to curate (pure — unit-testable). */
export function selectCurationTargets(
  messages: ChatMessage[],
  opts: { keepRecent?: number; minChars?: number } = {},
): number[] {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT;
  const minChars = opts.minChars ?? MIN_RESULT_CHARS;
  const toolIdx = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const eligible = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  return eligible.filter((i) => {
    const m = messages[i];
    if (NEVER_CURATE.has(m.toolName ?? "")) return false;
    if (m.content.startsWith(CURATED_PREFIX)) return false;
    return m.content.length >= minChars;
  });
}

export interface CurationResult {
  curatedCount: number;
  savedChars: number;
  usage: TokenUsage | null;
  model?: string;
  provider?: string;
}

/**
 * Curate in place when over the threshold. Returns what happened (zero-work
 * results are cheap: one estimate pass, no model calls).
 */
export async function curateOldToolResults(
  config: AssistantConfig,
  messages: ChatMessage[],
): Promise<CurationResult> {
  const none: CurationResult = { curatedCount: 0, savedChars: 0, usage: null };
  const role = config.roles.frontend;
  if (!role) return none;
  // The admin's input budget is the trigger: above it, old tool results get
  // summarized away to keep the context inside what they asked for.
  const trigger = TRIGGER_ENV ?? (await getCachedTokenLimits()).maxInputTokens;
  if (estimateTokens(messages) < trigger) return none;

  const targets = selectCurationTargets(messages);
  if (targets.length === 0) return none;

  let savedChars = 0;
  let curatedCount = 0;
  const total: TokenUsage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };

  for (const idx of targets) {
    const m = messages[idx];
    let summary: string | null = null;
    try {
      const { text, usage } = await runCompletion(
        role,
        [
          {
            role: "system",
            content:
              "Compress this tool result to at most 200 tokens. Preserve key facts, numbers, dates, URLs, filenames and errors. Drop formatting, boilerplate and repetition. Output only the summary.",
          },
          { role: "user", content: m.content.slice(0, 24_000) },
        ],
        SUMMARY_MAX_TOKENS,
      );
      summary = text.trim() || null;
      if (usage) {
        total.inputTokens += usage.inputTokens;
        total.outputTokens += usage.outputTokens;
        total.cacheReadTokens += usage.cacheReadTokens;
        total.cacheWriteTokens += usage.cacheWriteTokens;
      }
    } catch {
      summary = null; // summarizer down → placeholder, never lose the slot
    }
    const replacement =
      `${CURATED_PREFIX}\nTool: ${m.toolName ?? "unknown"}\n` +
      (summary ? `Summary: ${summary}` : "(summary unavailable — result elided)");
    if (replacement.length < m.content.length) {
      savedChars += m.content.length - replacement.length;
      messages[idx] = { ...m, content: replacement };
      curatedCount++;
    }
  }

  return {
    curatedCount,
    savedChars,
    usage: total.inputTokens + total.outputTokens > 0 ? total : null,
    model: role.model,
    provider: role.provider,
  };
}
