import { describe, expect, it } from "vitest";
import {
  formatResetIn,
  isStale,
  mergeLimitSnapshot,
  parseLimitState,
  parseRateLimitInfo,
  visibleLimits,
  type AgentLimitState,
  parsePlanUsage,
  planAlerts,
  planUsageAge,
  type AgentLimitSnapshot,
} from "./limits";

const NOW = 1_800_000_000_000; // fixed clock

describe("parseRateLimitInfo", () => {
  it("reads a five-hour session window", () => {
    const s = parseRateLimitInfo(
      { status: "allowed", rateLimitType: "five_hour", utilization: 42, resetsAt: NOW + 3_600_000 },
      NOW,
    );
    expect(s).toEqual({
      window: "five_hour",
      status: "allowed",
      percentUsed: 42,
      resetsAt: NOW + 3_600_000,
      observedAt: NOW,
    });
  });

  it("treats utilization <= 1 as a fraction, > 1 as a percentage", () => {
    expect(parseRateLimitInfo({ rateLimitType: "seven_day", utilization: 0.37 }, NOW)?.percentUsed).toBe(37);
    expect(parseRateLimitInfo({ rateLimitType: "seven_day", utilization: 37 }, NOW)?.percentUsed).toBe(37);
    // The ambiguous end: 1 reads as 100%, erring toward "near the limit".
    expect(parseRateLimitInfo({ rateLimitType: "seven_day", utilization: 1 }, NOW)?.percentUsed).toBe(100);
  });

  it("clamps out-of-range utilisation and rounds to 0.1", () => {
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 140 }, NOW)?.percentUsed).toBe(100);
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", utilization: -5 }, NOW)?.percentUsed).toBe(0);
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 12.34 }, NOW)?.percentUsed).toBe(12.3);
  });

  it("accepts resetsAt in seconds or milliseconds", () => {
    const secs = Math.floor((NOW + 7_200_000) / 1000);
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", resetsAt: secs }, NOW)?.resetsAt).toBe(secs * 1000);
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", resetsAt: NOW + 7_200_000 }, NOW)?.resetsAt).toBe(
      NOW + 7_200_000,
    );
  });

  it("drops unknown windows and unusable payloads rather than guessing", () => {
    expect(parseRateLimitInfo({ rateLimitType: "some_future_plan", utilization: 10 }, NOW)).toBeNull();
    expect(parseRateLimitInfo({ utilization: 10 }, NOW)).toBeNull();
    expect(parseRateLimitInfo(null, NOW)).toBeNull();
    expect(parseRateLimitInfo("nope", NOW)).toBeNull();
  });

  it("defaults an unrecognised status to allowed, and keeps rejected", () => {
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", status: "weird" }, NOW)?.status).toBe("allowed");
    expect(parseRateLimitInfo({ rateLimitType: "five_hour", status: "rejected" }, NOW)?.status).toBe("rejected");
  });

  it("omits fields the provider didn't send", () => {
    const s = parseRateLimitInfo({ rateLimitType: "seven_day" }, NOW)!;
    expect(s.percentUsed).toBeUndefined();
    expect(s.resetsAt).toBeUndefined();
  });
});

describe("mergeLimitSnapshot", () => {
  it("newest observation wins per window", () => {
    let st: AgentLimitState = {};
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 10 }, NOW)!);
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 55 }, NOW + 1000)!);
    expect(st.five_hour?.percentUsed).toBe(55);
  });

  it("an OLDER observation never overwrites a newer one (runs overlap)", () => {
    let st: AgentLimitState = {};
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 55 }, NOW + 1000)!);
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 10 }, NOW)!);
    expect(st.five_hour?.percentUsed).toBe(55);
  });

  it("windows are tracked independently", () => {
    let st: AgentLimitState = {};
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 10 }, NOW)!);
    st = mergeLimitSnapshot(st, parseRateLimitInfo({ rateLimitType: "seven_day", utilization: 80 }, NOW)!);
    expect(st.five_hour?.percentUsed).toBe(10);
    expect(st.seven_day?.percentUsed).toBe(80);
  });
});

describe("parseLimitState", () => {
  it("round-trips a stored state", () => {
    const st = mergeLimitSnapshot({}, parseRateLimitInfo({ rateLimitType: "five_hour", utilization: 20 }, NOW)!);
    expect(parseLimitState(JSON.parse(JSON.stringify(st)))).toEqual(st);
  });

  it("survives garbage without throwing (an admin page must still render)", () => {
    expect(parseLimitState(null)).toEqual({});
    expect(parseLimitState("nope")).toEqual({});
    expect(parseLimitState({ five_hour: "not an object" })).toEqual({});
    expect(parseLimitState({ bogus_window: { observedAt: NOW } })).toEqual({});
    expect(parseLimitState({ five_hour: { percentUsed: 5 } })).toEqual({}); // no observedAt
  });
});

