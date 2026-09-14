import { describe, expect, it } from "vitest";
import { userFacingToolError } from "./types";

describe("userFacingToolError", () => {
  it("cuts assistant guidance and drops the Error: prefix", () => {
    const raw =
      'Error: weekly image quota reached — 5/5 "standard"-quality images in the last 7 days. ' +
      "[To the assistant: tell the user plainly. Do NOT silently retry.]";
    const out = userFacingToolError(raw);
    expect(out).toBe('weekly image quota reached — 5/5 "standard"-quality images in the last 7 days.');
    expect(out).not.toMatch(/assistant|silently/i);
  });

  it("passes plain errors through unchanged (minus the prefix)", () => {
    expect(userFacingToolError("Error: source image not found in this chat.")).toBe(
      "source image not found in this chat.",
    );
  });

  it("leaves non-error text alone", () => {
    expect(userFacingToolError("All good")).toBe("All good");
  });
});
