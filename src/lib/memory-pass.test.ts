import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The idle-chat memory pass touches every quiet chat on the instance, so two
 * rules about HOW it touches them are pinned against the source (the picker
 * and the stamp are raw SQL over a live database — no unit can run them):
 *
 * 1. The stamp must be a RAW update. `db.conversation.update` auto-stamps
 *    `@updatedAt`, and `updated_at` is "last activity" to the sidebar and to
 *    Admin → Chats: the first working night (2026-09-04) bumped 600 chats
 *    from January–March to "just now", ten every five minutes.
 * 2. The picker must ignore chats older than MAX_AGE_DAYS, or the first tick
 *    after a deploy or an outage starts on the oldest never-passed chat and
 *    rewrites people's notes from months-old conversations.
 */
describe("memory pass: how it touches chats", () => {
  const src = readFileSync(new URL("./memory-pass.ts", import.meta.url), "utf8");

  it("stamps memory_pass_at with a raw update, never db.conversation.update", () => {
    expect(src).toMatch(/\$executeRaw`update conversations set memory_pass_at = /);
    expect(src).not.toMatch(/db\.conversation\.update\(/);
  });

  it("never picks a chat quiet for longer than MAX_AGE_DAYS", () => {
    expect(src).toMatch(/max\(m\.created_at\) > now\(\) - make_interval\(days => \$\{MAX_AGE_DAYS\}::int\)/);
    expect(src).toMatch(/Number\(process\.env\.MEMORY_PASS_MAX_AGE_DAYS\) \|\| 7/);
  });

  it("binds the interval arguments as int (Postgres has no bigint overload)", () => {
    expect(src).toMatch(/make_interval\(mins => \$\{IDLE_MINUTES\}::int\)/);
  });
});
