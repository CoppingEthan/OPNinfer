import { describe, expect, it } from "vitest";
import { planInlineTake } from "./file-tools";

describe("planInlineTake (manifest inline-content budget rule)", () => {
  it("inlines a file fully when it fits the remaining budget", () => {
    expect(planInlineTake(1000, 24_000)).toBe(1000);
    expect(planInlineTake(24_000, 24_000)).toBe(24_000);
  });

  it("truncates to the remaining budget when the file is larger", () => {
    expect(planInlineTake(50_000, 6_000)).toBe(6_000);
  });

  it("inlines nothing once the budget is spent", () => {
    expect(planInlineTake(1000, 0)).toBe(0);
    expect(planInlineTake(1000, -5)).toBe(0);
  });

  it("skips a truncated head when too little budget remains (→ read_file)", () => {
    expect(planInlineTake(50_000, 399)).toBe(0);
    expect(planInlineTake(50_000, 400)).toBe(400);
  });
});
