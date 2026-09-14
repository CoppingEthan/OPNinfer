import { describe, it, expect, beforeEach } from "vitest";
import { alertKey, shouldSend, resetAlertState } from "@/lib/alerts";

/**
 * The throttle is what stands between "the portal tells you it's broken" and
 * "the portal fills your inbox because it's broken". Pure functions, so they
 * can be tested without SMTP or a database.
 */

const T0 = 1_800_000_000_000; // fixed clock; the code never calls Date.now here
const MINUTE = 60_000;

describe("alertKey", () => {
  it("groups by area and message", () => {
    expect(alertKey({ category: "chat", message: "boom" })).toBe("chat:boom");
  });

  it("collapses errors that differ only in a long tail", () => {
    const a = alertKey({ category: "chat", message: `${"x".repeat(120)}-id-1` });
    const b = alertKey({ category: "chat", message: `${"x".repeat(120)}-id-2` });
    expect(a).toBe(b);
  });

  it("keeps genuinely different errors apart", () => {
    expect(alertKey({ category: "chat", message: "a" })).not.toBe(
      alertKey({ category: "files", message: "a" }),
    );
  });
});

describe("shouldSend", () => {
  beforeEach(() => resetAlertState());

  it("sends the first time an error is seen", () => {
    expect(shouldSend("chat:boom", T0, 15)).toEqual({ suppressed: 0 });
  });

  it("stays quiet for repeats inside the window", () => {
    shouldSend("chat:boom", T0, 15);
    expect(shouldSend("chat:boom", T0 + MINUTE, 15)).toBeNull();
    expect(shouldSend("chat:boom", T0 + 14 * MINUTE, 15)).toBeNull();
  });

  it("sends again once the window passes, reporting what was suppressed", () => {
    shouldSend("chat:boom", T0, 15);
    shouldSend("chat:boom", T0 + MINUTE, 15);
    shouldSend("chat:boom", T0 + 2 * MINUTE, 15);
    expect(shouldSend("chat:boom", T0 + 16 * MINUTE, 15)).toEqual({
      suppressed: 2,
    });
  });

  it("resets the suppressed count after reporting it", () => {
    shouldSend("chat:boom", T0, 15);
    shouldSend("chat:boom", T0 + MINUTE, 15);
    shouldSend("chat:boom", T0 + 16 * MINUTE, 15);
    expect(shouldSend("chat:boom", T0 + 32 * MINUTE, 15)).toEqual({
      suppressed: 0,
    });
  });

  it("throttles each distinct error independently", () => {
    expect(shouldSend("chat:boom", T0, 15)).not.toBeNull();
    expect(shouldSend("files:other", T0, 15)).not.toBeNull();
  });

  it("caps the hourly volume so a failure loop can't flood the inbox", () => {
    // 12 distinct errors get through; the 13th in the same hour does not.
    for (let i = 0; i < 12; i++) {
      expect(shouldSend(`chat:err-${i}`, T0 + i, 15)).not.toBeNull();
    }
    expect(shouldSend("chat:err-12", T0 + 12, 15)).toBeNull();
  });

  it("resumes sending in the next hour", () => {
    for (let i = 0; i < 12; i++) shouldSend(`chat:err-${i}`, T0 + i, 15);
    expect(shouldSend("chat:err-12", T0 + 12, 15)).toBeNull();
    expect(shouldSend("chat:err-12", T0 + 61 * MINUTE, 15)).not.toBeNull();
  });

  it("honours a custom window", () => {
    shouldSend("chat:boom", T0, 60);
    expect(shouldSend("chat:boom", T0 + 30 * MINUTE, 60)).toBeNull();
    expect(shouldSend("chat:boom", T0 + 61 * MINUTE, 60)).not.toBeNull();
  });
});
