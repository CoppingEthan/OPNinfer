import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Does the backup cover every table?
 *
 * This exists because it did not, and nothing could tell: `user_memories` and
 * `message_feedback` were absent from the descriptor list for months. A restore
 * wipes users, `user_memories` cascades off them, and no archive ever taken
 * held a copy — so restoring a backup silently and permanently erased every
 * user's assistant memory, then reported success.
 *
 * The existing live harness (scripts/test-backup.ts) could never catch it: it
 * checks the same tables the implementation handles, so it only ever proved the
 * code agreed with itself. This reads the SCHEMA instead — the one source that
 * knows about a table the backup has forgotten.
 */

/**
 * The tables `backup.ts` actually handles, read out of its own `TABLES` array.
 *
 * Read from source rather than imported: `backup.ts` is `server-only` and pulls
 * in Prisma and archiver, and a second hand-maintained copy of the list is
 * exactly the kind of thing that drifts out of step with the real one — which
 * is the bug this file is here to prevent.
 */
function backupTables(): string[] {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "backup.ts"), "utf8");
  const start = src.indexOf("const TABLES: TableIO[] = [");
  expect(start, "TABLES array not found — has backup.ts been restructured?").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n];", start));
  return [...body.matchAll(/^\s{4}name: "([^"]+)",/gm)].map((m) => m[1]);
}

/** Every `@@map("...")` in the Prisma schema — i.e. every real table. */
function schemaTables(): string[] {
  const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const names: string[] = [];
  // Only model blocks: enums have no @@map, and none is a table.
  const models = schema.split(/\nmodel\s+/).slice(1);
  for (const block of models) {
    const body = block.slice(0, block.indexOf("\n}"));
    const map = /@@map\("([^"]+)"\)/.exec(body);
    if (map) names.push(map[1]);
  }
  return names;
}

describe("backup coverage", () => {
  it("finds the schema (so this test can't pass by reading nothing)", () => {
    expect(schemaTables().length).toBeGreaterThanOrEqual(13);
  });

  it("backs up EVERY table in the Prisma schema", () => {
    const missing = schemaTables().filter((t) => !backupTables().includes(t));
    expect(missing, `not covered by backup: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not list a table the schema doesn't have", () => {
    const known = schemaTables();
    const stray = backupTables().filter((t) => !known.includes(t));
    expect(stray, `backup lists unknown tables: ${stray.join(", ")}`).toEqual([]);
  });

  it("keeps users first, so restore can insert parents before children", () => {
    // Restore creates in this order and deletes in reverse; every table with a
    // user FK must therefore come after `users`.
    expect(backupTables()[0]).toBe("users");
  });

  it("covers the two tables whose absence made restore destructive", () => {
    expect(backupTables()).toContain("user_memory_topics");
    expect(backupTables()).toContain("message_feedback");
  });
});
