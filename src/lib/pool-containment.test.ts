import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `poolContainmentError` — the guard that stops a symlink planted from inside
 * the sandbox redirecting a host-side write out of the chat's pool.
 *
 * Why it needs to exist: the lexical guard in `tools/sandbox.ts` (strip leading
 * "/", reject "..", resolve, prefix-compare) is string arithmetic — `resolve`
 * never touches the disk and never follows a link. But the sandbox mounts the
 * pool read-write as the same uid that owns it, so code the model runs can
 * create a symlink there, and `write_file`/`edit_file`/`delete_file` then run
 * host-side as the APP user. Two calls — `ln -s /app/server.js report.txt`
 * then `write_file("report.txt", …)` — would overwrite the app's own entry
 * point, which next restart executes holding the master key, AUTH_SECRET and
 * the database URL.
 *
 * Symlink creation on Windows needs privileges the test runner usually lacks,
 * so those cases skip themselves rather than fail — the fix ships to Linux.
 */

let root: string;
let pool: string;
let outside: string;
let storage: typeof import("./storage");
let canSymlink = true;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opninfer-containment-"));
  process.env.OPNINFER_STORAGE_ROOT = root;
  process.env.OPNINFER_TENANT_ID = "default";
  storage = await import("./storage");

  pool = join(root, "pool");
  outside = join(root, "outside");
  await mkdir(pool, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "server.js"), "// the real app entrypoint\n");

  try {
    await symlink(join(outside, "server.js"), join(pool, "probe.txt"));
  } catch {
    canSymlink = false;
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("poolContainmentError", () => {
  it("actually exercises the symlink cases wherever it can", () => {
    // Without this, a machine that silently can't create symlinks would run
    // only the three benign cases and report a green suite that proves nothing
    // about the bug this file exists for. CI is Linux, so it must be true there.
    if (process.platform !== "win32") expect(canSymlink).toBe(true);
    else if (!canSymlink) console.warn("symlinks unavailable — escape cases skipped");
  });

  it("allows an ordinary new file in the pool", async () => {
    expect(await storage.poolContainmentError(pool, join(pool, "notes.md"))).toBeNull();
  });

  it("allows an ordinary existing file", async () => {
    await writeFile(join(pool, "real.txt"), "hello");
    expect(await storage.poolContainmentError(pool, join(pool, "real.txt"))).toBeNull();
  });

  it("allows a file in a subdirectory that does not exist yet", async () => {
    expect(await storage.poolContainmentError(pool, join(pool, "out", "report.md"))).toBeNull();
  });

  it("refuses a target that IS a symlink out of the pool", async () => {
    if (!canSymlink) return;
    await symlink(join(outside, "server.js"), join(pool, "escape.txt")).catch(() => {});
    const err = await storage.poolContainmentError(pool, join(pool, "escape.txt"));
    expect(err).toMatch(/escapes/i);
  });

  it("refuses a path THROUGH a symlinked directory, even when the file is new", async () => {
    if (!canSymlink) return;
    await symlink(outside, join(pool, "linkdir")).catch(() => {});
    // Lexically this is inside the pool; on disk it lands in `outside`.
    const err = await storage.poolContainmentError(pool, join(pool, "linkdir", "new.txt"));
    expect(err).toMatch(/escapes/i);
  });

  it("refuses a symlink even when it points back INSIDE the pool", async () => {
    if (!canSymlink) return;
    await symlink(join(pool, "real.txt"), join(pool, "inside-link.txt")).catch(() => {});
    // Nothing legitimate here needs a symlink, so the simple answer is safe.
    expect(await storage.poolContainmentError(pool, join(pool, "inside-link.txt"))).toMatch(
      /escapes/i,
    );
  });

  it("compares against the pool's REAL path, so a linked pool still works", async () => {
    if (!canSymlink) return;
    const linkedPool = join(root, "pool-link");
    await symlink(pool, linkedPool).catch(() => {});
    // Reached through a link, the pool's own contents must still be allowed —
    // otherwise a bind-mounted or relocated storage root breaks every write.
    expect(await storage.poolContainmentError(linkedPool, join(pool, "real.txt"))).toBeNull();
  });

  it("refuses an absolute path outside the pool", async () => {
    expect(await storage.poolContainmentError(pool, join(outside, "server.js"))).toMatch(
      /escapes/i,
    );
  });
});
