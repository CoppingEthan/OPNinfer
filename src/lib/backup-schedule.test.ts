import { describe, expect, it } from "vitest";
import {
  isBackupDue,
  utcDateKey,
  utcWeekKey,
  type BackupConfig,
} from "./backup";

/**
 * When a scheduled backup runs.
 *
 * The old rule was "at or after the configured hour, and at least 20 hours
 * since the last run". That is not "daily at 03:00": enable it at 10:00 and it
 * fires at 10:00, then 06:00, then 03:00 — and again at 23:00 the same day,
 * because 20 hours had elapsed and the hour floor was met. It walked backwards
 * through the day on a six-day loop, ran in the middle of the working day, and
 * left "keep the last 7" covering about six days. `isReportDue` (weekly email)
 * was already anchored on the calendar; this now matches it.
 */

const base: BackupConfig = {
  enabled: true,
  frequency: "daily",
  hourUtc: 3,
  retention: 7,
  lastRunAt: null,
  lastRunDate: null,
  lastRunWeek: null,
};

const at = (iso: string) => new Date(iso);

describe("isBackupDue — daily", () => {
  it("is not due before the configured hour", () => {
    expect(isBackupDue(base, at("2026-08-22T02:59:00Z"))).toBe(false);
  });

  it("is due at the hour when it has never run", () => {
    expect(isBackupDue(base, at("2026-08-22T03:00:00Z"))).toBe(true);
  });

  it("is not due again later the same day", () => {
    const cfg = { ...base, lastRunDate: "2026-08-22" };
    expect(isBackupDue(cfg, at("2026-08-22T23:00:00Z"))).toBe(false);
    // …which is exactly the second run the 20-hour rule used to allow.
  });

  it("is due again the next day, at the same hour", () => {
    const cfg = { ...base, lastRunDate: "2026-08-22" };
    expect(isBackupDue(cfg, at("2026-08-23T02:59:00Z"))).toBe(false);
    expect(isBackupDue(cfg, at("2026-08-23T03:00:00Z"))).toBe(true);
  });

  it("does not drift earlier over a week", () => {
    // Run it every day for a week; each day's first due moment must be the
    // configured hour, never earlier.
    let cfg = { ...base, lastRunDate: "2026-08-22" };
    for (const day of ["23", "24", "25", "26", "27", "28"]) {
      expect(isBackupDue(cfg, at(`2026-08-${day}T02:59:00Z`))).toBe(false);
      expect(isBackupDue(cfg, at(`2026-08-${day}T03:00:00Z`))).toBe(true);
      cfg = { ...cfg, lastRunDate: `2026-08-${day}` };
    }
  });

  it("catches up if the instance was down at the configured hour", () => {
    // Missed 03:00 (container restarting) — still due later that day.
    const cfg = { ...base, lastRunDate: "2026-08-21" };
    expect(isBackupDue(cfg, at("2026-08-22T11:00:00Z"))).toBe(true);
  });

  it("is never due when disabled", () => {
    expect(isBackupDue({ ...base, enabled: false }, at("2026-08-22T03:00:00Z"))).toBe(false);
  });

  it("treats a config written before this existed as never-run", () => {
    // lastRunDate absent, lastRunAt set — an upgrade from the old scheme.
    const legacy = { ...base, lastRunAt: "2026-08-21T03:00:00.000Z" };
    delete (legacy as Partial<BackupConfig>).lastRunDate;
    expect(isBackupDue(legacy, at("2026-08-22T03:00:00Z"))).toBe(true);
  });
});

describe("isBackupDue — weekly", () => {
  const weekly: BackupConfig = { ...base, frequency: "weekly" };

  it("runs once in a week, not twice", () => {
    const cfg = { ...weekly, lastRunWeek: utcWeekKey(at("2026-08-22T03:00:00Z")) };
    expect(isBackupDue(cfg, at("2026-08-22T23:00:00Z"))).toBe(false);
    // Two days later, same ISO week (Sat 22nd → Sun 23rd is the same week).
    expect(isBackupDue(cfg, at("2026-08-23T03:00:00Z"))).toBe(false);
  });

  it("is due again in the following week", () => {
    const cfg = { ...weekly, lastRunWeek: utcWeekKey(at("2026-08-22T03:00:00Z")) };
    expect(isBackupDue(cfg, at("2026-08-25T03:00:00Z"))).toBe(true);
  });
});

describe("date and week keys", () => {
  it("formats a UTC date", () => {
    expect(utcDateKey(at("2026-08-22T23:30:00Z"))).toBe("2026-08-22");
  });

  it("gives consecutive days in one week the same week key", () => {
    // Mon 2026-08-17 … Sun 2026-08-23 is one ISO week.
    const keys = ["17", "18", "19", "20", "21", "22", "23"].map((d) =>
      utcWeekKey(at(`2026-08-${d}T12:00:00Z`)),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("rolls over on Monday", () => {
    expect(utcWeekKey(at("2026-08-23T12:00:00Z"))).not.toBe(
      utcWeekKey(at("2026-08-24T12:00:00Z")),
    );
  });
});
