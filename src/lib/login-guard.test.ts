import { beforeEach, describe, expect, it } from "vitest";
import {
  backoffMs,
  clearLoginFailures,
  FREE_ATTEMPTS,
  loginBlockedMs,
  loginKey,
  MAX_LOCKOUT_MS,
  recordLoginFailure,
  resetLoginGuard,
} from "./login-guard";

/**
 * Failed-sign-in throttling.
 *
 * There was none: the portals are on the public internet, and an attacker could
 * grind a known staff address against a password list for as long as they liked
 * — with no lockout, no backoff, and nothing written to any log, so nobody
 * would ever know it had happened.
 */

const KEY = "someone@example.test";
const t0 = 1_700_000_000_000; // a fixed instant; the guard takes `now`

beforeEach(() => resetLoginGuard());

describe("backoffMs", () => {
  it("does not punish ordinary fumbling", () => {
    for (let n = 1; n <= FREE_ATTEMPTS; n++) expect(backoffMs(n)).toBe(0);
  });

  it("escalates once the free attempts are used up", () => {
    const first = backoffMs(FREE_ATTEMPTS + 1);
    const second = backoffMs(FREE_ATTEMPTS + 2);
    const third = backoffMs(FREE_ATTEMPTS + 3);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("flattens at the ceiling, so a real user is never locked out for long", () => {
    expect(backoffMs(50)).toBe(MAX_LOCKOUT_MS);
    expect(backoffMs(5000)).toBe(MAX_LOCKOUT_MS);
  });

  it("makes a sustained grind uneconomic", () => {
    // 20 guesses can't be spent in a minute: after the free ones, the waits add
    // up to well over an hour.
    let total = 0;
    for (let n = 1; n <= 20; n++) total += backoffMs(n);
    expect(total).toBeGreaterThan(60 * 60_000);
  });
});

describe("the guard in use", () => {
  it("lets the first attempts through immediately", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordLoginFailure(KEY, t0);
    expect(loginBlockedMs(KEY, t0)).toBe(0);
  });

  it("starts blocking after that", () => {
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordLoginFailure(KEY, t0);
    expect(loginBlockedMs(KEY, t0)).toBeGreaterThan(0);
  });

  it("lets them try again once the wait has passed", () => {
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) recordLoginFailure(KEY, t0);
    const wait = loginBlockedMs(KEY, t0);
    expect(loginBlockedMs(KEY, t0 + wait + 1)).toBe(0);
  });

  it("keeps escalating for a persistent guesser rather than resetting", () => {
    let now = t0;
    let previous = 0;
    for (let i = 0; i < 8; i++) {
      const wait = recordLoginFailure(KEY, now);
      if (i > FREE_ATTEMPTS) expect(wait).toBeGreaterThanOrEqual(previous);
      previous = wait;
      now += wait + 1; // wait it out each time, like a script would
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("forgets a quiet account after an hour", () => {
    for (let i = 0; i < FREE_ATTEMPTS + 3; i++) recordLoginFailure(KEY, t0);
    // Someone comes back the next day and mistypes once.
    const wait = recordLoginFailure(KEY, t0 + 24 * 3600_000);
    expect(wait).toBe(0);
  });

  it("a successful sign-in clears the history", () => {
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) recordLoginFailure(KEY, t0);
    clearLoginFailures(KEY);
    expect(loginBlockedMs(KEY, t0)).toBe(0);
  });

  it("throttles per account, not globally", () => {
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) recordLoginFailure(KEY, t0);
    expect(loginBlockedMs("someone-else@example.test", t0)).toBe(0);
  });

  it("treats an address as one account however it is typed", () => {
    expect(loginKey("  Someone@Example.TEST ")).toBe(KEY);
    for (let i = 0; i < FREE_ATTEMPTS + 1; i++) {
      recordLoginFailure(loginKey("  Someone@Example.TEST "), t0);
    }
    expect(loginBlockedMs(KEY, t0)).toBeGreaterThan(0);
  });
});
