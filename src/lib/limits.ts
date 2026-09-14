import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * Instance-wide token limits, admin-configurable (Admin → Models).
 *
 * These exist because a per-provider default silently strangled a real
 * conversation: Anthropic's non-thinking default was 4096, and Sonnet 5 thinks
 * even when `thinking` is omitted (a change from 4.6), so every substantive
 * turn hit the ceiling mid-tool-call. The model got cut off before it could
 * finish calling the sandbox, no file was produced, and — because a truncated
 * response is a perfectly successful API call — nothing errored or alerted.
 *
 * The lesson is that the ceiling must be OURS and explicit, not whatever each
 * provider happens to default to. One number, applied to every provider, every
 * model and every reasoning setting.
 */

export interface TokenLimits {
  /** Hard ceiling on a single reply (thinking + tool calls + prose). */
  maxOutputTokens: number;
  /** Context budget: above this, long tool results are curated away. */
  maxInputTokens: number;
  /**
   * How many times a single reply may stop to use tools before it MUST answer.
   *
   * Rounds, not calls: one round can carry several tool calls if the model
   * batches them. Progressive disclosure also means the first round is often
   * spent on `enable_tools`, so the working budget is roughly this minus one.
   *
   * Too low and long jobs (crawl a site, process a folder) run out and ask the
   * user to say "continue"; too high and a stuck model can burn a lot of
   * tokens, since every round replays the whole transcript.
   */
  maxToolRounds: number;
  /**
   * Conversation compaction (2026-09-10). When the replayed history reaches
   * `compactAtTokens`, everything but the most recent `compactKeepTokens`
   * worth of turns is summarised by the front-end model before the reply is
   * generated (see compaction.ts). Nothing in the app ever shortened a
   * conversation before this: one imported chat reached 525k tokens and cost
   * US$2 a message.
   */
  compactAtTokens: number;
  compactKeepTokens: number;
}

/** 64k out covers any realistic reply; 128k in is a generous working context.
 *  6 tool rounds is what the pipeline hard-coded before this was configurable. */
export const DEFAULT_LIMITS: TokenLimits = {
  maxOutputTokens: 64_000,
  maxInputTokens: 128_000,
  maxToolRounds: 6,
  compactAtTokens: 96_000,
  compactKeepTokens: 20_000,
};

/** Guard rails for the admin form — a typo shouldn't be able to break chat.
 *  The tool-round ceiling is deliberately modest: the 15-minute per-turn
 *  hard stop is the real backstop, and every round costs a full model call. */
export const LIMIT_BOUNDS = {
  maxOutputTokens: { min: 1_024, max: 200_000 },
  maxInputTokens: { min: 8_000, max: 2_000_000 },
  maxToolRounds: { min: 1, max: 40 },
  compactAtTokens: { min: 20_000, max: 400_000 },
  compactKeepTokens: { min: 4_000, max: 100_000 },
} as const;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export async function getTokenLimits(): Promise<TokenLimits> {
  const stored = await getSetting<Partial<TokenLimits>>(SETTING_KEYS.limits);
  return {
    maxOutputTokens: clamp(
      stored?.maxOutputTokens,
      DEFAULT_LIMITS.maxOutputTokens,
      LIMIT_BOUNDS.maxOutputTokens.min,
      LIMIT_BOUNDS.maxOutputTokens.max,
    ),
    maxInputTokens: clamp(
      stored?.maxInputTokens,
      DEFAULT_LIMITS.maxInputTokens,
      LIMIT_BOUNDS.maxInputTokens.min,
      LIMIT_BOUNDS.maxInputTokens.max,
    ),
    maxToolRounds: clamp(
      stored?.maxToolRounds,
      DEFAULT_LIMITS.maxToolRounds,
      LIMIT_BOUNDS.maxToolRounds.min,
      LIMIT_BOUNDS.maxToolRounds.max,
    ),
    ...compactionLimits(stored ?? {}),
  };
}

/**
 * The two compaction numbers, clamped to their bounds AND to each other: the
 * trigger can never sit above the hard input ceiling (compaction exists to
 * keep prompts under it), and the kept tail must leave room for the summary
 * (at most half the trigger), or a compaction would change nothing.
 */
export function compactionLimits(stored: Partial<TokenLimits>): {
  compactAtTokens: number;
  compactKeepTokens: number;
} {
  const maxInput = clamp(
    stored.maxInputTokens,
    DEFAULT_LIMITS.maxInputTokens,
    LIMIT_BOUNDS.maxInputTokens.min,
    LIMIT_BOUNDS.maxInputTokens.max,
  );
  const compactAt = Math.min(
    clamp(
      stored.compactAtTokens,
      DEFAULT_LIMITS.compactAtTokens,
      LIMIT_BOUNDS.compactAtTokens.min,
      LIMIT_BOUNDS.compactAtTokens.max,
    ),
    maxInput,
  );
  const keep = Math.min(
    clamp(
      stored.compactKeepTokens,
      DEFAULT_LIMITS.compactKeepTokens,
      LIMIT_BOUNDS.compactKeepTokens.min,
      LIMIT_BOUNDS.compactKeepTokens.max,
    ),
    Math.floor(compactAt / 2),
  );
  return { compactAtTokens: compactAt, compactKeepTokens: keep };
}

// A turn makes many model calls (up to 6 tool rounds plus a forced answer),
// and the limits are one rarely-changed settings row — cache them briefly so
// the pipeline doesn't re-read it on every round.
const CACHE_TTL_MS = 30_000;
let cached: { at: number; limits: TokenLimits } | null = null;

export async function getCachedTokenLimits(): Promise<TokenLimits> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.limits;
  const limits = await getTokenLimits();
  cached = { at: now, limits };
  return limits;
}

export async function setTokenLimits(limits: TokenLimits): Promise<void> {
  cached = null; // pick the change up on the next turn, not after the TTL
  await setSetting(SETTING_KEYS.limits, {
    maxOutputTokens: clamp(
      limits.maxOutputTokens,
      DEFAULT_LIMITS.maxOutputTokens,
      LIMIT_BOUNDS.maxOutputTokens.min,
      LIMIT_BOUNDS.maxOutputTokens.max,
    ),
    maxInputTokens: clamp(
      limits.maxInputTokens,
      DEFAULT_LIMITS.maxInputTokens,
      LIMIT_BOUNDS.maxInputTokens.min,
      LIMIT_BOUNDS.maxInputTokens.max,
    ),
    maxToolRounds: clamp(
      limits.maxToolRounds,
      DEFAULT_LIMITS.maxToolRounds,
      LIMIT_BOUNDS.maxToolRounds.min,
      LIMIT_BOUNDS.maxToolRounds.max,
    ),
    ...compactionLimits(limits),
  });
}

/**
 * Clamp the instance ceiling to what a model can actually emit.
 *
 * Asking for more output than a model supports is a 400, so a single global
 * number can't be sent blindly. `modelCeiling` is the provider's advertised
 * limit when we know it (Anthropic publishes `max_tokens` per model and we
 * cache it); when we don't, the configured value is used as-is and a provider
 * complaint surfaces honestly rather than being masked.
 */
export function resolveMaxOutputTokens(
  configured: number,
  modelCeiling?: number | null,
): number {
  if (!modelCeiling || !Number.isFinite(modelCeiling) || modelCeiling <= 0) {
    return configured;
  }
  return Math.min(configured, modelCeiling);
}
