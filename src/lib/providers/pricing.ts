import type { TokenUsage } from "./types";

/**
 * Per-model token pricing, USD per 1,000,000 tokens. Cost is computed at log
 * time and written to `usage_records.cost_estimate` (spec §4/§6).
 *
 * Each provider reports cache tokens on a different convention, but by the time
 * usage reaches here it is already normalized to {@link TokenUsage}: `input` is
 * uncached, `cacheRead`/`cacheWrite` are separate. So one formula works for all:
 *   cost = input·in + cacheRead·cacheRead + cacheWrite·cacheWrite + output·out
 *
 * Rates change often; this is a baseline. Models not listed log token counts
 * with a cost of 0 rather than a fabricated number — admins can refine rates.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Rates sourced from official pricing pages (July 2026) — there is no token
// pricing API from any provider, so these are maintained from those pages.
// A model missing from this table logs its tokens at a cost of ZERO, silently:
// after adding or changing an assistant role in Admin → Models, check that the
// bound model id resolves here (`scripts/test-pricing-coverage.ts`).
//   Anthropic: platform.claude.com/docs/en/pricing  (cacheRead 0.1×, 5-min
//              cacheWrite 1.25× of input)
//   OpenAI:    developers.openai.com/api/docs/pricing  (legacy gpt-4.x prices
//              were removed from the page — omitted here rather than guessed)
//   Google:    ai.google.dev/gemini-api/docs/pricing  (cacheWrite is a per-hour
//              storage charge, not per-token, so it's out of scope → 0)
// Longest-prefix matching covers dated/suffixed ids (e.g. -20251001).
const RATES: Record<string, Rates> = {
  // --- Anthropic ---
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

  // --- OpenAI (current generation; cached input ~0.1× input) ---
  // NB: cacheWrite stays 0 for every OpenAI model — their caching is automatic
  // and the API reports no write tier, so `cacheWriteTokens` is always 0 for
  // this provider (see openai.ts). The rate would never be applied.
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },

  // --- Google Gemini (input/output for ≤200k prompts where tiered) ---
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  // Keyed on the BARE id, never the "-preview" one. Matching is longest-prefix,
  // and "gemini-3.1-pro-preview" is LONGER than the GA id it becomes — so a
  // preview-only key stops matching the moment the model graduates, and every
  // call silently logs £0. The bare key covers both (the preview id starts with
  // it); a "-preview" key covers only the preview.
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

/** Resolve rates for a model id (exact match, then longest known prefix). */
export function ratesFor(model: string): Rates | null {
  if (RATES[model]) return RATES[model];
  let best: { len: number; rates: Rates } | null = null;
  for (const [id, rates] of Object.entries(RATES)) {
    if (model.startsWith(id) && (!best || id.length > best.len)) {
      best = { len: id.length, rates };
    }
  }
  return best?.rates ?? null;
}

/** USD cost for a usage record. Returns 0 when the model's rates are unknown. */
export function estimateCost(model: string, usage: TokenUsage): number {
  const r = ratesFor(model);
  if (!r) return 0;
  const cost =
    (usage.inputTokens * r.input +
      usage.outputTokens * r.output +
      usage.cacheReadTokens * r.cacheRead +
      usage.cacheWriteTokens * r.cacheWrite) /
    1_000_000;
  // Round to the 6 decimal places the numeric(10,6) column stores.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
