import { describe, expect, it } from "vitest";
import {
  AGENT_BOUNDS,
  AGENT_DEFAULT_MODEL,
  AGENT_DEFAULT_STEERING,
  agentConfigSchema,
  agentSteering,
  parseAgentConfig,
} from "./config";

describe("agentConfigSchema / parseAgentConfig", () => {
  it("a bare {} parses to a complete working config (fresh enable)", () => {
    const cfg = parseAgentConfig({});
    expect(cfg.credential).toBe("api"); // API key is the default — subscription is opt-in
    expect(cfg.model).toBe(AGENT_DEFAULT_MODEL);
    expect(cfg.effort).toBe("high"); // owner default: Sonnet 5, high reasoning
    expect(cfg.maxTurns).toBe(50);
    expect(cfg.maxMinutes).toBe(10);
    expect(cfg.maxBudgetUsd).toBe(10);
    expect(cfg.steering).toBe("");
  });

  it("null/undefined/garbage all fall back to defaults, never throw", () => {
    for (const raw of [null, undefined, 42, "nope", { maxTurns: "elephant" }]) {
      const cfg = parseAgentConfig(raw);
      expect(cfg.model).toBe(AGENT_DEFAULT_MODEL);
    }
  });

  it("coerces form-submitted number strings", () => {
    const cfg = parseAgentConfig({ maxTurns: "25", maxMinutes: "5", maxBudgetUsd: "2.5" });
    expect(cfg.maxTurns).toBe(25);
    expect(cfg.maxMinutes).toBe(5);
    expect(cfg.maxBudgetUsd).toBe(2.5);
  });

  it("rejects out-of-bounds numbers at the schema (the admin form's server check)", () => {
    expect(
      agentConfigSchema.safeParse({ maxTurns: AGENT_BOUNDS.maxTurns.max + 1 }).success,
    ).toBe(false);
    expect(agentConfigSchema.safeParse({ maxMinutes: 0 }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ credential: "paste-my-token" }).success).toBe(
      false,
    );
  });

  it("agentSteering: admin override wins, default otherwise, whitespace is not an override", () => {
    expect(agentSteering(parseAgentConfig({}))).toBe(AGENT_DEFAULT_STEERING);
    expect(agentSteering(parseAgentConfig({ steering: "   " }))).toBe(
      AGENT_DEFAULT_STEERING,
    );
    expect(agentSteering(parseAgentConfig({ steering: "Use sparingly." }))).toBe(
      "Use sparingly.",
    );
  });

  it("the defaults themselves satisfy the form bounds (the Limits-form lesson)", () => {
    const cfg = parseAgentConfig({});
    expect(cfg.maxTurns).toBeGreaterThanOrEqual(AGENT_BOUNDS.maxTurns.min);
    expect(cfg.maxTurns).toBeLessThanOrEqual(AGENT_BOUNDS.maxTurns.max);
    expect(cfg.maxMinutes).toBeGreaterThanOrEqual(AGENT_BOUNDS.maxMinutes.min);
    expect(cfg.maxMinutes).toBeLessThanOrEqual(AGENT_BOUNDS.maxMinutes.max);
    expect(cfg.maxBudgetUsd).toBeGreaterThanOrEqual(AGENT_BOUNDS.maxBudgetUsd.min);
    expect(cfg.maxBudgetUsd).toBeLessThanOrEqual(AGENT_BOUNDS.maxBudgetUsd.max);
  });
});
