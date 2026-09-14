import { describe, expect, it } from "vitest";
import { askedAgo, classifyReset } from "./reset-watch";

const NOW = Date.parse("2026-09-09T15:00:00.000Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3_600_000;

describe("classifyReset", () => {
  it("says nothing when there is no outstanding request", () => {
    expect(classifyReset({ pending: null, passwordChangedAt: null }, NOW)).toBe("none");
  });

  it("a live link is WAITING, not stuck — people do not read email within the hour", () => {
    expect(
      classifyReset(
        { pending: { requestedAt: iso(-10 * 60_000), expiresAt: iso(50 * 60_000) }, passwordChangedAt: null },
        NOW,
      ),
    ).toBe("waiting");
  });

  it("an EXPIRED unused link is the evidence we are after", () => {
    // They asked, we sent it, the hour ran out and they never clicked.
    expect(
      classifyReset(
        { pending: { requestedAt: iso(-3 * HOUR), expiresAt: iso(-2 * HOUR) }, passwordChangedAt: null },
        NOW,
      ),
    ).toBe("stuck");
  });

  it("is 'stuck' the instant the link expires, not a moment before", () => {
    const pending = { requestedAt: iso(-HOUR), expiresAt: iso(0) };
    expect(classifyReset({ pending, passwordChangedAt: null }, NOW - 1)).toBe("waiting");
    expect(classifyReset({ pending, passwordChangedAt: null }, NOW)).toBe("stuck");
  });

  it("clears once they got in ANOTHER way — an admin set them a password", () => {
    // The row stays unused for ever in that case, so without this the page
    // would keep naming someone who was sorted out days ago.
    expect(
      classifyReset(
        {
          pending: { requestedAt: iso(-3 * HOUR), expiresAt: iso(-2 * HOUR) },
          passwordChangedAt: iso(-HOUR),
        },
        NOW,
      ),
    ).toBe("none");
  });

  it("a password change BEFORE the ask does not clear it", () => {
    // They got in months ago, forgot it since, and asked again — still stuck.
    expect(
      classifyReset(
        {
          pending: { requestedAt: iso(-3 * HOUR), expiresAt: iso(-2 * HOUR) },
          passwordChangedAt: iso(-90 * 24 * HOUR),
        },
        NOW,
      ),
    ).toBe("stuck");
  });

  it("treats unparseable dates as nothing to report, never as an alarm", () => {
    expect(
      classifyReset({ pending: { requestedAt: "not a date", expiresAt: "x" }, passwordChangedAt: null }, NOW),
    ).toBe("none");
  });
});

describe("askedAgo", () => {
  it("measures from the request", () => {
    expect(askedAgo(iso(-2 * HOUR), NOW)).toBe(2 * HOUR);
  });
  it("never goes negative on a clock skew, and shrugs at rubbish", () => {
    expect(askedAgo(iso(5_000), NOW)).toBe(0);
    expect(askedAgo("nonsense", NOW)).toBe(0);
  });
});
