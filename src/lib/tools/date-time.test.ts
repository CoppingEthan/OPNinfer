import { describe, expect, it } from "vitest";
import {
  calendarBreakdown,
  executeDateTimeDiff,
  executeDateTimeNow,
  isValidTimezone,
  parseFlexibleDate,
  wallClockIn,
} from "./date-time";

describe("timezone validation", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("BST+1")).toBe(false);
  });
});

describe("parseFlexibleDate", () => {
  it("parses ISO 8601", () => {
    expect(parseFlexibleDate("2024-02-29T12:00:00Z")?.toISOString()).toBe(
      "2024-02-29T12:00:00.000Z",
    );
  });
  it("strips ordinal suffixes from natural dates", () => {
    const d = parseFlexibleDate("3rd April 2019");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2019);
    expect(d!.getMonth()).toBe(3); // April
    expect(d!.getDate()).toBe(3);
  });
  it("returns null for garbage", () => {
    expect(parseFlexibleDate("the day after tomorrow-ish")).toBeNull();
  });
  it('resolves "now"/"today"/empty to the current instant (seen live: models pass from:"now")', () => {
    for (const word of ["now", "NOW", "today", "current time", ""]) {
      const d = parseFlexibleDate(word);
      expect(d).not.toBeNull();
      expect(Math.abs(d!.getTime() - Date.now())).toBeLessThan(2_000);
    }
  });
});

describe("wallClockIn", () => {
  it("reads the wall clock of the requested zone, not the host zone", () => {
    // 2026-01-15T12:00Z: New York is UTC-5 in January → 07:00 local.
    const instant = new Date("2026-01-15T12:00:00Z");
    const ny = wallClockIn(instant, "America/New_York");
    expect(ny.hour).toBe(7);
    expect(ny.day).toBe(15);
    const tokyo = wallClockIn(instant, "Asia/Tokyo"); // UTC+9 → 21:00
    expect(tokyo.hour).toBe(21);
  });
});

describe("calendarBreakdown", () => {
  it("computes simple whole-unit differences", () => {
    const bd = calendarBreakdown(
      new Date("2020-01-01T00:00:00Z"),
      new Date("2023-03-11T00:00:00Z"),
      "UTC",
    );
    expect(bd).toEqual({ years: 3, months: 2, days: 10, hours: 0, minutes: 0, seconds: 0 });
  });

  it("borrows correctly across month lengths", () => {
    // 31 Jan → 1 Mar 2023 (Feb has 28 days): 1 month, 1 day.
    const bd = calendarBreakdown(
      new Date("2023-01-31T00:00:00Z"),
      new Date("2023-03-01T00:00:00Z"),
      "UTC",
    );
    expect(bd).toEqual({ years: 0, months: 1, days: 1, hours: 0, minutes: 0, seconds: 0 });
  });

  it("is correct across a DST boundary in the target zone", () => {
    // Europe/London springs forward 2026-03-29 01:00 → 02:00.
    // 2026-03-29T00:30Z is 00:30 local (GMT); 2026-03-29T02:30Z is 03:30
    // local (BST). Local wall-clock difference is 3h even though only 2h of
    // real time elapsed — a host-zone implementation gets this wrong.
    const bd = calendarBreakdown(
      new Date("2026-03-29T00:30:00Z"),
      new Date("2026-03-29T02:30:00Z"),
      "Europe/London",
    );
    expect(bd.hours).toBe(3);
    expect(bd.days).toBe(0);
  });

  it("uses the requested zone's calendar date, not the host's", () => {
    // Same two instants straddle midnight in Tokyo but not in UTC.
    const bd = calendarBreakdown(
      new Date("2026-06-10T14:00:00Z"), // Tokyo: 23:00 on the 10th
      new Date("2026-06-10T16:00:00Z"), // Tokyo: 01:00 on the 11th
      "Asia/Tokyo",
    );
    expect(bd).toEqual({ years: 0, months: 0, days: 0, hours: 2, minutes: 0, seconds: 0 });
  });
});

describe("executors", () => {
  it("date_time_now reports the requested zone", async () => {
    const out = await executeDateTimeNow({ timezone: "Asia/Tokyo" });
    expect(out).toContain("Asia/Tokyo");
    expect(out).toContain("Unix timestamp:");
  });
  it("date_time_now rejects invalid zones with a friendly error", async () => {
    const out = await executeDateTimeNow({ timezone: "Narnia/Lamppost" });
    expect(out).toMatch(/^Error: .*not a valid IANA timezone/);
  });
  it("date_time_diff handles natural dates and direction", async () => {
    const out = await executeDateTimeDiff({
      from: "21st June 2023",
      to: "3rd April 2019",
      timezone: "UTC",
    });
    expect(out).toContain('"to" is before "from"');
    expect(out).toContain("4 years, 2 months, 18 days");
  });
  it("date_time_diff surfaces parse failures", async () => {
    const out = await executeDateTimeDiff({ from: "banana", to: "2024-01-01" });
    expect(out).toMatch(/^Error: could not parse "from"/);
  });
});
