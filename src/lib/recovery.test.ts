import { beforeEach, describe, expect, it } from "vitest";
import {
  RECOVERY_AFTER_FAILURES,
  RECOVERY_COOLDOWN_MS,
  claimRecoverySend,
  resetRecoveryThrottle,
  shouldIssueRecoveryPassword,
} from "./recovery";

/**
 * Issuing a temporary password REPLACES the account's current one. Every test
 * here is really the same question asked from a different side: could this
 * ever fire for somebody who was using the password they have?
 */
const base = {
  failures: RECOVERY_AFTER_FAILURES,
  exists: true,
  disabled: false,
  verified: true,
  lastSignInAt: null as Date | string | null,
};

describe("shouldIssueRecoveryPassword", () => {
  it("fires for an account that has never been signed in to", () => {
    expect(shouldIssueRecoveryPassword(base)).toBe(true);
  });

  it("NEVER fires for someone who has signed in before — the load-bearing rule", () => {
    // Verified against production before shipping: every one of the ~20 people
    // who failed a sign-in in a fortnight had signed in successfully within
    // days, so every one of them is this case. Taking their password away
    // would turn a typo into a lockout.
    expect(shouldIssueRecoveryPassword({ ...base, lastSignInAt: new Date() })).toBe(false);
    expect(
      shouldIssueRecoveryPassword({ ...base, lastSignInAt: "2025-01-01T00:00:00.000Z" }),
    ).toBe(false);
  });

  it("waits for a run of failures, not a single typo", () => {
    for (let n = 0; n < RECOVERY_AFTER_FAILURES; n++) {
      expect(shouldIssueRecoveryPassword({ ...base, failures: n })).toBe(false);
    }
    expect(shouldIssueRecoveryPassword({ ...base, failures: RECOVERY_AFTER_FAILURES })).toBe(true);
  });

  it("says nothing about an address with no account", () => {
    // Otherwise the login screen becomes a way to test which addresses exist.
    expect(shouldIssueRecoveryPassword({ ...base, exists: false })).toBe(false);
  });

  it("refuses a disabled account — a leaver must not be handed a way in", () => {
    expect(shouldIssueRecoveryPassword({ ...base, disabled: true })).toBe(false);
  });

  it("refuses an unverified account, which could not sign in anyway", () => {
    expect(shouldIssueRecoveryPassword({ ...base, verified: false })).toBe(false);
  });
});

describe("the send throttle", () => {
  beforeEach(() => resetRecoveryThrottle());

  it("allows one, then refuses until the cooldown passes", () => {
    const t = 1_000_000;
    expect(claimRecoverySend("a@x.com", t)).toBe(true);
    expect(claimRecoverySend("a@x.com", t + 1)).toBe(false);
    expect(claimRecoverySend("a@x.com", t + RECOVERY_COOLDOWN_MS - 1)).toBe(false);
    expect(claimRecoverySend("a@x.com", t + RECOVERY_COOLDOWN_MS)).toBe(true);
  });

  it("is per account, and case/whitespace cannot dodge it", () => {
    const t = 1_000_000;
    expect(claimRecoverySend("a@x.com", t)).toBe(true);
    expect(claimRecoverySend("  A@X.com ", t + 1)).toBe(false);
    expect(claimRecoverySend("b@x.com", t + 1)).toBe(true);
  });

  it("cannot be grown without bound by spraying addresses", () => {
    for (let i = 0; i < 5_200; i++) claimRecoverySend(`u${i}@x.com`, 1_000_000 + i);
    // The oldest are evicted rather than kept for ever; the newest survive.
    expect(claimRecoverySend("u5199@x.com", 1_000_000 + 5_200)).toBe(false);
  });
});
