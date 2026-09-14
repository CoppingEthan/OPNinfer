import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planPoolSync, walkPoolFiles, MAX_TRACKED_FILES, type PoolRow } from "./pool-sync";

/**
 * The pool ↔ DB diff, split so the parts that can destroy a user's files are
 * testable without a database.
 *
 * Two rules here exist because of what the old version did. It scanned only the
 * top level, so a deliverable written to `out/report.md` was invisible to
 * every tool that could have handed it over. And it deleted the row for any
 * file it couldn't see — including `kind: "upload"`, the user's OWN attachment,
 * referenced by their message — so a shell command that moved or removed one
 * (`mv *.csv out/`, `rm *.xlsx`, an overwriting unzip) made the chip vanish
 * from their message and the download 404, with nothing in the transcript to
 * say why.
 */

let root: string;

const upload = (name: string, size = 10): PoolRow => ({
  id: `u-${name}`,
  filename: name,
  sizeBytes: size,
  kind: "upload",
  status: "ready",
});
const generated = (name: string, size = 10): PoolRow => ({
  id: `g-${name}`,
  filename: name,
  sizeBytes: size,
  kind: "generated",
  status: "ready",
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opninfer-sync-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("walkPoolFiles", () => {
  it("finds files in subdirectories, named relative to the pool", async () => {
    const pool = join(root, "walk");
    await mkdir(join(pool, "out"), { recursive: true });
    await writeFile(join(pool, "script.py"), "print(1)");
    await writeFile(join(pool, "out", "report.md"), "# hi");

    const { listing } = await walkPoolFiles(pool);
    expect([...listing.keys()].sort()).toEqual(["out/report.md", "script.py"]);
  });

  it("uses POSIX separators, because that's what the files table stores", async () => {
    const { listing } = await walkPoolFiles(join(root, "walk"));
    for (const name of listing.keys()) expect(name).not.toContain("\\");
  });

  it("skips the hidden artifacts directory and dotfiles", async () => {
    const pool = join(root, "hidden");
    await mkdir(join(pool, ".opninfer"), { recursive: true });
    await writeFile(join(pool, ".opninfer", "abc.md"), "prepared");
    await writeFile(join(pool, ".secret"), "x");
    await writeFile(join(pool, "visible.txt"), "y");

    const { listing } = await walkPoolFiles(pool);
    expect([...listing.keys()]).toEqual(["visible.txt"]);
  });

  it("does not list a symlink, so one planted in the sandbox never becomes a row", async () => {
    const pool = join(root, "links");
    await mkdir(pool, { recursive: true });
    await writeFile(join(root, "outside.txt"), "elsewhere");
    let linked = true;
    try {
      await symlink(join(root, "outside.txt"), join(pool, "link.txt"));
    } catch {
      linked = false;
    }
    if (process.platform !== "win32") expect(linked).toBe(true);
    if (!linked) return;
    const { listing } = await walkPoolFiles(pool);
    expect([...listing.keys()]).toEqual([]);
  });

  it("stops at the cap and says so, rather than registering a whole tarball", async () => {
    const pool = join(root, "many");
    await mkdir(pool, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_TRACKED_FILES + 5 }, (_, i) =>
        writeFile(join(pool, `f${i}.txt`), "x"),
      ),
    );
    const { listing, truncated } = await walkPoolFiles(pool);
    expect(listing.size).toBe(MAX_TRACKED_FILES);
    expect(truncated).toBe(true);
  });

  it("throws ENOENT for a pool that isn't there (the caller must tell that apart)", async () => {
    await expect(walkPoolFiles(join(root, "nope"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("planPoolSync", () => {
  it("registers a file that appeared", () => {
    const plan = planPoolSync(new Map([["out.csv", 42]]), []);
    expect(plan.create).toEqual([{ name: "out.csv", size: 42 }]);
  });

  it("re-ingests a file whose size changed", () => {
    const plan = planPoolSync(new Map([["a.txt", 99]]), [generated("a.txt", 10)]);
    expect(plan.reingest.map((r) => r.name)).toEqual(["a.txt"]);
    expect(plan.delete).toEqual([]);
  });

  it("leaves an unchanged file completely alone", () => {
    const plan = planPoolSync(new Map([["a.txt", 10]]), [generated("a.txt", 10)]);
    expect(plan).toEqual({ create: [], reingest: [], delete: [], flagMissing: [] });
  });

  it("deletes the row for a GENERATED file that is gone", () => {
    const plan = planPoolSync(new Map(), [generated("scratch.py")]);
    expect(plan.delete.map((d) => d.name)).toEqual(["scratch.py"]);
    expect(plan.flagMissing).toEqual([]);
  });

  it("NEVER deletes the row for a file the user uploaded — it flags it", () => {
    // This is the one that cost a user their attachment: `rm *.xlsx` in a
    // tidy-up script used to delete the row outright.
    const plan = planPoolSync(new Map(), [upload("figures.xlsx")]);
    expect(plan.delete).toEqual([]);
    expect(plan.flagMissing.map((m) => m.name)).toEqual(["figures.xlsx"]);
  });

  it("doesn't re-flag an upload that is already marked missing", () => {
    const row = { ...upload("gone.csv"), status: "failed" };
    expect(planPoolSync(new Map(), [row]).flagMissing).toEqual([]);
  });

  it("treats a file moved into a subdirectory as the same kind of event, not a loss", () => {
    // `mkdir out && mv data.csv out/` — the upload row is flagged rather than
    // deleted, and the moved file is registered under its new name.
    const plan = planPoolSync(new Map([["out/data.csv", 10]]), [upload("data.csv", 10)]);
    expect(plan.delete).toEqual([]);
    expect(plan.flagMissing.map((m) => m.name)).toEqual(["data.csv"]);
    expect(plan.create.map((c) => c.name)).toEqual(["out/data.csv"]);
  });

  it("handles an empty pool and no rows without inventing work", () => {
    expect(planPoolSync(new Map(), [])).toEqual({
      create: [],
      reingest: [],
      delete: [],
      flagMissing: [],
    });
  });
});
