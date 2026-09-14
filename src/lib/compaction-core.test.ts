import { describe, expect, it } from "vitest";
import {
  COMPACTION_SYSTEM,
  clipSummary,
  compactionUserPrompt,
  estimateRowsTokens,
  planChunks,
  renderRow,
  selectBoundary,
  summaryMessages,
  type CompactRow,
} from "./compaction-core";

const t0 = Date.parse("2026-01-01T00:00:00Z");
/** n turns; each user row `uChars` long, each reply `aChars` long. */
function turns(n: number, uChars = 400, aChars = 4_000): CompactRow[] {
  const rows: CompactRow[] = [];
  for (let k = 0; k < n; k++) {
    rows.push({ id: `u${k}`, role: "user", content: `Q${k} ` + "x".repeat(uChars), createdAt: new Date(t0 + k * 60_000) });
    rows.push({ id: `a${k}`, role: "assistant", content: `A${k} ` + "y".repeat(aChars), createdAt: new Date(t0 + k * 60_000 + 1) });
  }
  return rows;
}

describe("selectBoundary", () => {
  it("keeps whole recent turns within the budget and cuts before them", () => {
    // 10 turns of ~1,100 tokens each; keep 3,500 → the last three turns fit.
    const rows = turns(10);
    const b = selectBoundary(rows, 3_500);
    expect(rows[b].id).toBe("a6"); // last summarised = the reply of turn 6
    expect(rows[b + 1].id).toBe("u7"); // first kept = the question of turn 7
  });

  it("never splits a question from its reply", () => {
    const rows = turns(10);
    for (const keep of [1_000, 1_101, 2_000, 2_300, 5_000]) {
      const b = selectBoundary(rows, keep);
      expect(rows[b + 1]?.role ?? "user").toBe("user");
    }
  });

  it("returns -1 when everything fits — nothing to summarise", () => {
    expect(selectBoundary(turns(3), 100_000)).toBe(-1);
    expect(selectBoundary([], 100)).toBe(-1);
  });

  it("keeps nothing when even the newest turn is over budget (a giant paste)", () => {
    const rows = turns(2, 400, 200_000);
    const b = selectBoundary(rows, 20_000);
    expect(b).toBe(rows.length - 1);
  });

  it("only ever moves forward past a previous boundary", () => {
    const rows = turns(10);
    const first = selectBoundary(rows, 3_500);
    // Same rows again with the previous boundary further on than the natural
    // cut → summarise everything rather than go backwards.
    const later = selectBoundary(rows, 3_500, first + 4);
    expect(later).toBe(rows.length - 1);
    // A previous boundary well behind the natural cut leaves it alone.
    expect(selectBoundary(rows, 3_500, 1)).toBe(first);
  });

  it("treats a leading assistant row (an imported error reply) as part of the first turn", () => {
    const rows: CompactRow[] = [
      { id: "a-1", role: "assistant", content: "⚠️ The AI provider had a temporary server error.", createdAt: new Date(t0) },
      ...turns(4),
    ];
    const b = selectBoundary(rows, 2_500);
    expect(rows[b + 1].role).toBe("user");
    expect(b).toBeGreaterThanOrEqual(0);
  });
});

describe("planChunks", () => {
  it("packs rows in order and never exceeds the cap", () => {
    const rows = turns(30, 400, 4_000);
    const chunks = planChunks(rows, () => null, 20_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20_000);
    expect(chunks[0].startsWith("User:\nQ0")).toBe(true);
    // Order preserved across the split.
    const joined = chunks.join("\n\n");
    expect(joined.indexOf("Q5 ")).toBeLessThan(joined.indexOf("Q6 "));
  });

  it("splits a single row that is bigger than the cap, with continuation markers", () => {
    const rows: CompactRow[] = [
      { id: "u", role: "user", content: "Q", createdAt: new Date(t0) },
      { id: "a", role: "assistant", content: "z".repeat(25_000), createdAt: new Date(t0 + 1) },
      { id: "u2", role: "user", content: "next", createdAt: new Date(t0 + 2) },
    ];
    const chunks = planChunks(rows, () => null, 10_000);
    expect(chunks.length).toBe(5); // "User: Q" | 3 slices of the big reply | "User: next"
    expect(chunks[2].startsWith("(continued, part 2)")).toBe(true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10_000 + 40);
  });

  it("names the author in a shared chat", () => {
    const row: CompactRow = { id: "u", role: "user", content: "hello", createdAt: new Date(t0), userId: "p1" };
    expect(renderRow(row, "Priya")).toBe("User (Priya):\nhello");
    expect(renderRow(row)).toBe("User:\nhello");
  });
});

describe("prompts and replay shape", () => {
  it("the instructions ask for the six sections and for reusable content verbatim", () => {
    for (const s of ["1.", "2.", "3.", "4.", "5.", "6."]) expect(COMPACTION_SYSTEM).toContain(s);
    expect(COMPACTION_SYSTEM).toMatch(/VERBATIM/);
    expect(COMPACTION_SYSTEM).toMatch(/Never invent/);
    expect(COMPACTION_SYSTEM).toMatch(/REPLACES the summary so far/);
  });

  it("carries the summary so far ahead of the next part, and labels parts", () => {
    expect(compactionUserPrompt(null, "T", 0, 1)).toBe("Transcript:\n\nT");
    const p = compactionUserPrompt("S", "T", 1, 3);
    expect(p.startsWith("Summary so far:\nS\n\n")).toBe(true);
    expect(p).toContain("Transcript (part 2 of 3):");
  });

  it("replays as one user message plus an acknowledgement, naming how many messages it replaces", () => {
    const m = summaryMessages("the summary", 120);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(m[0].content).toContain("replaces the 120 earlier messages");
    expect(m[0].content.endsWith("the summary")).toBe(true);
  });

  it("clips an oversize summary at a paragraph, never mid-word", () => {
    const para = "A sentence that goes on for a bit. ".repeat(40).trim();
    const text = Array.from({ length: 30 }, () => para).join("\n\n");
    const out = clipSummary(text, 5_000);
    expect(out.length).toBeLessThanOrEqual(5_000);
    expect(out.endsWith(".")).toBe(true);
    expect(clipSummary("short")).toBe("short");
  });

  it("estimates tokens as chars/4", () => {
    expect(estimateRowsTokens([{ content: "x".repeat(400) }, { content: "y".repeat(3) }])).toBe(101);
  });
});
