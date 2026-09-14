import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFailedAttempts,
  lockoutRemaining,
  recordFailedAttempt,
} from "./sudo";

/**
 * The Admin → Chats re-auth gate.
 *
 * Two things are pinned here. The lockout counter used to have a dead branch —
 * both arms added 1 to the old count — so after an admin once tripped the
 * five-attempt limit, every later typo re-locked them for another five minutes
 * indefinitely, with the only escape being a container restart. And the grant
 * cookie was scoped to `/admin`, which meant the browser never sent it to
 * `/api/files/<id>`: an admin who unlocked a chat to investigate a problem saw
 * every attachment 404 and every generated image broken, and the
 * `admin.view_file` audit event could never be written.
 */

const ADMIN = "3f8a1f56-2c4d-4a5f-9a0b-1d2e3f4a5b6c";

beforeEach(() => {
  vi.useFakeTimers();
  clearFailedAttempts(ADMIN);
});

afterEach(() => {
  clearFailedAttempts(ADMIN);
  vi.useRealTimers();
});

describe("sudo lockout", () => {
  it("does not lock out before the limit", () => {
    for (let i = 0; i < 4; i++) recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(ADMIN)).toBe(0);
  });

  it("locks out on the fifth wrong password", () => {
    for (let i = 0; i < 5; i++) recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(ADMIN)).toBeGreaterThan(0);
  });

  it("lets the admin try again once the lockout elapses", () => {
    for (let i = 0; i < 5; i++) recordFailedAttempt(ADMIN);
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    expect(lockoutRemaining(ADMIN)).toBe(0);
  });

  it("starts counting again after a served lockout, instead of re-locking on one typo", () => {
    for (let i = 0; i < 5; i++) recordFailedAttempt(ADMIN);
    vi.advanceTimersByTime(5 * 60_000 + 1_000);

    recordFailedAttempt(ADMIN); // one more mistake — must NOT re-lock
    expect(lockoutRemaining(ADMIN)).toBe(0);

    // …and it still takes a full five to lock again.
    for (let i = 0; i < 3; i++) recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(ADMIN)).toBe(0);
    recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(ADMIN)).toBeGreaterThan(0);
  });

  it("a successful unlock clears the history", () => {
    for (let i = 0; i < 4; i++) recordFailedAttempt(ADMIN);
    clearFailedAttempts(ADMIN);
    for (let i = 0; i < 4; i++) recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(ADMIN)).toBe(0);
  });

  it("tracks admins separately", () => {
    const other = "9c1b2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e";
    for (let i = 0; i < 5; i++) recordFailedAttempt(ADMIN);
    expect(lockoutRemaining(other)).toBe(0);
    clearFailedAttempts(other);
  });
});

describe("sudo grant cookie", () => {
  it("is site-wide, so the chat viewer's file requests carry it", () => {
    // Read from source: `grantSudo` needs a request context to run.
    const src = readFileSync(path.join(process.cwd(), "src", "lib", "sudo.ts"), "utf8");
    const setCall = src.slice(src.indexOf("jar.set("), src.indexOf("});", src.indexOf("jar.set(")));
    expect(setCall).toMatch(/path:\s*"\/"/);
    expect(setCall).not.toMatch(/path:\s*"\/admin"/);
    // The properties that DO secure it must still be there.
    expect(setCall).toMatch(/httpOnly:\s*true/);
    expect(setCall).toMatch(/maxAge/);
  });
});
