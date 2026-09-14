import { describe, expect, it } from "vitest";
import { orderThreadRows, strictlyIncreasing } from "./thread-order";

const at = (s: string) => new Date(s);

describe("orderThreadRows", () => {
  it("keeps time order when timestamps differ", () => {
    const rows = [
      { id: "b", role: "assistant", createdAt: at("2026-01-01T00:00:02Z") },
      { id: "a", role: "user", createdAt: at("2026-01-01T00:00:01Z") },
    ];
    expect(orderThreadRows(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("puts the question before its answer when they share a timestamp — the imported-chat case", () => {
    const t = at("2025-07-10T01:49:52Z");
    const rows = [
      { id: "z-answer", role: "assistant", createdAt: t },
      { id: "a-question", role: "user", createdAt: t },
    ];
    expect(orderThreadRows(rows).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("gives the same answer whatever order the rows arrive in", () => {
    const t1 = at("2025-07-10T01:49:52Z");
    const t2 = at("2025-07-10T01:55:00Z");
    const rows = [
      { id: "4", role: "assistant", createdAt: t2 },
      { id: "3", role: "user", createdAt: t2 },
      { id: "2", role: "assistant", createdAt: t1 },
      { id: "1", role: "user", createdAt: t1 },
    ];
    const expected = ["1", "2", "3", "4"];
    expect(orderThreadRows(rows).map((r) => r.id)).toEqual(expected);
    expect(orderThreadRows([...rows].reverse()).map((r) => r.id)).toEqual(expected);
    expect(orderThreadRows([rows[2], rows[0], rows[3], rows[1]]).map((r) => r.id)).toEqual(expected);
  });

  it("falls back to id for two rows of the same role at the same instant", () => {
    const t = at("2025-07-10T01:49:52Z");
    const rows = [
      { id: "b", role: "user", createdAt: t },
      { id: "a", role: "user", createdAt: t },
    ];
    expect(orderThreadRows(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("accepts ISO strings as well as Dates and does not mutate its input", () => {
    const rows = [
      { id: "b", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "a", role: "user", createdAt: "2026-01-01T00:00:01.000Z" },
    ];
    const out = orderThreadRows(rows);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("strictlyIncreasing", () => {
  it("nudges a repeated timestamp forward by a millisecond, in order", () => {
    const t = at("2025-07-10T01:49:52Z");
    const out = strictlyIncreasing([t, t, t, at("2025-07-10T01:49:53Z")]);
    expect(out.map((d) => d.getTime() - t.getTime())).toEqual([0, 1, 2, 1000]);
  });

  it("leaves distinct timestamps alone", () => {
    const a = at("2025-07-10T01:49:52Z");
    const b = at("2025-07-10T01:49:52.500Z");
    expect(strictlyIncreasing([a, b]).map((d) => d.getTime())).toEqual([a.getTime(), b.getTime()]);
  });

  it("also repairs a timestamp that goes BACKWARDS", () => {
    const out = strictlyIncreasing([at("2025-07-10T01:49:53Z"), at("2025-07-10T01:49:52Z")]);
    expect(out[1].getTime()).toBe(out[0].getTime() + 1);
  });
});