describe("staleness and formatting", () => {
  it("a window past its reset is stale (its percentage would overstate usage)", () => {
    const fresh = { window: "five_hour", status: "allowed", observedAt: NOW, resetsAt: NOW + 60_000 } as const;
    const past = { window: "five_hour", status: "allowed", observedAt: NOW, resetsAt: NOW - 60_000 } as const;
    expect(isStale(fresh, NOW)).toBe(false);
    expect(isStale(past, NOW)).toBe(true);
    // No reset time = can't tell it's expired, so keep showing it.
    expect(isStale({ window: "seven_day", status: "allowed", observedAt: NOW }, NOW)).toBe(false);
  });

  it("visibleLimits orders session first and hides stale windows", () => {
    const state: AgentLimitState = {
      seven_day: { window: "seven_day", status: "allowed", observedAt: NOW, percentUsed: 30 },
      five_hour: { window: "five_hour", status: "allowed", observedAt: NOW, percentUsed: 10 },
      overage: { window: "overage", status: "allowed", observedAt: NOW, resetsAt: NOW - 1 },
    };
    expect(visibleLimits(state, NOW).map((s) => s.window)).toEqual(["five_hour", "seven_day"]);
  });

  it("formatResetIn reads naturally at each scale", () => {
    expect(formatResetIn(undefined, NOW)).toBe("");
    expect(formatResetIn(NOW - 1, NOW)).toBe("resetting");
    expect(formatResetIn(NOW + 25 * 60_000, NOW)).toBe("in 25m");
    expect(formatResetIn(NOW + 2 * 3_600_000 + 15 * 60_000, NOW)).toBe("in 2h 15m");
    expect(formatResetIn(NOW + 3 * 3_600_000, NOW)).toBe("in 3h");
    expect(formatResetIn(NOW + 3 * 86_400_000, NOW)).toBe("in 3 days");
    expect(formatResetIn(NOW + 86_400_000, NOW)).toBe("in 1 day");
  });
});

describe("parsePlanUsage — the plan's own usage screen (SDK /usage data)", () => {
  const now = 1_788_382_000_000;
  it("reads every window with its 0–100 percentage and ISO reset", () => {
    const snaps = parsePlanUsage(
      {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: "2026-09-02T21:00:00Z" },
          seven_day: { utilization: 3.25, resets_at: "2026-09-08T00:00:00Z" },
          seven_day_sonnet: { utilization: 0, resets_at: null },
          seven_day_opus: null,
        },
      },
      now,
    );
    expect(snaps.map((s) => `${s.window}:${s.percentUsed}`)).toEqual(["five_hour:10", "seven_day:3.3", "seven_day_sonnet:0"]);
    expect(snaps[0].resetsAt).toBe(Date.parse("2026-09-02T21:00:00Z"));
    expect(snaps[2].resetsAt).toBeUndefined();
    expect(snaps.every((s) => s.observedAt === now && s.status === "allowed")).toBe(true);
  });
  it("derives warning/refusing status from the percentage", () => {
    const snaps = parsePlanUsage({ rate_limits: { five_hour: { utilization: 95, resets_at: null }, seven_day: { utilization: 100, resets_at: null } } }, now);
    expect(snaps.map((s) => s.status)).toEqual(["allowed_warning", "rejected"]);
  });
  it("null/absent rate_limits (API key, Bedrock…) and junk yield nothing", () => {
    expect(parsePlanUsage({ rate_limits_available: false, rate_limits: null }, now)).toEqual([]);
    expect(parsePlanUsage(null, now)).toEqual([]);
    expect(parsePlanUsage("nope", now)).toEqual([]);
    expect(parsePlanUsage({ rate_limits: { five_hour: { utilization: "lots" } } }, now)[0].percentUsed).toBeUndefined();
  });
  it("a usage snapshot supersedes an older event-based one for the same window", () => {
    const older = { five_hour: { window: "five_hour" as const, status: "allowed" as const, observedAt: now - 60_000 } };
    const [snap] = parsePlanUsage({ rate_limits: { five_hour: { utilization: 10, resets_at: null } } }, now);
    const merged = mergeLimitSnapshot(older, snap);
    expect(merged.five_hour?.percentUsed).toBe(10);
  });
});

