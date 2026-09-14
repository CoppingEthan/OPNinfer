import { beforeEach, describe, expect, it } from "vitest";
import { beginDrain, endDrain, isDraining, drainingSince, drainResponse, DRAIN_MESSAGE } from "./drain";

describe("deploy drain", () => {
  beforeEach(() => endDrain());

  it("starts clear", () => {
    expect(isDraining()).toBe(false);
    expect(drainingSince()).toBeNull();
  });

  it("begins and ends", () => {
    beginDrain();
    expect(isDraining()).toBe(true);
    expect(typeof drainingSince()).toBe("number");
    endDrain();
    expect(isDraining()).toBe(false);
  });

  it("keeps the ORIGINAL start time when begun twice", () => {
    beginDrain();
    const first = drainingSince();
    beginDrain();
    expect(drainingSince()).toBe(first);
  });

  it("refuses with 503 + maintenance, not a generic error", async () => {
    const res = drainResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("120");
    const body = (await res.json()) as { error: string; maintenance: boolean };
    // The client keys off `maintenance` to show the calm amber notice rather
    // than a red failure — if this flag ever goes, that UX silently reverts.
    expect(body.maintenance).toBe(true);
    expect(body.error).toBe(DRAIN_MESSAGE);
  });

  it("tells the user when to come back, and doesn't read as a fault", () => {
    expect(DRAIN_MESSAGE).toMatch(/updating/i);
    expect(DRAIN_MESSAGE).toMatch(/try again/i);
    expect(DRAIN_MESSAGE).not.toMatch(/error|failed|sorry/i);
  });
});
