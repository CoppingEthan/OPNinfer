import "server-only";
import archiver from "archiver";
import JSZip from "jszip";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { rename as renamePath } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { storageRoot } from "./storage";
import { appLog } from "./applog";
import { APP_VERSION } from "./version";

/**
 * Full-instance backup & restore (admin, §backup).
 *
 * A backup is a single `.zip` holding:
 *   - manifest.json   — format/app version, timestamps, table row counts, and a
 *                       fingerprint of OPNINFER_MASTER_KEY (to warn on restore
 *                       if the encryption key differs — encrypted provider keys
 *                       only decrypt with the same master key).
 *   - database.json   — a logical dump of every table (portable JSON, not a
 *                       binary pg_dump), so it restores into the CURRENT schema
 *                       regardless of the Postgres version or platform.
 *   - storage/<tenant>/… — a mirror of the on-disk storage tree (uploaded files,
 *                       avatars, branding assets).
 *
 * Restore is data-only: it wipes and repopulates the app tables (never touching
 * Prisma's migration table), then replaces the storage tree. Backups live under
 * `<storageRoot>/backups`, which is OUTSIDE the tenant tree, so they survive a
 * restore and are never nested inside their own archive.
 */

const FORMAT_VERSION = 1;

function tenant(): string {
  return process.env.OPNINFER_TENANT_ID ?? "default";
}

function backupsDir(): string {
  return join(storageRoot(), "backups");
}

/** Never archived: each Sandbox chat's state dir carries a link to the
 *  shared Claude sign-in (or, briefly, a copy of it mid-run) — a token that
 *  belongs in the credential volume, not in a zip that gets downloaded and
 *  carried to another server. The sign-in is re-linked at container start. */
const NEVER_ARCHIVE = new Set([".credentials.json"]);

/**
 * Add the storage tree to the archive, REGULAR FILES ONLY, walking it
 * ourselves. `archive.directory()` stats every entry and one it can't read
 * kills the whole backup: the agent state dirs hold Linux symlinks that a
 * Windows dev box cannot even lstat (EACCES — every dev backup since the
 * agent tier arrived failed on that), and on Linux the same links dangle
 * (they point inside the container). Skipping anything that is not a plain
 * file or directory, plus the sign-in link by name, keeps a backup a backup.
 */
async function addStorageTree(archive: archiver.Archiver, dir: string, prefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await addStorageTree(archive, abs, name);
    } else if (entry.isFile() && !NEVER_ARCHIVE.has(entry.name)) {
      archive.file(abs, { name });
    }
    // Symlinks, sockets, and whatever Windows reports for a Linux link: skipped.
  }
}

