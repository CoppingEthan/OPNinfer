import { describe, expect, it } from "vitest";
import { buildAssistantSystemBlock, DEFAULT_ASSISTANT_NAME } from "./assistant";

/**
 * The standing system block. The rules that matter: the model is ALWAYS told
 * its own name (a blank instructions field must not mean "no identity"), and
 * the admin's text is passed through verbatim — it's a prompt, so any
 * reformatting we do silently changes behaviour the admin can't see.
 */
describe("buildAssistantSystemBlock", () => {
  it("names the assistant even with no instructions set", () => {
    const block = buildAssistantSystemBlock({ name: "ACME AI Assistant" });
    expect(block).toContain("ACME AI Assistant");
  });

  it("falls back to the default name when none is configured", () => {
    expect(buildAssistantSystemBlock({})).toContain(DEFAULT_ASSISTANT_NAME);
  });

  it("appends the admin's instructions verbatim, after the identity line", () => {
    const custom = "Be concise.\n\n- Use British spelling.\n- Never quote prices.";
    const block = buildAssistantSystemBlock({ name: "Globex", systemPrompt: custom });
    expect(block).toContain(custom);
    expect(block.indexOf("Globex")).toBeLessThan(block.indexOf(custom));
  });

  it("ignores whitespace-only instructions", () => {
    const blank = buildAssistantSystemBlock({ name: "Acme", systemPrompt: "   \n\t " });
    expect(blank).toBe(buildAssistantSystemBlock({ name: "Acme" }));
  });

  it("trims a padded name rather than emitting a ragged sentence", () => {
    expect(buildAssistantSystemBlock({ name: "  Acme AI  " })).toContain("You are Acme AI,");
  });

  it("falls back to the default name when the name is blank", () => {
    expect(buildAssistantSystemBlock({ name: "   " })).toContain(DEFAULT_ASSISTANT_NAME);
  });
});
