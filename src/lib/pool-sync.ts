import "server-only";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { chatPoolDir, chatPoolRelDir, POOL_ARTIFACT_DIR } from "@/lib/storage";

/**
 * Pool ↔ DB reconciliation (v0.3 sandbox). Sandbox executions and host-side
 * file tools mutate the pool directly; this diff makes the `files` table
 * catch up so new/changed files get ingested (manifest, chips, downloads) and
 * deleted ones vanish.
 *
 *   new file on disk      → files row (kind=generated, status=pending)
 *   size changed          → status reset to pending (re-ingest)
 *   row without a file    → generated: row deleted · upload: marked missing
 *
 * Known accepted gap (documented): a same-size in-place edit via shell isn't
 * detected — the write_file/edit_file tools reset status explicitly instead.
 */

/** Depth and count bounds on the walk. A model that unpacks a tarball would
 *  otherwise register thousands of rows, queue thousands of ingestion jobs,
 *  and prepend a thousand-line manifest to every later turn in that chat. */
const MAX_DEPTH = 4;
export const MAX_TRACKED_FILES = 500;

export interface PoolSyncResult {
  added: string[];
  changed: string[];
  removed: string[];
  /** Uploads whose file is gone: kept as rows, flagged rather than deleted. */
  missing: string[];
  /** True when the walk hit MAX_TRACKED_FILES and stopped registering. */
  truncated: boolean;
}

/** What the walk found: pool-relative POSIX name → size in bytes. */
export type PoolListing = Map<string, number>;

/**
 * List the files in a pool, recursively.
 *
 * Recursive because `write_file` advertises subdirectories and a sandbox script
 * naturally does `mkdir out && mv report.md out/`. A top-level-only scan made
 * anything below the root invisible: the model could write a deliverable it
 * could then neither read, list, nor present — and moving an existing file into
 * a subdirectory looked exactly like deleting it.
 */
export async function walkPoolFiles(dir: string): Promise<{
  listing: PoolListing;
  truncated: boolean;
}> {
  const listing: PoolListing = new Map();
  let truncated = false;

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || truncated) return;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === POOL_ARTIFACT_DIR || e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // Symlinks are neither files nor directories here: `isFile()` is false
      // for them, so a link planted from the sandbox never becomes a row.
      if (e.isDirectory()) {
        await walk(join(abs, e.name), childRel, depth + 1).catch(() => {});
        continue;
      }
      if (!e.isFile()) continue;
      if (listing.size >= MAX_TRACKED_FILES) {
        truncated = true;
        return;
      }
      try {
        listing.set(childRel, (await stat(join(abs, e.name))).size);
      } catch {
        /* vanished mid-scan */
      }
    }
  };

  await walk(dir, "", 0);
  return { listing, truncated };
}

/** One row as the planner needs it (a Prisma row satisfies this). */
export interface PoolRow {
  id: string;
  filename: string;
  sizeBytes: bigint | number;
  kind: string;
  status: string;
}

export interface PoolSyncPlan {
  create: { name: string; size: number }[];
  reingest: { id: string; name: string; size: number }[];
  delete: { id: string; name: string }[];
  /** Uploads whose bytes are gone — flagged, never deleted. */
  flagMissing: { id: string; name: string }[];
}

/**
 * Decide what to do, given what is on disk and what the DB believes. Pure, so
 * the rules that can destroy a user's files are testable without a database.
 *
 * The load-bearing rule: a row for a file that is no longer on disk is deleted
 * only when the ASSISTANT created it. An `upload` is the user's own attachment,
 * referenced by `meta.fileIds` on their message — a shell command that moves or
 * removes it (`mv *.csv out/`, `rm *.xlsx`, an overwriting unzip) used to
 * delete that row outright, so the chip vanished from the user's own message
 * and the download 404'd, unrecoverably and with nothing in the transcript to
 * explain it. Now the row survives and says so.
 */
export function planPoolSync(onDisk: PoolListing, rows: PoolRow[]): PoolSyncPlan {
  const plan: PoolSyncPlan = { create: [], reingest: [], delete: [], flagMissing: [] };
  const byName = new Map(rows.map((r) => [r.filename, r]));

  for (const row of rows) {
    if (onDisk.has(row.filename)) continue;
    if (row.kind === "upload") {
      if (row.status !== "failed") plan.flagMissing.push({ id: row.id, name: row.filename });
    } else {
      plan.delete.push({ id: row.id, name: row.filename });
    }
  }

  for (const [name, size] of onDisk) {
    const row = byName.get(name);
    if (!row) plan.create.push({ name, size });
    else if (Number(row.sizeBytes) !== size) {
      plan.reingest.push({ id: row.id, name, size });
    }
  }

  return plan;
}

export async function syncPool(
  conversationId: string,
  userId: string,
): Promise<PoolSyncResult> {
  const empty: PoolSyncResult = {
    added: [],
    changed: [],
    removed: [],
    missing: [],
    truncated: false,
  };
  const dir = chatPoolDir(conversationId);

  let listing: PoolListing;
  let truncated = false;
  try {
    ({ listing, truncated } = await walkPoolFiles(dir));
  } catch (err) {
    // A pool that does not exist yet is genuinely empty — reconcile against
    // nothing. ANY OTHER failure (permissions, a busy or unmounted volume, a
    // mis-set storage root — all of which have happened) must abort instead:
    // treating "I couldn't look" as "there is nothing there" would delete every
    // generated row in the chat and flag every upload as missing.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return empty;
    listing = new Map();
  }

  const rows = await db.file.findMany({ where: { conversationId } });
  const plan = planPoolSync(listing, rows);

  for (const d of plan.delete) {
    await db.file.delete({ where: { id: d.id } }).catch(() => {});
  }
  for (const m of plan.flagMissing) {
    await db.file
      .update({
        where: { id: m.id },
        data: {
          status: "failed",
          error: "This file is no longer in the chat's workspace.",
        },
      })
      .catch(() => {});
  }
  for (const c of plan.create) {
    await db.file.create({
      data: {
        userId,
        conversationId,
        filename: c.name,
        mimeType: "application/octet-stream",
        sizeBytes: BigInt(c.size),
        storagePath: `${chatPoolRelDir(conversationId)}/${c.name}`,
        kind: "generated",
        // status defaults to pending — the worker prepares it.
      },
    });
  }
  for (const r of plan.reingest) {
    await db.file.update({
      where: { id: r.id },
      data: {
        sizeBytes: BigInt(r.size),
        status: "pending",
        attempts: 0,
        contentPath: null,
        error: null,
      },
    });
  }

  return {
    added: plan.create.map((c) => c.name),
    changed: plan.reingest.map((r) => r.name),
    removed: plan.delete.map((d) => d.name),
    missing: plan.flagMissing.map((m) => m.name),
    truncated,
  };
}

/** Explicit re-ingest for a file a tool KNOWS it touched (covers same-size edits). */
export async function markFileDirty(
  conversationId: string,
  filename: string,
  sizeBytes: number,
): Promise<void> {
  await db.file.updateMany({
    where: { conversationId, filename },
    data: {
      sizeBytes: BigInt(sizeBytes),
      status: "pending",
      attempts: 0,
      contentPath: null,
      error: null,
    },
  });
}