/** Fingerprint of the master key (never the key itself) for restore warnings. */
function masterKeyFingerprint(): string {
  return createHash("sha256")
    .update(process.env.OPNINFER_MASTER_KEY ?? "")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Table descriptors — insertion order respects foreign keys (parents first).
// Delete runs in reverse. `special` marks columns whose JSON encoding needs
// care: Bytes → base64, BigInt → string. Decimal/DateTime/Json survive as
// strings/objects that Prisma coerces back on write.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type TX = Prisma.TransactionClient;
type SpecialKind = "bytes" | "bigint" | "decimal";

interface TableIO {
  name: string;
  special: Record<string, SpecialKind>;
  read(): Promise<Row[]>;
  create(tx: TX, rows: Row[]): Promise<void>;
  del(tx: TX): Promise<void>;
}

const TABLES: TableIO[] = [
  {
    name: "users",
    special: {},
    read: () => db.user.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.user.createMany({ data: rows as Prisma.UserCreateManyInput[] });
    },
    del: async (tx) => void (await tx.user.deleteMany({})),
  },
  {
    name: "invites",
    special: {},
    read: () => db.invite.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.invite.createMany({ data: rows as Prisma.InviteCreateManyInput[] });
    },
    del: async (tx) => void (await tx.invite.deleteMany({})),
  },
  {
    name: "password_reset_tokens",
    special: {},
    read: () => db.passwordResetToken.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.passwordResetToken.createMany({
        data: rows as Prisma.PasswordResetTokenCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.passwordResetToken.deleteMany({})),
  },
  {
    name: "provider_credentials",
    special: { encryptedValue: "bytes" },
    read: () => db.providerCredential.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.providerCredential.createMany({
        data: rows as Prisma.ProviderCredentialCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.providerCredential.deleteMany({})),
  },
  {
    name: "usage_records",
    special: { costEstimate: "decimal" },
    read: () => db.usageRecord.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.usageRecord.createMany({
        data: rows as Prisma.UsageRecordCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.usageRecord.deleteMany({})),
  },
  {
    name: "audit_log",
    special: {},
    read: () => db.auditLog.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.auditLog.createMany({ data: rows as Prisma.AuditLogCreateManyInput[] });
    },
    del: async (tx) => void (await tx.auditLog.deleteMany({})),
  },
  {
    name: "app_log",
    special: {},
    read: () => db.appLog.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.appLog.createMany({ data: rows as Prisma.AppLogCreateManyInput[] });
    },
    del: async (tx) => void (await tx.appLog.deleteMany({})),
  },
  {
    name: "settings",
    special: {},
    read: () => db.setting.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.setting.createMany({ data: rows as Prisma.SettingCreateManyInput[] });
    },
    del: async (tx) => void (await tx.setting.deleteMany({})),
  },
  {
    // Folders: before conversations and conversation_members, both of which
    // carry a folder_id pointing here.
    name: "folders",
    special: {},
    read: () => db.folder.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.folder.createMany({ data: rows as Prisma.FolderCreateManyInput[] });
    },
    del: async (tx) => void (await tx.folder.deleteMany({})),
  },
  {
    name: "conversations",
    special: {},
    read: () => db.conversation.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.conversation.createMany({
        data: rows as Prisma.ConversationCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.conversation.deleteMany({})),
  },
  {
    // Shared chats (v0.5): who is in each shared chat. After conversations
    // and users (both FKs), before nothing that depends on it.
    name: "conversation_members",
    special: {},
    read: () => db.conversationMember.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.conversationMember.createMany({
        data: rows as Prisma.ConversationMemberCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.conversationMember.deleteMany({})),
  },
  {
    name: "messages",
    special: {},
    read: () => db.message.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.message.createMany({ data: rows as Prisma.MessageCreateManyInput[] });
    },
    del: async (tx) => void (await tx.message.deleteMany({})),
  },
  {
    // Conversation compaction (2026-09-10): after messages (boundary FK is a
    // message id by value, but the row cascades off conversations).
    name: "conversation_compactions",
    special: {},
    read: () => db.conversationCompaction.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.conversationCompaction.createMany({
        data: rows as Prisma.ConversationCompactionCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.conversationCompaction.deleteMany({})),
  },
  {
    name: "files",
    special: { sizeBytes: "bigint" },
    read: () => db.file.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.file.createMany({ data: rows as Prisma.FileCreateManyInput[] });
    },
    del: async (tx) => void (await tx.file.deleteMany({})),
  },
  // Both of these were MISSING until 2026-08-22, which made a restore quietly
  // destructive: the wipe runs `user.deleteMany({})`, `user_memories` cascades
  // off users, and no backup ever taken contained a copy — so restoring
  // yesterday's snapshot erased every user's assistant memory, permanently,
  // while reporting success. `message_feedback` survived the wipe (userId is
  // SET NULL) but was left as pre-restore rows pointing at a post-restore
  // world. `backup.test.ts` now asserts every Prisma model appears here.
  {
    // Memory v2 (0.5.1): the four notes per person, replacing `user_memories`.
    name: "user_memory_topics",
    special: {},
    read: () => db.userMemoryTopic.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.userMemoryTopic.createMany({ data: rows as Prisma.UserMemoryTopicCreateManyInput[] });
    },
    del: async (tx) => void (await tx.userMemoryTopic.deleteMany({})),
  },
  {
    name: "message_feedback",
    special: {},
    read: () => db.messageFeedback.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.messageFeedback.createMany({
        data: rows as Prisma.MessageFeedbackCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.messageFeedback.deleteMany({})),
  },
  {
    // Workflows and who they are shared with. After users; nothing else
    // depends on them.
    name: "workflows",
    special: {},
    read: () => db.workflow.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.workflow.createMany({ data: rows as Prisma.WorkflowCreateManyInput[] });
    },
    del: async (tx) => void (await tx.workflow.deleteMany({})),
  },
  {
    name: "workflow_members",
    special: {},
    read: () => db.workflowMember.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.workflowMember.createMany({
        data: rows as Prisma.WorkflowMemberCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.workflowMember.deleteMany({})),
  },
  {
    // The Sandbox agent's install/download tally (Admin → Tools). Plain
    // columns, no FKs — restores anywhere in the order.
    name: "agent_package_uses",
    read: () => db.agentPackageUse.findMany() as unknown as Promise<Row[]>,
    create: async (tx, rows) => {
      await tx.agentPackageUse.createMany({
        data: rows as Prisma.AgentPackageUseCreateManyInput[],
      });
    },
    del: async (tx) => void (await tx.agentPackageUse.deleteMany({})),
    special: {},
  },
];

