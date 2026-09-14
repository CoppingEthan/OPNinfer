import { describe, expect, it } from "vitest";
import { isReportDue, localParts, type WeeklyReportConfig } from "./weekly-report";

/**
 * The schedule is the part that can silently go wrong: a stored UTC hour looks
 * correct for half the year and then drifts. These pin the wall-clock
 * behaviour across the British clock change, and the once-per-day rule that
 * stops the tick loop re-sending all evening.
 */

const base: Omit<WeeklyReportConfig, "lastRunLocalDate" | "lastRunAt"> = {
  enabled: true,
  email: "owner@example.com",
  timeZone: "Europe/London",
  weekday: "Fri",
  hourLocal: 17,
};

describe("localParts", () => {
  it("reads British Summer Time as +1 (July)", () => {
    // 16:00 UTC in July is 17:00 in London.
    const p = localParts(new Date("2026-07-31T16:00:00Z"), "Europe/London");
    expect(p).toEqual({ date: "2026-07-31", weekday: "Fri", hour: 17 });
  });

  it("reads GMT as +0 (January)", () => {
    const p = localParts(new Date("2026-01-30T17:00:00Z"), "Europe/London");
    expect(p).toEqual({ date: "2026-01-30", weekday: "Fri", hour: 17 });
  });

  it("normalises midnight to hour 0, not 24", () => {
    expect(localParts(new Date("2026-07-31T23:00:00Z"), "Europe/London").hour).toBe(0);
  });
});

describe("isReportDue", () => {
  it("fires at 5pm local on the chosen day — in summer", () => {
    expect(isReportDue(new Date("2026-07-31T16:00:00Z"), base)).toBe(true);
  });

  it("fires at 5pm local on the chosen day — in winter", () => {
    expect(isReportDue(new Date("2026-01-30T17:00:00Z"), base)).toBe(true);
  });

  it("does NOT fire an hour early in summer (the stored-UTC-hour bug)", () => {
    // 16:00 London = 15:00 UTC in July. A naive `hourUtc: 16` would fire here.
    expect(isReportDue(new Date("2026-07-31T15:00:00Z"), base)).toBe(false);
  });

  it("does not fire before the hour", () => {
    expect(isReportDue(new Date("2026-07-31T10:00:00Z"), base)).toBe(false);
  });

  it("does not fire on the wrong day", () => {
    expect(isReportDue(new Date("2026-07-30T16:00:00Z"), base)).toBe(false);
  });

  it("still fires late if the box was down at 5pm", () => {
    expect(isReportDue(new Date("2026-07-31T20:00:00Z"), base)).toBe(true);
  });

  it("only sends once per local day", () => {
    const sent = { ...base, lastRunLocalDate: "2026-07-31" };
    expect(isReportDue(new Date("2026-07-31T16:00:00Z"), sent)).toBe(false);
    expect(isReportDue(new Date("2026-07-31T21:00:00Z"), sent)).toBe(false);
  });

  it("fires again the following week", () => {
    const sent = { ...base, lastRunLocalDate: "2026-07-31" };
    expect(isReportDue(new Date("2026-08-07T16:00:00Z"), sent)).toBe(true);
  });

  it("stays silent when disabled or unaddressed", () => {
    const at = new Date("2026-07-31T16:00:00Z");
    expect(isReportDue(at, { ...base, enabled: false })).toBe(false);
    expect(isReportDue(at, { ...base, email: "" })).toBe(false);
  });

  it("honours a different zone", () => {
    const ny = { ...base, timeZone: "America/New_York" };
    // 17:00 in New York is 21:00 UTC in summer.
    expect(isReportDue(new Date("2026-07-31T21:00:00Z"), ny)).toBe(true);
    expect(isReportDue(new Date("2026-07-31T16:00:00Z"), ny)).toBe(false);
  });
});
