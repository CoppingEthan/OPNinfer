import type { TokenUsage } from "@/lib/providers/types";

/**
 * Reading REAL token usage off Anthropic Messages API responses as they pass
 * through the credential proxy — the authoritative numbers for the
 * API-key path. Anthropic says plainly not to bill from the SDK's client-side
 * estimates; this is what to bill from instead. Pure and tested.
 *
 * Two response shapes:
 *  - non-streaming JSON: `usage` on the body;
 *  - streaming SSE: `message_start` carries the input-side counts,
 *    `message_delta` carries the running output count (and, on newer
 *    servers, refreshed input counts) — the LAST delta wins.
 */

/** Anthropic's usage object → OPNinfer's convention (inputTokens = uncached). */
export function usageFromAnthropic(u: unknown): TokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const r = u as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : 0);
  if (!("input_tokens" in r) && !("output_tokens" in r)) return null;
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadTokens: n("cache_read_input_tokens"),
    cacheWriteTokens: n("cache_creation_input_tokens"),
  };
}

/** Non-streaming: the body's `usage`. */
export function usageFromJsonBody(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") return null;
  return usageFromAnthropic((body as { usage?: unknown }).usage);
}

/**
 * Streaming: feed raw SSE text as it flows; ask for the total at the end.
 * Only `message_start` and `message_delta` events are parsed — everything
 * else (content deltas, which are the bulk) is skipped by a cheap substring
 * check before any JSON work.
 */
export class SseUsageTracker {
  private buf = "";
  private start: TokenUsage | null = null;
  private delta: TokenUsage | null = null;

  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      if (!line.includes('"usage"')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (ev.type === "message_start") {
          const m = ev.message as { usage?: unknown } | undefined;
          this.start = usageFromAnthropic(m?.usage) ?? this.start;
        } else if (ev.type === "message_delta") {
          this.delta = usageFromAnthropic(ev.usage) ?? this.delta;
        }
      } catch {
        /* a partial or odd line — not ours to fail on */
      }
    }
  }

  /** The response's total, or null if no usage was ever seen. */
  usage(): TokenUsage | null {
    if (!this.start && !this.delta) return null;
    const s = this.start ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const d = this.delta;
    // message_delta's output count is cumulative and final; its input-side
    // counts, when present and non-zero, are the refreshed truth.
    return {
      inputTokens: d && d.inputTokens > 0 ? d.inputTokens : s.inputTokens,
      outputTokens: d ? d.outputTokens : s.outputTokens,
      cacheReadTokens: d && d.cacheReadTokens > 0 ? d.cacheReadTokens : s.cacheReadTokens,
      cacheWriteTokens: d && d.cacheWriteTokens > 0 ? d.cacheWriteTokens : s.cacheWriteTokens,
    };
  }
}

/** The model a request is for, from its JSON body (for pricing). */
export function modelFromRequestBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const m = (body as { model?: unknown }).model;
  return typeof m === "string" ? m : "";
}

/** Whether the request asked for a streamed response. */
export function isStreamingRequest(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { stream?: unknown }).stream === true;
}