/** Encode one row for JSON (Bytes→base64, BigInt→string, Decimal→string, Date→ISO). */
function serializeRow(row: Row, special: Record<string, SpecialKind>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = null;
      continue;
    }
    const kind = special[k];
    if (kind === "bytes") out[k] = Buffer.from(v as Uint8Array).toString("base64");
    else if (kind === "bigint") out[k] = (v as bigint).toString();
    else if (kind === "decimal") out[k] = String(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v; // string | number | boolean | Json (object/array)
  }
  return out;
}

/**
 * Decode one row for Prisma createMany. Null columns are OMITTED so the column
 * takes its DB default / NULL (this also sidesteps the Json-null typing dance).
 * Date/Decimal stay ISO/decimal strings, which Prisma coerces on write.
 */
function deserializeRow(row: Row, special: Record<string, SpecialKind>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    const kind = special[k];
    if (kind === "bytes") out[k] = new Uint8Array(Buffer.from(v as string, "base64"));
    else if (kind === "bigint") out[k] = BigInt(v as string);
    else out[k] = v;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function serializeDatabase(): Promise<Record<string, Row[]>> {
  const dump: Record<string, Row[]> = {};
  for (const t of TABLES) {
    const rows = await t.read();
    dump[t.name] = rows.map((r) => serializeRow(r, t.special));
  }
  return dump;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string; // ISO
}

function timestampName(): string {
  const iso = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `opninfer-backup-${iso}-${randomBytes(2).toString("hex")}.zip`;
}

/** Count files under a directory (for the manifest), tolerant of a missing dir. */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n += 1;
  }
  return n;
}

/**
 * Create a backup zip on disk and return its metadata. `source` is recorded in
 * the manifest ("manual" | "auto"). The archive is written to a `.part` temp
 * file and atomically renamed, so a crash mid-write never leaves a half-backup
 * that looks restorable.
 */
export async function createBackup(source: "manual" | "auto"): Promise<BackupInfo> {
  const dir = backupsDir();
  await mkdir(dir, { recursive: true });

  const dump = await serializeDatabase();
  const tenantDir = join(storageRoot(), tenant());
  const manifest = {
    app: "opninfer",
    formatVersion: FORMAT_VERSION,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    tenant: tenant(),
    source,
    masterKeyFingerprint: masterKeyFingerprint(),
    tables: Object.fromEntries(
      TABLES.map((t) => [t.name, dump[t.name].length]),
    ) as Record<string, number>,
    storageFiles: await countFiles(tenantDir),
  };

  const name = timestampName();
  const partPath = join(dir, `.${name}.part`);
  const finalPath = join(dir, name);

  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(partPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolvePromise());
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") reject(err);
    });
    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append(JSON.stringify(dump), { name: "database.json" });
    void (async () => {
      if (existsSync(tenantDir)) await addStorageTree(archive, tenantDir, `storage/${tenant()}`);
      await archive.finalize();
    })().catch(reject);
  });

  await rename(partPath, finalPath);
  const st = await stat(finalPath);
  return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
}

// ---------------------------------------------------------------------------
// List / delete / prune
// ---------------------------------------------------------------------------

