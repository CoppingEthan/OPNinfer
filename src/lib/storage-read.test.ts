import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `resolveStoredPathForRead` — the READ-side twin of `poolContainmentError`
 * (audit 2026-09-05). Every host-side read of a pool file used the lexical
 * resolver, which never follows a link, while the Sandbox can plant one in
 * the pool as the same uid: `ln -s /proc/self/environ report.pdf`, then the
 * user clicks Download and the app streams its own environment. The rule
 * under test: no component below the storage root may be a symbolic link.
 *
 * Symlink creation on Windows needs privileges the test runner usually lacks,
 * so those cases skip themselves rather than fail — the fix ships to Linux.
 */

let root: string;
let storage: typeof import("./storage");
let canSymlink = true;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opninfer-read-"));
  process.env.OPNINFER_STORAGE_ROOT = root;
  process.env.OPNINFER_TENANT_ID = "default";
  storage = await import("./storage");

  await mkdir(join(root, "default", "chats", "c1"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(join(root, "default", "chats", "c1", "real.txt"), "hello\n");
  await writeFile(join(root, "outside", "secret.txt"), "MASTER_KEY=…\n");
  try {
    await symlink(join(root, "outside", "secret.txt"), join(root, "default", "chats", "c1", "link.txt"), "file");
    await symlink(join(root, "outside"), join(root, "default", "chats", "c1", "dirlink"), "dir");
  } catch {
    canSymlink = false;
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveStoredPathForRead", () => {
  it("resolves a plain file inside the root", async () => {
    const p = await storage.resolveStoredPathForRead("default/chats/c1/real.txt");
    expect(p.endsWith(join("default", "chats", "c1", "real.txt"))).toBe(true);
  });

  it("throws for a missing file (callers treat it as not found)", async () => {
    await expect(storage.resolveStoredPathForRead("default/chats/c1/nope.txt")).rejects.toThrow();
  });

  it("still refuses lexical escapes", async () => {
    await expect(storage.resolveStoredPathForRead("../etc/passwd")).rejects.toThrow(/escapes/);
  });

  it("refuses a file that is a symlink, even to somewhere inside the root", async () => {
    if (!canSymlink) return;
    await expect(storage.resolveStoredPathForRead("default/chats/c1/link.txt")).rejects.toThrow(/symbolic link/);
  });

  it("refuses a path that passes through a linked directory", async () => {
    if (!canSymlink) return;
    await expect(storage.resolveStoredPathForRead("default/chats/c1/dirlink/secret.txt")).rejects.toThrow(/symbolic link/);
  });

  it("readFileStream goes through the same guard", async () => {
    if (!canSymlink) return;
    await expect(storage.readFileStream("default/chats/c1/link.txt")).rejects.toThrow(/symbolic link/);
    const s = await storage.readFileStream("default/chats/c1/real.txt");
    expect(typeof (s as { pipe?: unknown }).pipe).toBe("function");
  });
});