describe("planAlerts — one email per window at 90%, one when the plan refuses", () => {
  const now = 1_788_382_000_000;
  const snap = (pct: number, extra: Partial<AgentLimitSnapshot> = {}): AgentLimitSnapshot => ({
    window: "five_hour", status: pct >= 100 ? "rejected" : pct >= 90 ? "allowed_warning" : "allowed", percentUsed: pct, resetsAt: now + 3_600_000, observedAt: now, ...extra,
  });
  it("warns once crossing 90, then not again on the same window", () => {
    const first = planAlerts({ five_hour: snap(91) }, now);
    expect(first.alerts.map((a) => a.kind)).toEqual(["warn"]);
    const again = planAlerts(mergeLimitSnapshot(first.state, snap(94, { observedAt: now + 1 })), now + 1);
    expect(again.alerts).toEqual([]);
  });
  it("raises 'limit' when the plan refuses, once; a warn already raised does not block it", () => {
    const warned = planAlerts({ five_hour: snap(92) }, now).state;
    const hit = planAlerts(mergeLimitSnapshot(warned, snap(100, { observedAt: now + 1 })), now + 1);
    expect(hit.alerts.map((a) => a.kind)).toEqual(["limit"]);
    const hitAgain = planAlerts(mergeLimitSnapshot(hit.state, snap(100, { observedAt: now + 2 })), now + 2);
    expect(hitAgain.alerts).toEqual([]);
  });
  it("status rejected alerts even without a percentage", () => {
    const r = planAlerts({ seven_day: { window: "seven_day", status: "rejected", observedAt: now } }, now);
    expect(r.alerts).toEqual([{ window: "seven_day", kind: "limit" }]);
  });
  it("a new window (different reset time) alerts afresh; a stale window says nothing", () => {
    const warned = planAlerts({ five_hour: snap(95) }, now).state;
    const rolled = mergeLimitSnapshot(warned, snap(91, { observedAt: now + 5, resetsAt: now + 9_000_000 }));
    expect(rolled.five_hour?.alerted).toBeUndefined();
    expect(planAlerts(rolled, now + 5).alerts.map((a) => a.kind)).toEqual(["warn"]);
    expect(planAlerts({ five_hour: snap(99, { resetsAt: now - 1 }) }, now).alerts).toEqual([]);
  });
  it("below 85% the warn flag clears so the next climb alerts again", () => {
    const warned = planAlerts({ five_hour: snap(92) }, now).state;
    const dropped = planAlerts(mergeLimitSnapshot(warned, snap(40, { observedAt: now + 1 })), now + 1).state;
    expect(dropped.five_hour?.alerted).toBeUndefined();
  });
  it("flags survive a round trip through parseLimitState", () => {
    const st = planAlerts({ five_hour: snap(92) }, now).state;
    expect(parseLimitState(JSON.parse(JSON.stringify(st))).five_hour?.alerted?.warn).toBe(now);
  });
});

/**
 * How stale the plan's own usage reading is — what decides whether to spend
 * a container asking for a fresh one (2026-09-07). The distinction it rests
 * on: a `rate_limit_event` reports status and reset time but usually carries
 * NO percentage, while the usage screen gives a real number for every
 * window — and it is the number the panel and the 90% alert email need.
 */
describe("planUsageAge", () => {
  const snap = (over: Partial<AgentLimitSnapshot>): AgentLimitSnapshot => ({
    window: "five_hour",
    status: "allowed",
    observedAt: NOW,
    ...over,
  });

  it("is null when nothing has ever been read", () => {
    expect(planUsageAge({}, NOW)).toBeNull();
  });

  it("ignores event-only readings — they carry no percentage", () => {
    // THE CASE THIS EXISTS FOR: on a long-lived token every run records one
    // of these, so treating it as a reading would mean the panel looked
    // freshly updated for ever while never showing a number.
    const state: AgentLimitState = {
      five_hour: snap({ observedAt: NOW - 1_000 }),
      seven_day: snap({ window: "seven_day", observedAt: NOW - 2_000 }),
    };
    expect(planUsageAge(state, NOW)).toBeNull();
  });

  it("measures from the NEWEST screen reading", () => {
    const state: AgentLimitState = {
      five_hour: snap({ observedAt: NOW - 60_000, percentUsed: 22 }),
      seven_day: snap({ window: "seven_day", observedAt: NOW - 600_000, percentUsed: 15 }),
      // An event-only reading, newer than both, must not count as fresh.
      seven_day_opus: snap({ window: "seven_day_opus", observedAt: NOW }),
    };
    expect(planUsageAge(state, NOW)).toBe(60_000);
  });

  it("never reports a negative age from a clock skew", () => {
    const state: AgentLimitState = { five_hour: snap({ observedAt: NOW + 5_000, percentUsed: 40 }) };
    expect(planUsageAge(state, NOW)).toBe(0);
  });
});