export async function listBackups(): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir());
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const n of names) {
    if (!n.endsWith(".zip") || n.startsWith(".")) continue; // skip .part temps
    try {
      const st = await stat(join(backupsDir(), n));
      out.push({ name: n, sizeBytes: st.size, createdAt: st.mtime.toISOString() });
    } catch {
      /* vanished between readdir and stat — ignore */
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/** Resolve a backup name to an absolute path, guarding traversal. */
export function backupFilePath(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  if (!base.endsWith(".zip") || base.startsWith(".")) {
    throw new Error("Invalid backup name.");
  }
  const abs = resolve(backupsDir(), base);
  if (!abs.startsWith(backupsDir() + sep)) {
    throw new Error("Resolved path escapes the backups directory.");
  }
  return abs;
}

export async function deleteBackup(name: string): Promise<void> {
  try {
    await unlink(backupFilePath(name));
  } catch {
    /* already gone — ignore */
  }
}

/** Keep the `retention` most-recent backups, delete the rest. Returns #removed. */
export async function pruneBackups(retention: number): Promise<number> {
  if (!retention || retention < 1) return 0;
  const list = await listBackups(); // newest first
  const stale = list.slice(retention);
  for (const b of stale) await deleteBackup(b.name);
  return stale.length;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  appVersion: string;
  createdAt: string;
  tables: Record<string, number>;
  restoredFiles: number;
  masterKeyMismatch: boolean;
}

/**
 * Restore an instance from an uploaded backup zip. DESTRUCTIVE: replaces all
 * app data and the storage tree with the archive's contents. The database is
 * repopulated inside one transaction (all-or-nothing); storage is swapped after
 * the DB commits.
 */
export async function restoreFromZip(buffer: Buffer): Promise<RestoreResult> {
  const zip = await JSZip.loadAsync(buffer);
  const manifestFile = zip.file("manifest.json");
  const dbFile = zip.file("database.json");
  if (!manifestFile || !dbFile) {
    throw new Error(
      "Not a valid OPNinfer backup (missing manifest.json or database.json).",
    );
  }

  const manifest = JSON.parse(await manifestFile.async("string")) as {
    formatVersion?: number;
    appVersion?: string;
    createdAt?: string;
    masterKeyFingerprint?: string;
  };
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format (v${manifest.formatVersion ?? "?"}; this build reads v${FORMAT_VERSION}).`,
    );
  }
  const dump = JSON.parse(await dbFile.async("string")) as Record<string, Row[]>;

  // Pre-decode rows so a bad archive fails BEFORE we wipe anything.
  const decoded = TABLES.map((t) => ({
    t,
    rows: (dump[t.name] ?? []).map((r) => deserializeRow(r, t.special)),
  }));
  const counts: Record<string, number> = {};

  // 1) Repopulate the database atomically. Delete children→parents, insert
  //    parents→children, then restore @updatedAt (Prisma auto-manages it on
  //    create, so createMany would otherwise stamp "now").
  await db.$transaction(
    async (tx) => {
      for (let i = decoded.length - 1; i >= 0; i--) await decoded[i].t.del(tx);
      for (const { t, rows } of decoded) {
        counts[t.name] = rows.length;
        for (const batch of chunk(rows, 1000)) await t.create(tx, batch);
      }
      for (const c of dump["conversations"] ?? []) {
        if (c.updatedAt && c.id) {
          await tx.$executeRaw`UPDATE conversations SET updated_at = ${new Date(String(c.updatedAt))} WHERE id = ${String(c.id)}::uuid`;
        }
      }
      for (const s of dump["settings"] ?? []) {
        if (s.updatedAt && s.key) {
          await tx.$executeRaw`UPDATE settings SET updated_at = ${new Date(String(s.updatedAt))} WHERE key = ${String(s.key)}`;
        }
      }
      // A backup from BEFORE memory v2 (≤ 0.5.0) carries `user_memories`, a
      // table this build no longer has. Fold those rows into each person's
      // "About you" note exactly as the 0.5.1 migration did, so nothing anyone
      // told the assistant is lost across an upgrade-and-restore. (Any table
      // in the archive that this build doesn't know is otherwise ignored;
      // the reverse — an archive from a NEWER build — fails on its unknown
      // columns before anything is wiped for good, because the whole restore
      // is one transaction.)
      const legacyMemories = (dump["user_memories"] ?? []) as { userId?: unknown; content?: unknown; createdAt?: unknown }[];
      if (legacyMemories.length > 0 && (dump["user_memory_topics"] ?? []).length === 0) {
        const byUser = new Map<string, { content: string; at: string }[]>();
        for (const m of legacyMemories) {
          const userId = String(m.userId ?? "");
          const content = String(m.content ?? "").replace(/\s+/g, " ").trim();
          if (!userId || !content) continue;
          (byUser.get(userId) ?? byUser.set(userId, []).get(userId)!).push({ content, at: String(m.createdAt ?? "") });
        }
        for (const [userId, items] of byUser) {
          items.sort((a, b) => a.at.localeCompare(b.at));
          await tx.userMemoryTopic.create({
            data: { userId, key: "about", text: items.map((i) => `- ${i.content}`).join("\n") },
          });
        }
        counts["user_memory_topics"] = byUser.size;
      }

      // Same backup vintage: user turns had no author column. Stamp the chat's
      // owner on them, as the migration did, so NULL keeps meaning "author
      // gone" rather than "unknown".
      await tx.$executeRawUnsafe(
        `UPDATE messages m SET user_id = c.user_id FROM conversations c
           WHERE m.conversation_id = c.id AND m.role = 'user' AND m.user_id IS NULL`,
      );

      // `user_memory_topics.id` is a serial, and inserting rows with explicit
      // ids does NOT advance the sequence — so without this the first note
      // saved after a restore asks for id 1, which already exists, and every
      // memory write fails with a unique violation until someone works out
      // why. (Every other table is uuid-keyed, hence just this one.)
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('user_memory_topics', 'id'),
           GREATEST(COALESCE((SELECT MAX(id) FROM user_memory_topics), 0), 1),
           (SELECT COUNT(*) > 0 FROM user_memory_topics))`,
      );
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  // 2) Swap the storage tree — extract into a STAGING dir first, then rename
  // it into place (audit 2026-09-05). The old code wiped the tenant dir and
  // then extracted entry by entry: a full disk or an OOM halfway left a
  // database from the archive over a storage tree that was gone, behind a
  // "Restore failed" the admin would read as "nothing happened". Only
  // entries under THIS tenant are accepted: the old guard was anchored on
  // the storage root, so an archive could write into `backups/` (and be
  // listed as a genuine backup) or into another tenant's tree.
  const root = storageRoot();
  const tenantName = tenant();
  const tenantDir = join(root, tenantName);
  const stagingRoot = join(root, `.restore-${randomBytes(6).toString("hex")}`);
  const stagingTenant = join(stagingRoot, tenantName);

  let restoredFiles = 0;
  const storageEntries = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.startsWith(`storage/${tenantName}/`),
  );
  try {
    await mkdir(stagingTenant, { recursive: true });
    for (const f of storageEntries) {
      const rel = f.name.slice("storage/".length);
      if (!rel) continue;
      const abs = resolve(stagingRoot, rel);
      if (abs !== stagingTenant && !abs.startsWith(stagingTenant + sep)) continue; // traversal guard
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await f.async("nodebuffer"));
      restoredFiles++;
    }
    // Everything extracted: swap. The old tree is kept aside until the new
    // one is in place, then removed.
    const oldDir = `${tenantDir}.old-${randomBytes(4).toString("hex")}`;
    if (existsSync(tenantDir)) await renamePath(tenantDir, oldDir);
    await renamePath(stagingTenant, tenantDir);
    await rm(oldDir, { recursive: true, force: true });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  return {
    appVersion: manifest.appVersion ?? "unknown",
    createdAt: manifest.createdAt ?? "unknown",
    tables: counts,
    restoredFiles,
    masterKeyMismatch:
      (manifest.masterKeyFingerprint ?? "") !== masterKeyFingerprint(),
  };
}

