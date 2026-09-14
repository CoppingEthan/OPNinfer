import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile, stat, unlink, rm, lstat, realpath } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Local disk storage for uploaded files. Every conversation owns a **storage
 * pool** — one directory holding the user's uploads and (later) files the
 * assistant generates, under human-readable names so the model can address
 * them by path:
 *   <root>/<tenant>/chats/<conversationId>/<name>.<ext>
 * A hidden `.opninfer/` subdirectory inside each pool holds the ingestion
 * worker's prepared artifacts (<fileId>.md / .meta.json) — never listed, never
 * re-ingested. Only relative paths are stored in the DB (`files.storage_path`).
 * Deleting a conversation deletes its whole pool from disk.
 */

export function storageRoot(): string {
  return resolve(process.env.OPNINFER_STORAGE_ROOT ?? "./storage");
}

function tenantId(): string {
  return process.env.OPNINFER_TENANT_ID ?? "default";
}

export function maxUploadBytes(): number {
  return Number(process.env.OPNINFER_MAX_UPLOAD_BYTES ?? 52_428_800); // 50 MB
}

/** Strip directory separators and control chars from a user-supplied name. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 180) || "file";
}

export interface StoredFile {
  /** Relative path from the storage root (stored in DB). */
  storagePath: string;
  /** The (possibly deduplicated) name the file lives under in the pool. */
  storedName: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Chat storage pools — one directory per conversation.
// ---------------------------------------------------------------------------

/** Reserved hidden subdir inside each pool for worker artifacts. */
export const POOL_ARTIFACT_DIR = ".opninfer";

function assertConversationId(id: string): void {
  // Pool dirs are named by conversation UUID; anything else is a bug or an
  // attempted traversal.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid conversation id for storage pool.");
  }
}

/**
 * Pool path relative to the storage root: <tenant>/chats/<conversationId>.
 * ALWAYS forward-slash — these relative paths go into the DB and are read by
 * the Linux ingestion worker, so they must not pick up Windows separators
 * from a Windows dev host.
 */
export function chatPoolRelDir(conversationId: string): string {
  assertConversationId(conversationId);
  return [tenantId(), "chats", conversationId].join("/");
}

/** Absolute pool directory for a conversation. */
export function chatPoolDir(conversationId: string): string {
  return join(storageRoot(), chatPoolRelDir(conversationId));
}

/**
 * Guarantee a conversation's pool directory exists, and return it.
 *
 * Uploads and `write_file` create it as a side effect of writing something.
 * Code execution does NOT — it only MOUNTS the directory — and in production
 * the sandbox mounts it as a named-volume **subpath**, which Docker refuses to
 * create for you. So a chat whose first sandbox action was `execute_command`
 * (a very natural opening move: "what tools do I have?") had nothing to mount,
 * the container could not start, and the sandbox was unusable for that chat.
 *
 * Dev never saw it: `STORAGE_HOST_ROOT` is a BIND mount, and Docker silently
 * creates a missing bind source. Identical chat, works locally, fails in prod.
 */
