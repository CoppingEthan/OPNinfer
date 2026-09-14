import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `ensureChatPool` — the guarantee that a conversation's pool directory exists
 * before anything tries to MOUNT it.
 *
 * This is the fix for a production-only outage (2026-08-03): the sandbox
 * mounts the pool as a named-volume subpath, Docker will not create a missing
 * subpath, and code execution — unlike an upload or write_file — never created
 * the directory. A chat whose first move was `execute_command` could never
 * start a sandbox at all. Dev used a bind mount, which Docker auto-creates,
 * so it passed locally every time.
 */

let root: string;
let storage: typeof import("./storage");

const CONV = "cc76d609-d0ea-4b1f-a124-4a7839ce20ac"; // the chat that found it

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opninfer-pool-"));
  process.env.OPNINFER_STORAGE_ROOT = root;
  process.env.OPNINFER_TENANT_ID = "default";
  storage = await import("./storage");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("ensureChatPool", () => {
  it("creates the pool directory when nothing has been written yet", async () => {
    const dir = await storage.ensureChatPool(CONV);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("returns the same path chatPoolDir resolves to", async () => {
    const dir = await storage.ensureChatPool(CONV);
    expect(dir).toBe(storage.chatPoolDir(CONV));
  });

  it("is idempotent — a second call on an existing pool is fine", async () => {
    await storage.ensureChatPool(CONV);
    await expect(storage.ensureChatPool(CONV)).resolves.toBe(storage.chatPoolDir(CONV));
  });

  it("puts the pool under <tenant>/chats/<id>, which is what the sandbox mounts as a subpath", async () => {
    const dir = await storage.ensureChatPool(CONV);
    expect(dir.replace(/\\/g, "/")).toContain(`default/chats/${CONV}`);
    // …and under the TEMP root, not the repo's real storage/ — if the env var
    // this test sets ever stops being honoured, the suite would start creating
    // directories in the working tree instead of failing.
    expect(dir.startsWith(root)).toBe(true);
  });

  it("refuses a non-uuid conversation id rather than creating a stray directory", async () => {
    await expect(storage.ensureChatPool("../../etc")).rejects.toThrow(/invalid conversation id/i);
  });
});