// ---------------------------------------------------------------------------
// Auto-backup config + scheduler
// ---------------------------------------------------------------------------

export interface BackupConfig {
  enabled: boolean;
  frequency: "daily" | "weekly";
  hourUtc: number; // 0–23
  retention: number; // keep N most-recent
  lastRunAt: string | null;
  /** UTC date (YYYY-MM-DD) of the last ATTEMPT — the anchor that keeps a daily
   *  backup on its hour instead of drifting, and stops a failing one retrying
   *  every tick. Absent on configs written before this existed. */
  lastRunDate?: string | null;
  /** ISO week key (YYYY-Www) of the last attempt, for the weekly schedule. */
  lastRunWeek?: string | null;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  frequency: "daily",
  hourUtc: 3,
  retention: 7,
  lastRunAt: null,
  lastRunDate: null,
  lastRunWeek: null,
};

/** YYYY-MM-DD in UTC. */
export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** YYYY-Www (ISO week) in UTC — Monday-anchored, like the calendar. */
export function utcWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Shift to the Thursday of this week: ISO weeks are numbered by it.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function getBackupConfig(): Promise<BackupConfig> {
  const stored = await getSetting<Partial<BackupConfig>>(SETTING_KEYS.backup);
  return { ...DEFAULT_BACKUP_CONFIG, ...(stored ?? {}) };
}

