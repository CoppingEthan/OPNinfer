import { describe, expect, it } from "vitest";
import { segmentReply } from "./reply-timeline";

const item = (at?: number, tag = "x") => ({ at, tag });

describe("segmentReply", () => {
  it("no activity → one full-text slot", () => {
    expect(segmentReply(10, [])).toEqual([{ start: 0, end: 10, items: [] }]);
  });

  it("interleaves: prose → items → prose → items → trailing prose", () => {
    const a1 = item(6, "a1");
    const a2 = item(6, "a2");
    const b = item(20, "b");
    const slots = segmentReply(30, [a1, a2, b]);
    expect(slots).toEqual([
      { start: 0, end: 6, items: [a1, a2] },
      { start: 6, end: 20, items: [b] },
      { start: 20, end: 30, items: [] },
    ]);
  });

  it("all-at-zero (legacy rows) → everything above the text, as before", () => {
    const a = item(0, "a");
    const b = item(undefined, "b");
    const slots = segmentReply(12, [a, b]);
    expect(slots).toEqual([
      { start: 0, end: 0, items: [a, b] },
      { start: 0, end: 12, items: [] },
    ]);
  });

  it("clamps offsets beyond the content", () => {
    const a = item(99, "a");
    expect(segmentReply(5, [a])).toEqual([
      { start: 0, end: 5, items: [a] },
      { start: 5, end: 5, items: [] },
    ]);
  });

  it("never moves backwards: an out-of-order offset joins the previous slot", () => {
    const a = item(10, "a");
    const rogue = item(4, "rogue");
    const slots = segmentReply(20, [a, rogue]);
    expect(slots).toEqual([
      { start: 0, end: 10, items: [a, rogue] },
      { start: 10, end: 20, items: [] },
    ]);
  });

  it("empty reply with activity → one empty-text slot + trailing empty slot", () => {
    const a = item(0, "a");
    expect(segmentReply(0, [a])).toEqual([
      { start: 0, end: 0, items: [a] },
      { start: 0, end: 0, items: [] },
    ]);
  });
});
