import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIMITS,
  LIMIT_BOUNDS,
  resolveMaxOutputTokens,
} from "@/lib/limits";

/**
 * The defaults are load-bearing: a 4096-token output ceiling truncated real
 * conversations mid-tool-call, so a regression here is a user-visible outage
 * that logs nothing.
 */
describe("default limits", () => {
  it("gives replies room to think, call tools and answer", () => {
    expect(DEFAULT_LIMITS.maxOutputTokens).toBe(64_000);
  });

  it("defaults the working context to 128k", () => {
    expect(DEFAULT_LIMITS.maxInputTokens).toBe(128_000);
  });

  it("keeps the tool-round budget at what the pipeline used to hard-code", () => {
    // Changing this silently changes cost and behaviour on every instance
    // that has never opened Admin → Models. Deliberate change only.
    expect(DEFAULT_LIMITS.maxToolRounds).toBe(6);
  });

  it("keeps the defaults inside their own bounds", () => {
    expect(DEFAULT_LIMITS.maxOutputTokens).toBeGreaterThanOrEqual(
      LIMIT_BOUNDS.maxOutputTokens.min,
    );
    expect(DEFAULT_LIMITS.maxOutputTokens).toBeLessThanOrEqual(
      LIMIT_BOUNDS.maxOutputTokens.max,
    );
    expect(DEFAULT_LIMITS.maxInputTokens).toBeGreaterThanOrEqual(
      LIMIT_BOUNDS.maxInputTokens.min,
    );
    expect(DEFAULT_LIMITS.maxInputTokens).toBeLessThanOrEqual(
      LIMIT_BOUNDS.maxInputTokens.max,
    );
    expect(DEFAULT_LIMITS.maxToolRounds).toBeGreaterThanOrEqual(
      LIMIT_BOUNDS.maxToolRounds.min,
    );
    expect(DEFAULT_LIMITS.maxToolRounds).toBeLessThanOrEqual(
      LIMIT_BOUNDS.maxToolRounds.max,
    );
  });

  it("every default is inside its bound and expressible in the admin form", () => {
    // A number input rejects any value where (value - min) % step !== 0. The
    // form shipped with min=1024 step=1024 while the default was 64,000 —
    // which is NOT a multiple of 1024 — so the browser blocked submission and
    // the Limits card could not save its own defaults (v0.3.1 → 2026-08-03).
    // The form now uses step=1; this asserts the defaults stay expressible.
    const STEP = 1;
    for (const key of ["maxOutputTokens", "maxInputTokens", "maxToolRounds"] as const) {
      const value = DEFAULT_LIMITS[key];
      const { min, max } = LIMIT_BOUNDS[key];
      expect(Number.isInteger(value), `${key} must be a whole number`).toBe(true);
      expect(value, `${key} below its min`).toBeGreaterThanOrEqual(min);
      expect(value, `${key} above its max`).toBeLessThanOrEqual(max);
      expect((value - min) % STEP, `${key} is not on a valid step from min`).toBe(0);
    }
  });

  it("never allows a zero tool-round budget", () => {
    // 0 would offer tools and then immediately withhold them, which is the
    // shape that produced empty replies before the forced-answer guard.
    expect(LIMIT_BOUNDS.maxToolRounds.min).toBeGreaterThanOrEqual(1);
  });
});

describe("resolveMaxOutputTokens", () => {
  it("uses the configured ceiling when the model's is unknown", () => {
    expect(resolveMaxOutputTokens(64_000)).toBe(64_000);
    expect(resolveMaxOutputTokens(64_000, null)).toBe(64_000);
    expect(resolveMaxOutputTokens(64_000, undefined)).toBe(64_000);
  });

  it("clamps down to what the model can actually emit", () => {
    // Haiku 4.5 tops out at 64k; asking a 32k model for 64k would 400.
    expect(resolveMaxOutputTokens(64_000, 32_000)).toBe(32_000);
  });

  it("never raises the configured ceiling to meet a bigger model", () => {
    expect(resolveMaxOutputTokens(16_000, 128_000)).toBe(16_000);
  });

  it("ignores a nonsense model ceiling rather than zeroing the budget", () => {
    expect(resolveMaxOutputTokens(64_000, 0)).toBe(64_000);
    expect(resolveMaxOutputTokens(64_000, -1)).toBe(64_000);
    expect(resolveMaxOutputTokens(64_000, Number.NaN)).toBe(64_000);
  });
});