export async function setBackupConfig(
  patch: Partial<BackupConfig>,
): Promise<BackupConfig> {
  const next = { ...(await getBackupConfig()), ...patch };
  await setSetting(SETTING_KEYS.backup, next);
  return next;
}

/**
 * Is a scheduled backup due now, given the config and the last attempt?
 *
 * Anchored on the CALENDAR, not on elapsed hours. The old rule was "at or after
 * the configured hour, and at least 20 hours since the last run", which meant
 * "daily at 03:00" actually ran every 20 hours: enable it at 10:00 and it fires
 * at 10:00, 06:00, 03:00 — then again at 23:00 the same day, because 20 hours
 * had passed and the hour floor was satisfied. It walked backwards through the
 * day on a six-day loop, landed in the middle of the working day, and "keep the
 * last 7" covered about six days. Once per UTC date (or ISO week) fixes it,
 * which is what `isReportDue` already does for the weekly email.
 */
export function isBackupDue(cfg: BackupConfig, now: Date): boolean {
  if (!cfg.enabled) return false;
  if (now.getUTCHours() < cfg.hourUtc) return false;
  if (cfg.frequency === "weekly") {
    return (cfg.lastRunWeek ?? null) !== utcWeekKey(now);
  }
  return (cfg.lastRunDate ?? null) !== utcDateKey(now);
}

let ticking = false;

async function schedulerTick(): Promise<void> {
  if (ticking) return;
  let cfg: BackupConfig;
  try {
    cfg = await getBackupConfig();
  } catch {
    return; // DB not ready yet — try again next tick
  }
  if (!isBackupDue(cfg, new Date())) return;

  ticking = true;
  const now = new Date();
  try {
    // Stamp the ATTEMPT before doing the work. Stamping only on success meant a
    // persistent failure (disk full, permissions, storage volume unmounted) was
    // still "due" on every 10-minute tick: a full database dump and a zip of the
    // whole storage tree, over and over, on a single-process instance serving
    // chats — plus an error row each time, and with alerts on, up to 12 emails
    // an hour, indefinitely. A failure now waits for the next window, and says
    // so in the log. Same policy as the weekly report.
    await setBackupConfig({
      lastRunAt: now.toISOString(),
      lastRunDate: utcDateKey(now),
      lastRunWeek: utcWeekKey(now),
    });
    await appLog("info", "backup", "Scheduled backup starting.");
    const info = await createBackup("auto");
    const pruned = await pruneBackups(cfg.retention);
    await appLog("info", "backup", `Scheduled backup complete: ${info.name}`, {
      details: { sizeBytes: info.sizeBytes, pruned },
    });
  } catch (e) {
    await appLog("error", "backup", "Scheduled backup failed.", {
      details: { error: e instanceof Error ? e.message : String(e) },
    });
  } finally {
    ticking = false;
  }
}

const TICK_MS = 10 * 60 * 1000;
const globalForScheduler = globalThis as unknown as {
  __oiBackupTimer?: NodeJS.Timeout;
};

/**
 * Start the in-process auto-backup scheduler. Called once from
 * `instrumentation.ts` at server boot (Node runtime only). A cheap 10-minute
 * tick checks whether a backup is due; the heavy lifting only runs when it is.
 */
export function startBackupScheduler(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalForScheduler.__oiBackupTimer) return; // survive dev hot-reload
  const timer = setInterval(() => void schedulerTick(), TICK_MS);
  timer.unref?.();
  globalForScheduler.__oiBackupTimer = timer;
  // A short delayed first check so a backup missed while the box was down runs
  // soon after boot rather than waiting a full tick.
  setTimeout(() => void schedulerTick(), 30_000).unref?.();
}
