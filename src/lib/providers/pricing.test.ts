import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { ratesFor, estimateCost } from "@/lib/providers/pricing";

/** The model ids the rate table is keyed on, read from its source. */
function ratePrefixes(): string[] {
  const src = readFileSync(
    path.join(process.cwd(), "src", "lib", "providers", "pricing.ts"),
    "utf8",
  );
  const start = src.indexOf("const RATES: Record<string, Rates> = {");
  const body = src.slice(start, src.indexOf("\n};", start));
  return [...body.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]);
}

/**
 * A model with no entry logs its tokens at a cost of $0 — silently, by design
 * (better than a fabricated rate). That makes a missing entry invisible until
 * someone reads the Usage dashboard and wonders why it's free, so the current
 * generation of each provider is pinned here.
 */

const CURRENT_GENERATION = [
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  // Google was absent from this list entirely, despite being a first-class
  // provider and the only image provider — which is how two Gemini rates sat
  // keyed to "-preview" ids that stop matching once the model goes GA.
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-lite",
  "gemini-3-flash",
];

describe("ratesFor", () => {
  it.each(CURRENT_GENERATION)("prices %s", (model) => {
    const rates = ratesFor(model);
    expect(rates).not.toBeNull();
    expect(rates!.input).toBeGreaterThan(0);
    expect(rates!.output).toBeGreaterThan(0);
  });

  it("keeps same-family models apart rather than prefix-matching them", () => {
    // "gpt-5.6-sol" must not resolve to luna's rates (or vice versa).
    expect(ratesFor("gpt-5.6-luna")!.input).toBe(1);
    expect(ratesFor("gpt-5.6-sol")!.input).toBe(5);
    expect(ratesFor("gpt-5.6-terra")!.input).toBe(2.5);
  });

  it("resolves dated/suffixed ids via the longest known prefix", () => {
    expect(ratesFor("gpt-5.6-luna-2026-05-01")).toEqual(ratesFor("gpt-5.6-luna"));
    expect(ratesFor("claude-opus-5-20260601")).toEqual(ratesFor("claude-opus-5"));
  });

  it("returns null for a genuinely unknown model", () => {
    expect(ratesFor("some-model-that-does-not-exist")).toBeNull();
  });

  it("does not let an Opus id fall back to a Sonnet rate", () => {
    expect(ratesFor("claude-opus-5")!.output).toBe(25);
    expect(ratesFor("claude-sonnet-5")!.output).toBe(15);
  });

  it("still prices a model that is currently in preview", () => {
    // The bare key covers the "-preview" id because matching is by prefix…
    expect(ratesFor("gemini-3.1-pro-preview")).toEqual(ratesFor("gemini-3.1-pro"));
    expect(ratesFor("gemini-3-flash-preview")).toEqual(ratesFor("gemini-3-flash"));
  });

  it("has no rate keyed ONLY to a preview id", () => {
    // …but the reverse is not true: a "-preview" key is LONGER than the GA id,
    // so it stops matching the day the model graduates and every call quietly
    // logs zero. That is what happened to two Gemini rates. Key on the bare id.
    const previewOnly = ratePrefixes().filter(
      (id) => id.endsWith("-preview") && !ratePrefixes().includes(id.replace(/-preview$/, "")),
    );
    expect(previewOnly, `rates keyed only to a preview id: ${previewOnly.join(", ")}`).toEqual([]);
  });
});

describe("estimateCost", () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  it("charges input and output at their per-million rates", () => {
    // Opus 5: $5 in + $25 out.
    expect(estimateCost("claude-opus-5", usage)).toBe(30);
  });

  it("prices cache tiers separately from full-price input", () => {
    const cost = estimateCost("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBe(0.5 + 6.25);
  });

  it("returns 0 rather than a fabricated cost for an unknown model", () => {
    expect(estimateCost("some-model-that-does-not-exist", usage)).toBe(0);
  });
});
