import { describe, expect, it } from "vitest";
import { estimateTokens, selectCurationTargets } from "./curation";
import type { ChatMessage } from "@/lib/providers/types";

function toolMsg(name: string, size: number): ChatMessage {
  return { role: "tool", toolName: name, toolCallId: "x", content: "r".repeat(size) };
}

describe("selectCurationTargets", () => {
  const user: ChatMessage = { role: "user", content: "hi" };

  it("keeps the most recent N tool results untouched", () => {
    const msgs: ChatMessage[] = [user, ...Array.from({ length: 8 }, (_, i) => toolMsg(`t${i}`, 1000))];
    const targets = selectCurationTargets(msgs, { keepRecent: 5, minChars: 500 });
    expect(targets).toEqual([1, 2, 3]); // 8 tool msgs at idx 1..8; keep last 5
  });

  it("never selects memory ops", () => {
    const msgs: ChatMessage[] = [
      user,
      toolMsg("memory_view", 2000),
      toolMsg("web_search", 2000),
      ...Array.from({ length: 5 }, (_, i) => toolMsg(`recent${i}`, 1000)),
    ];
    const targets = selectCurationTargets(msgs, { keepRecent: 5, minChars: 500 });
    expect(targets).toEqual([2]); // only the web_search; memory op skipped
  });

  it("skips small and already-curated results", () => {
    const msgs: ChatMessage[] = [
      user,
      toolMsg("small", 100),
      { role: "tool", toolName: "web_search", toolCallId: "x", content: "[Tool result curated to save context]\nTool: web_search" },
      toolMsg("big", 900),
      ...Array.from({ length: 5 }, (_, i) => toolMsg(`recent${i}`, 1000)),
    ];
    const targets = selectCurationTargets(msgs, { keepRecent: 5, minChars: 500 });
    expect(targets).toEqual([3]);
  });
});

describe("estimateTokens", () => {
  it("counts chars/4 plus a flat image cost", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "a".repeat(4000) },
      { role: "user", content: "hi", images: [{ mimeType: "image/png", dataBase64: "AAA" }] },
    ];
    const est = estimateTokens(msgs);
    expect(est).toBeGreaterThanOrEqual(2000); // 1000 text + 1000 image + change
    expect(est).toBeLessThan(2100);
  });
});
