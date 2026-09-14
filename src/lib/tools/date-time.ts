import type { ToolDef } from "@/lib/providers/types";

/**
 * Date & time tools. Unlike the reference implementation (which did breakdown
 * arithmetic with host-zone Date accessors — a documented gotcha), all
 * calendar math here happens on the wall-clock parts of the REQUESTED IANA
 * timezone via Intl, so "years/months/days between" is correct across zones
 * and DST boundaries. Pure module — no server-only imports — so it's unit
 * testable.
 */

export const DEFAULT_TIMEZONE = "Europe/London";

export const DATE_TIME_NOW_DEF: ToolDef = {
  name: "date_time_now",
  description:
    "Get the current date and time in a given IANA timezone (default Europe/London). Use whenever 'now', 'today', or the current time matters.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: 'IANA timezone, e.g. "Europe/London", "America/New_York".',
      },
    },
  },
};

export const DATE_TIME_DIFF_DEF: ToolDef = {
  name: "date_time_diff",
  description:
    "Compute the exact difference between two dates/times: a calendar breakdown (years, months, days, hours, minutes, seconds) plus totals in each unit. Accepts ISO 8601 or natural dates like '3rd April 2019'.",
  parameters: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: 'Start date/time (ISO 8601, natural, or "now"). Omit for the current moment.',
      },
      to: { type: "string", description: 'End date/time (ISO 8601, natural, or "now").' },
      timezone: {
        type: "string",
        description: "IANA timezone the breakdown is computed in (default Europe/London).",
      },
    },
    required: ["to"],
  },
};

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of an instant in a timezone. */
export function wallClockIn(date: Date, timeZone: string): WallClock {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU versions render midnight as "24".
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zoneNames(date: Date, timeZone: string): { short: string; long: string; offset: string } {
  const get = (opt: "short" | "long" | "longOffset") =>
    new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: opt })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return { short: get("short"), long: get("long"), offset: get("longOffset") };
}

function fmt2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoLocal(w: WallClock): string {
  return `${w.year}-${fmt2(w.month)}-${fmt2(w.day)}T${fmt2(w.hour)}:${fmt2(w.minute)}:${fmt2(w.second)}`;
}

function humanDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** Parse ISO 8601 or natural dates ("3rd April 2019"); null if unparseable.
 *  "now"/"today"/"" resolve to the current instant — models naturally pass
 *  "now" for "days until X" asks (seen live: the reference parse rejected it,
 *  costing an error + recovery round). */
export function parseFlexibleDate(input: string): Date | null {
  const trimmed = input.trim();
  if (!trimmed || /^(now|today|current( date| time)?)$/i.test(trimmed)) return new Date();
  const cleaned = trimmed.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysInMonth(year: number, month: number): number {
  // month 1-12; day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface DiffBreakdown {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Treat a wall clock as an instant in a fixed calendar (for day/time math). */
function pseudoUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Advance a wall clock by n months, clamping the day (Jan 31 +1mo → Feb 28). */
function addMonthsClamped(w: WallClock, n: number): WallClock {
  const zeroBased = w.month - 1 + n;
  const year = w.year + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return { ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) };
}

/**
 * Calendar breakdown between two instants, computed on the target timezone's
 * wall clock. Uses clamped month-anchoring (the human convention: "Jan 31 +
 * 1 month = Feb 28", so Jan 31 → Mar 1 is 1 month 1 day) — naive per-unit
 * borrowing fails when the deficit exceeds the previous month's length.
 * `from` must be <= `to`.
 */
export function calendarBreakdown(from: Date, to: Date, timeZone: string): DiffBreakdown {
  const a = wallClockIn(from, timeZone);
  const b = wallClockIn(to, timeZone);

  // Largest month count whose clamped anchor doesn't overshoot `b`.
  let totalMonths = (b.year - a.year) * 12 + (b.month - a.month);
  let anchor = addMonthsClamped(a, totalMonths);
  if (pseudoUtcMs(anchor) > pseudoUtcMs(b)) {
    totalMonths--;
    anchor = addMonthsClamped(a, totalMonths);
  }

  // Day + time remainder is pure fixed-calendar arithmetic from the anchor.
  let rem = Math.floor((pseudoUtcMs(b) - pseudoUtcMs(anchor)) / 1000);
  const days = Math.floor(rem / 86_400);
  rem -= days * 86_400;
  const hours = Math.floor(rem / 3_600);
  rem -= hours * 3_600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem - minutes * 60;

  return {
    years: Math.floor(totalMonths / 12),
    months: totalMonths % 12,
    days,
    hours,
    minutes,
    seconds,
  };
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export async function executeDateTimeNow(
  args: Record<string, unknown>,
): Promise<string> {
  const tz = typeof args.timezone === "string" && args.timezone.trim()
    ? args.timezone.trim()
    : DEFAULT_TIMEZONE;
  if (!isValidTimezone(tz)) {
    return `Error: "${tz}" is not a valid IANA timezone (try "Europe/London" or "America/New_York").`;
  }
  const now = new Date();
  const w = wallClockIn(now, tz);
  const names = zoneNames(now, tz);
  return [
    `Current date and time in ${tz}:`,
    `- ${humanDate(now, tz)}`,
    `- ISO local: ${isoLocal(w)} (${names.offset})`,
    `- Timezone: ${names.short} — ${names.long}`,
    `- UTC: ${now.toISOString()}`,
    `- Unix timestamp: ${Math.floor(now.getTime() / 1000)}`,
  ].join("\n");
}

export async function executeDateTimeDiff(
  args: Record<string, unknown>,
): Promise<string> {
  const tz = typeof args.timezone === "string" && args.timezone.trim()
    ? args.timezone.trim()
    : DEFAULT_TIMEZONE;
  if (!isValidTimezone(tz)) {
    return `Error: "${tz}" is not a valid IANA timezone.`;
  }
  const fromRaw = String(args.from ?? "");
  const toRaw = String(args.to ?? "");
  const from = parseFlexibleDate(fromRaw);
  const to = parseFlexibleDate(toRaw);
  if (!from) return `Error: could not parse "from" date: "${fromRaw}".`;
  if (!to) return `Error: could not parse "to" date: "${toRaw}".`;

  const direction = to.getTime() >= from.getTime() ? "after" : "before";
  const [early, late] =
    to.getTime() >= from.getTime() ? [from, to] : [to, from];
  const bd = calendarBreakdown(early, late, tz);

  const totalMs = late.getTime() - early.getTime();
  const totalSeconds = Math.floor(totalMs / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const weeks = Math.floor(totalDays / 7);
  const remDays = totalDays % 7;

  return [
    `From: ${humanDate(from, tz)} (${tz})`,
    `To:   ${humanDate(to, tz)} (${tz})`,
    `"to" is ${direction} "from".`,
    ``,
    `Breakdown: ${bd.years} years, ${bd.months} months, ${bd.days} days, ` +
      `${bd.hours} hours, ${bd.minutes} minutes, ${bd.seconds} seconds`,
    `Totals: ${totalSeconds.toLocaleString("en-GB")} seconds · ` +
      `${totalMinutes.toLocaleString("en-GB")} minutes · ` +
      `${totalHours.toLocaleString("en-GB")} hours · ` +
      `${totalDays.toLocaleString("en-GB")} days · ` +
      `${weeks.toLocaleString("en-GB")} weeks and ${remDays} days`,
  ].join("\n");
}
