import { beforeEach, describe, expect, it } from "vitest";
import {
  chargeProxyToken,
  lookupProxyToken,
  mintProxyToken,
  proxyCallAllowed,
  pruneProxyTokens,
  resetProxyTokens,
  revokeProxyToken,
} from "./proxy-tokens";
import {
  SseUsageTracker,
  isStreamingRequest,
  modelFromRequestBody,
  usageFromAnthropic,
  usageFromJsonBody,
} from "./proxy-usage";

const NOW = 1_800_000_000_000;
const base = { conversationId: "c1", userId: "u1", credentialId: "k1", ceilingUsd: 1 };

describe("proxy tokens", () => {
  beforeEach(() => resetProxyTokens());

  it("mints an unguessable token that looks up to its grant", () => {
    const g = mintProxyToken(base, NOW);
    expect(g.token).toMatch(/^[0-9a-f]{64}$/);
    expect(lookupProxyToken(g.token, NOW)?.conversationId).toBe("c1");
    expect(mintProxyToken(base, NOW).token).not.toBe(g.token);
  });

  it("unknown, expired and revoked tokens all read as null", () => {
    expect(lookupProxyToken("nope", NOW)).toBeNull();
    const g = mintProxyToken({ ...base, ttlMs: 1000 }, NOW);
    expect(lookupProxyToken(g.token, NOW + 999)).not.toBeNull();
    expect(lookupProxyToken(g.token, NOW + 1000)).toBeNull();
    const r = mintProxyToken(base, NOW);
    revokeProxyToken(r.token);
    expect(lookupProxyToken(r.token, NOW)).toBeNull();
  });

  it("charges spend and refuses once the ceiling is reached", () => {
    const g = mintProxyToken({ ...base, ceilingUsd: 0.5 }, NOW);
    expect(proxyCallAllowed(g)).toBe(true);
    chargeProxyToken(g.token, 0.3);
    expect(proxyCallAllowed(lookupProxyToken(g.token, NOW)!)).toBe(true);
    chargeProxyToken(g.token, 0.3);
    const after = lookupProxyToken(g.token, NOW)!;
    expect(after.spentUsd).toBeCloseTo(0.6);
    expect(after.calls).toBe(2);
    expect(proxyCallAllowed(after)).toBe(false);
  });

  it("a ceiling of 0 means no ceiling", () => {
    const g = mintProxyToken({ ...base, ceilingUsd: 0 }, NOW);
    chargeProxyToken(g.token, 999);
    expect(proxyCallAllowed(lookupProxyToken(g.token, NOW)!)).toBe(true);
  });

  it("negative charges never reduce spend", () => {
    const g = mintProxyToken(base, NOW);
    chargeProxyToken(g.token, 0.2);
    chargeProxyToken(g.token, -5);
    expect(lookupProxyToken(g.token, NOW)!.spentUsd).toBeCloseTo(0.2);
  });

  it("prune drops expired grants and reports how many", () => {
    mintProxyToken({ ...base, ttlMs: 10 }, NOW);
    mintProxyToken({ ...base, ttlMs: 10_000 }, NOW);
    expect(pruneProxyTokens(NOW + 100)).toBe(1);
  });
});

describe("usage parsing", () => {
  it("maps Anthropic's usage object onto the uncached-input convention", () => {
    expect(
      usageFromAnthropic({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 });
    expect(usageFromAnthropic({ input_tokens: 5 })).toEqual({ inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(usageFromAnthropic({})).toBeNull();
    expect(usageFromAnthropic(null)).toBeNull();
  });

  it("reads a non-streaming body", () => {
    expect(usageFromJsonBody({ id: "m", usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(usageFromJsonBody({ id: "m" })).toBeNull();
  });

  it("model and stream flag come from the request body", () => {
    expect(modelFromRequestBody({ model: "claude-sonnet-5", stream: true })).toBe("claude-sonnet-5");
    expect(isStreamingRequest({ stream: true })).toBe(true);
    expect(isStreamingRequest({})).toBe(false);
    expect(modelFromRequestBody("junk")).toBe("");
  });
});

describe("SseUsageTracker", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join("\n") + "\n";

  it("combines message_start input counts with the final message_delta output count", () => {
    const t = new SseUsageTracker();
    t.feed(sse);
    expect(t.usage()).toEqual({ inputTokens: 12, outputTokens: 57, cacheReadTokens: 2000, cacheWriteTokens: 100 });
  });

  it("survives arbitrary chunk boundaries", () => {
    for (const size of [1, 7, 33, 128]) {
      const t = new SseUsageTracker();
      for (let i = 0; i < sse.length; i += size) t.feed(sse.slice(i, i + size));
      expect(t.usage()?.outputTokens).toBe(57);
      expect(t.usage()?.cacheReadTokens).toBe(2000);
    }
  });

  it("a message_delta carrying refreshed input counts wins over message_start", () => {
    const t = new SseUsageTracker();
    t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n');
    t.feed('data: {"type":"message_delta","usage":{"input_tokens":9,"output_tokens":3,"cache_read_input_tokens":50}}\n');
    expect(t.usage()).toEqual({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 50, cacheWriteTokens: 0 });
  });

  it("no usage seen → null; garbage lines are ignored", () => {
    const t = new SseUsageTracker();
    t.feed("data: not json with \"usage\"\n\n");
    expect(t.usage()).toBeNull();
  });
});