export async function ensureChatPool(conversationId: string): Promise<string> {
  const dir = chatPoolDir(conversationId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Per-conversation AGENT STATE directory (Sandbox tier) — the agent
 * container's `~/.claude`: its session transcripts, history and local config.
 *
 * Deliberately NOT inside the chat's pool: the pool is the user's visible
 * workspace and is listed to the model as "the files in this chat", so agent
 * transcripts living there would be both noise and a privacy oddity (the
 * agent reading its own memory as an attachment). Sibling tree instead.
 *
 * Per CONVERSATION, not shared, and that is the whole point: the CLI keys its
 * transcripts by working directory, and every agent container uses the same
 * `/workspace`, so ONE shared config dir would file every chat's history
 * under the same key — one person's work chat, another's private chat, in one
 * directory. Separate directory per chat, mounted per container.
 */
export function agentStateRelDir(conversationId: string): string {
  assertConversationId(conversationId);
  return [tenantId(), "agent", conversationId].join("/");
}

export function agentStateDir(conversationId: string): string {
  return join(storageRoot(), agentStateRelDir(conversationId));
}

/** Same contract as ensureChatPool, and the same production trap: in prod
 *  this is a named-volume SUBPATH, which Docker will not create for you. */
export async function ensureAgentStateDir(conversationId: string): Promise<string> {
  const dir = agentStateDir(conversationId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Filesystem-level containment check for a path that has already passed a
 * lexical guard (strip leading "/", reject "..", resolve, prefix-compare).
 *
 * The lexical guard is string arithmetic: `resolve` does not touch the disk and
 * does not follow symlinks. That is not enough here, because the sandbox mounts
 * the SAME pool directory read-write as the same uid the pool is owned by — so
 * code the model runs can leave a symlink in the pool, and a later host-side
 * `write_file`/`edit_file`/`delete_file` follows it out as the APP user. That
 * turns "the model ran some code in a locked-down container" into a write to
 * anywhere the app can reach: its own `/app` tree, another chat's pool, the
 * whole storage root.
 *
 * So: resolve symlinks for real, on the target if it exists and otherwise on
 * its deepest existing ancestor (which catches `link-to-elsewhere/newfile`),
 * and re-assert containment against the pool's own real path. A target that is
 * itself a symlink is refused outright even when it points back inside the
 * pool — nothing legitimate here needs one, so the safe answer is the simple
 * one.
 *
 * Returns null when the path is safe, or a model-facing error string.
 */
export async function poolContainmentError(
  poolDir: string,
  abs: string,
): Promise<string | null> {
  const ESCAPE = "Error: path escapes this conversation's files.";
  // If the pool itself is reached through a link (a bind mount, a moved
  // storage root), compare against where it really lives.
  const realPool = await realpath(poolDir).catch(() => resolve(poolDir));

  const inside = (p: string) => p === realPool || p.startsWith(realPool + sep);

  let link: boolean;
  try {
    link = (await lstat(abs)).isSymbolicLink();
  } catch {
    link = false; // doesn't exist yet — check the ancestor below
  }
  if (link) return ESCAPE;

  // Walk up to the deepest path that exists and resolve THAT. An intermediate
  // directory can be the link just as easily as the final component.
  let probe = abs;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) return inside(real) ? null : ESCAPE;
    const parent = dirname(probe);
    if (parent === probe) return ESCAPE; // ran out of path without finding one
    probe = parent;
  }
}

/** Thrown when a streamed upload exceeds the configured limit mid-flight. */
export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`File exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Pool files keep their human-readable names (the model addresses them by
 * path), so make the sanitized name safe for the pool: no leading dots (would
 * hide it / collide with `.opninfer`), never the artifact dir itself.
 */
function poolSafeName(filename: string): string {
  let safe = sanitizeFilename(filename).replace(/^\.+/, "");
  if (!safe || safe === POOL_ARTIFACT_DIR) safe = "file";
  return safe;
}

/** `report.pdf` → ["report", ".pdf"]; dotless names get an empty ext. */
function splitName(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/** Open a file for writing only if it doesn't exist; null on collision. */
function openExclusive(absPath: string): Promise<WriteStream | null> {
  return new Promise((resolvePromise, reject) => {
    const ws = createWriteStream(absPath, { flags: "wx" });
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") resolvePromise(null);
      else reject(err);
    });
  });
}

/**
 * Stream an upload into a conversation's pool, enforcing `maxBytes` while the
 * bytes flow (the whole point: a 100 MB file never sits in memory). Name
 * collisions dedupe as "name (2).ext". On overflow or failure the partial file
 * is removed and the error rethrown.
 */
export async function saveFileToPool(
  conversationId: string,
  filename: string,
  source: Readable,
  maxBytes: number,
): Promise<StoredFile> {
  const relDir = chatPoolRelDir(conversationId);
  const absDir = join(storageRoot(), relDir);
  await mkdir(absDir, { recursive: true });

  // Claim a non-colliding name atomically (open with `wx`, retry on EEXIST).
  const [base, ext] = splitName(poolSafeName(filename));
  let storedName = "";
  let out: WriteStream | null = null;
  for (let n = 1; out === null; n++) {
    storedName = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    if (n > 500) throw new Error("Could not find a free filename in the pool.");
    out = await openExclusive(join(absDir, storedName));
  }
  const relPath = `${relDir}/${storedName}`; // posix — stored in the DB
  const absPath = join(absDir, storedName);

  let written = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > maxBytes) cb(new UploadTooLargeError(maxBytes));
      else cb(null, chunk);
    },
  });

  try {
    await pipeline(source, meter, out);
  } catch (err) {
    await unlink(absPath).catch(() => {});
    throw err;
  }

  return { storagePath: relPath, storedName, sizeBytes: written };
}

/**
 * Persist assistant-generated bytes into a pool (used by later phases; small
 * payloads, so a Buffer is fine here).
 */
export async function saveBufferToPool(
  conversationId: string,
  filename: string,
  data: Buffer,
  maxBytes: number,
): Promise<StoredFile> {
  // NB: a *dynamic* `await import("node:stream")` resolves `Readable` to
  // undefined inside the Next webpack server bundle (works in a plain-Node
  // harness — which is why this bug only bit the real chat). Use the static
  // value import from the top of this file.
  return saveFileToPool(conversationId, filename, Readable.from(data), maxBytes);
}

/** Delete a conversation's entire pool (uploads + artifacts) from disk.
 *
 *  Never throws into a delete path — a chat must still disappear from the UI
 *  even if its bytes can't be removed — but it no longer fails SILENTLY: a
 *  permission error here means leaked disk that nothing else will ever clean
 *  up (the worker used to write root-owned artifacts the app couldn't remove).
 */
export async function deleteChatPool(conversationId: string): Promise<void> {
  try {
    await rm(chatPoolDir(conversationId), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[storage] could not fully delete the pool for conversation ${conversationId} — ` +
        `files are left on disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The agent's own state (transcripts, history) lives in a sibling tree, so
  // deleting a chat must delete BOTH or the conversation survives its own
  // deletion in the one place nobody thinks to look.
  try {
    await rm(agentStateDir(conversationId), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[storage] could not delete agent state for conversation ${conversationId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Remove the on-disk footprint of deleted conversations: each pool directory
 * plus every recorded storage path (covers legacy pre-pool layouts, where
 * files lived under <tenant>/<userId>/…). Callers capture ids + paths BEFORE
 * the DB cascade removes the `files` rows. Idempotent — double-deletes no-op.
 */
export async function purgeConversationStorage(
  convos: { id: string; files: { storagePath: string }[] }[],
): Promise<void> {
  for (const c of convos) {
    // Stop the agent container FIRST: it has this pool (and the agent-state
    // dir) mounted, and a container that outlives the directory keeps writing
    // to the unlinked inode (and holding the disk) until the idle reaper gets
    // to it — which for an incognito chat quietly breaks the promise that
    // leaving deletes everything. Imported lazily: this module is used by
    // paths that have nothing to do with the Sandbox.
    const { destroyAgentContainer } = await import("./agent/spawn");
    destroyAgentContainer(c.id);
    for (const f of c.files) await deleteStoredFile(f.storagePath);
    await deleteChatPool(c.id);
  }
}

/** Remove a deleted user's legacy per-user upload dir (<tenant>/<userId>). */
export async function deleteLegacyUserDir(userId: string): Promise<void> {
  // Same shape guard as pools: only UUID-named dirs, never "chats"/"branding".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return;
  }
  try {
    await rm(join(storageRoot(), tenantId(), userId), { recursive: true, force: true });
  } catch {
    /* never existed — ignore */
  }
}

/**
 * Resolve a stored relative path to an absolute one, guarding against path
 * traversal: the result MUST stay inside the storage root.
 */
export function resolveStoredPath(relPath: string): string {
  const root = storageRoot();
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error("Resolved path escapes the storage root.");
  }
  return abs;
}

/**
 * Resolve a stored path for READING, refusing symlinks (audit 2026-09-05).
 *
 * `resolveStoredPath` is string arithmetic — it never follows a link. The
 * Sandbox mounts each pool read-write as the same uid, so code the model runs
 * can replace an upload with `ln -s /proc/self/environ report.pdf` (or a link
 * into another chat's pool); the host-side reads — the download route, the
 * `read_file raw` tool, vision and image-edit sources — then streamed
 * whatever the link pointed at AS THE APP: its own environment (the master
 * key, the database URL, AUTH_SECRET) or another user's file. `pool-sync`
 * refuses to CREATE a row for a link, but an existing row's file can be
 * swapped for one after the fact.
 *
 * The rule: the real path must equal the real storage root plus the lexical
 * remainder — i.e. no component below the root may be a link. Throws
 * (ENOENT or a containment error) when it can't be satisfied; callers treat
 * both as "missing".
 */
export async function resolveStoredPathForRead(relPath: string): Promise<string> {
  const root = storageRoot();
  const abs = resolveStoredPath(relPath);
  const realRoot = await realpath(root).catch(() => resolve(root));
  const real = await realpath(abs); // ENOENT if missing — same as before
  const expected = join(realRoot, relative(resolve(root), abs));
  if (real !== expected) {
    throw new Error("Stored path goes through a symbolic link — refused.");
  }
  return real;
}

/** A read stream over a stored file, symlink-safe. Throws when missing. */
export async function readFileStream(relPath: string): Promise<NodeJS.ReadableStream> {
  return createReadStream(await resolveStoredPathForRead(relPath));
}

export async function fileExists(relPath: string): Promise<boolean> {
  try {
    await stat(resolveStoredPath(relPath));
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredFile(relPath: string): Promise<void> {
  try {
    await unlink(resolveStoredPath(relPath));
  } catch {
    /* already gone — ignore */
  }
}

// ---------------------------------------------------------------------------
// Branding assets (logo, model icons). Tenant-scoped, served publicly via
// /api/branding/[name] so the logo is visible on the login screen too.
// ---------------------------------------------------------------------------

const BRANDING_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

export function brandingMime(name: string): string | null {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return BRANDING_MIME[ext] ?? null;
}

function brandingDir(): string {
  return join(storageRoot(), process.env.OPNINFER_TENANT_ID ?? "default", "branding");
}

/** Persist a branding asset under a generated name; returns the bare filename. */
export async function saveBrandingAsset(
  ext: string,
  data: Buffer,
): Promise<string> {
  const safeExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const name = `${randomUUID()}${safeExt}`;
  await mkdir(brandingDir(), { recursive: true });
  await writeFile(join(brandingDir(), name), data);
  return name;
}

/** Resolve a branding asset name to an absolute path, guarding traversal. */
export function brandingAssetPath(name: string): string {
  const safe = sanitizeFilename(name);
  const abs = resolve(brandingDir(), safe);
  if (!abs.startsWith(brandingDir() + sep)) {
    throw new Error("Resolved path escapes the branding directory.");
  }
  return abs;
}

export async function brandingAssetExists(name: string): Promise<boolean> {
  try {
    await stat(brandingAssetPath(name));
    return true;
  } catch {
    return false;
  }
}

export async function deleteBrandingAsset(name: string): Promise<void> {
  try {
    await unlink(brandingAssetPath(name));
  } catch {
    /* already gone — ignore */
  }
}

// ---------------------------------------------------------------------------
// Avatar assets (per-user profile pictures). Stored like branding assets but in
// their own directory; served via /api/avatar/[name] (auth-gated, not public).
// The bare filename is stored on `users.image`.
// ---------------------------------------------------------------------------

function avatarDir(): string {
  return join(storageRoot(), process.env.OPNINFER_TENANT_ID ?? "default", "avatars");
}

/** Same extension → MIME map as branding (images only). */
export function avatarMime(name: string): string | null {
  return brandingMime(name);
}

/** Persist an avatar image under a generated name; returns the bare filename. */
export async function saveAvatarAsset(ext: string, data: Buffer): Promise<string> {
  const safeExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const name = `${randomUUID()}${safeExt}`;
  await mkdir(avatarDir(), { recursive: true });
  await writeFile(join(avatarDir(), name), data);
  return name;
}

/** Resolve an avatar name to an absolute path, guarding traversal. */
export function avatarAssetPath(name: string): string {
  const safe = sanitizeFilename(name);
  const abs = resolve(avatarDir(), safe);
  if (!abs.startsWith(avatarDir() + sep)) {
    throw new Error("Resolved path escapes the avatar directory.");
  }
  return abs;
}

export async function avatarAssetExists(name: string): Promise<boolean> {
  try {
    await stat(avatarAssetPath(name));
    return true;
  } catch {
    return false;
  }
}

export async function deleteAvatarAsset(name: string): Promise<void> {
  try {
    await unlink(avatarAssetPath(name));
  } catch {
    /* already gone — ignore */
  }
}
