import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/hash";
import { appendToTopic } from "@/lib/tools/memory";
import { strictlyIncreasing } from "@/lib/thread-order";

/**
 * Open WebUI → OPNinfer migration importer.
 *
 * Reads an uploaded OWUI `webui.db` (SQLite) and imports:
 *   - users   → OPNinfer users, created with a RANDOM password and a verified
 *               email. Migrated users regain access via "Forgot password"
 *               (self-service — requires SMTP on the instance). Everyone is
 *               imported as a regular `user`; promote admins by hand.
 *   - chats   → conversations + messages. OWUI chats branch (edit/regenerate
 *               create siblings); we import the ACTIVE branch — the walk from
 *               `history.currentId` up to the root — which is exactly the
 *               thread the user saw. Original ids and timestamps preserved,
 *               so re-importing the same backup is a no-op (idempotent).
 *   - memory  → user_memories rows (deduped by identical content).
 *
 * NOT imported: file attachments (OWUI file storage doesn't map onto per-chat
 * pools; message text referencing them survives), folders/tags, model configs,
 * prompts, tools. Counted in the summary so nothing disappears silently.
 */

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

type OwuiHistoryMessage = {
  id?: string;
  parentId?: string | null;
  role?: string;
  content?: unknown;
  timestamp?: number;
  model?: string;
  models?: string[];
  files?: unknown[];
};

export type OwuiLinearMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  model?: string;
  hadFiles: boolean;
};

/** OWUI stores unix timestamps in seconds (occasionally ms). */
export function owuiDate(value: unknown): Date | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n >= 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Strip OWUI presentation wrappers the model never wrote as prose:
 * `<details type="reasoning">…</details>` (thinking) and similar
 * details-wrapped tool/citation blocks. Plain text passes through.
 */
export function cleanOwuiContent(raw: string): string {
  let out = raw.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "");
  // Collapse the blank runs the removals leave behind.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/**
 * Flatten one OWUI chat JSON into the linear, visible thread.
 *
 * Preferred source: `history.messages` (a dict keyed by message id, each with
 * `parentId`) + `history.currentId` (the leaf of the active branch) — walk
 * leaf → root, then reverse. Falls back to the newest-timestamp leaf when
 * `currentId` is missing, and to the legacy linear `messages` array when
 * there's no history at all.
 */
export function linearizeOwuiChat(chatJson: unknown): OwuiLinearMessage[] {
  const cj = chatJson as
    | {
        history?: {
          messages?: Record<string, OwuiHistoryMessage>;
          currentId?: string;
        };
        messages?: OwuiHistoryMessage[];
      }
    | null
    | undefined;

  const dict = cj?.history?.messages;
  let ordered: OwuiHistoryMessage[] = [];

  if (dict && typeof dict === "object" && Object.keys(dict).length > 0) {
    let leafId =
      typeof cj?.history?.currentId === "string" && dict[cj.history.currentId]
        ? cj.history.currentId
        : undefined;
    if (!leafId) {
      // No currentId — take the newest message as the active leaf.
      leafId = Object.keys(dict).reduce((best, id) =>
        (dict[id]?.timestamp ?? 0) > (dict[best]?.timestamp ?? 0) ? id : best,
      );
    }
    const seen = new Set<string>();
    let cursor: string | null | undefined = leafId;
    while (cursor && dict[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      ordered.unshift(dict[cursor]);
      cursor = dict[cursor].parentId;
    }
  } else if (Array.isArray(cj?.messages)) {
    ordered = cj.messages;
  }

  const out: OwuiLinearMessage[] = [];
  for (const m of ordered) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    if (typeof m.content !== "string") continue;
    const content = cleanOwuiContent(m.content);
    if (!content) continue;
    out.push({
      id: typeof m.id === "string" ? m.id : undefined,
      role: m.role,
      content,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      model:
        typeof m.model === "string" && m.model
          ? m.model
          : Array.isArray(m.models) && typeof m.models[0] === "string"
            ? m.models[0]
            : undefined,
      hadFiles: Array.isArray(m.files) && m.files.length > 0,
    });
  }
  return out;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_RE.test(value)
    ? value.toLowerCase()
    : undefined;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export type OwuiImportSummary = {
  usersCreated: number;
  usersMatched: number;
  usersSkipped: number;
  chatsImported: number;
  chatsSkippedExisting: number;
  chatsEmpty: number;
  chatsUnknownOwner: number;
  archivedIncluded: number;
  messagesImported: number;
  memoriesImported: number;
  memoriesSkipped: number;
  attachmentsNotImported: number;
  /** For harness cleanup / auditing. */
  createdUserIds: string[];
  importedConversationIds: string[];
};

type OwuiUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  created_at: number | null;
  last_active_at: number | null;
};

type OwuiChatRow = {
  id: string;
  user_id: string;
  title: string | null;
  archived: number | null;
  pinned: number | null;
  created_at: number | null;
  updated_at: number | null;
  chat: string | null;
};

type OwuiMemoryRow = {
  user_id: string;
  content: string | null;
  created_at: number | null;
};

/** Import an OWUI `webui.db` at `dbPath` into this instance. */
export async function importOwuiBackup(
  dbPath: string,
): Promise<OwuiImportSummary> {
  const summary: OwuiImportSummary = {
    usersCreated: 0,
    usersMatched: 0,
    usersSkipped: 0,
    chatsImported: 0,
    chatsSkippedExisting: 0,
    chatsEmpty: 0,
    chatsUnknownOwner: 0,
    archivedIncluded: 0,
    messagesImported: 0,
    memoriesImported: 0,
    memoriesSkipped: 0,
    attachmentsNotImported: 0,
    createdUserIds: [],
    importedConversationIds: [],
  };

  // ---- read everything we need out of the SQLite file, then close it ----
  let users: OwuiUserRow[];
  let chats: OwuiChatRow[];
  let memories: OwuiMemoryRow[];
  const sdb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (
        sdb
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    if (!tables.has("user") || !tables.has("chat")) {
      throw new Error(
        "This doesn't look like an Open WebUI database (no user/chat tables). Upload the webui.db file from an OWUI backup.",
      );
    }
    users = sdb
      .prepare(
        "SELECT id, name, email, role, created_at, last_active_at FROM user",
      )
      .all() as OwuiUserRow[];
    chats = sdb
      .prepare(
        "SELECT id, user_id, title, archived, pinned, created_at, updated_at, chat FROM chat",
      )
      .all() as OwuiChatRow[];
    memories = tables.has("memory")
      ? (sdb
          .prepare("SELECT user_id, content, created_at FROM memory")
          .all() as OwuiMemoryRow[])
      : [];
  } finally {
    sdb.close();
  }

  // ---- users: match by email (case-insensitive) or create ----
  const userIdMap = new Map<string, string>(); // owui id -> opninfer id
  for (const u of users) {
    const email = u.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      summary.usersSkipped++;
      continue;
    }
    const existing = await db.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing) {
      userIdMap.set(u.id, existing.id);
      summary.usersMatched++;
      continue;
    }
    // Random password nobody knows — the user resets it via "Forgot password".
    // Email is marked verified (they were live OWUI users) so production
    // doesn't block the login after the reset.
    const created = await db.user.create({
      data: {
        email,
        name: u.name?.trim() || null,
        role: "user",
        passwordHash: await hashPassword(randomBytes(32).toString("hex")),
        emailVerified: new Date(),
        createdAt: owuiDate(u.created_at) ?? new Date(),
        lastActiveAt: owuiDate(u.last_active_at) ?? null,
      },
      select: { id: true },
    });
    userIdMap.set(u.id, created.id);
    summary.usersCreated++;
    summary.createdUserIds.push(created.id);
  }

  // ---- chats: skip ids that already exist (idempotent re-import) ----
  const candidateIds = chats
    .map((c) => asUuid(c.id))
    .filter((v): v is string => !!v);
  const existingIds = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += 500) {
    const found = await db.conversation.findMany({
      where: { id: { in: candidateIds.slice(i, i + 500) } },
      select: { id: true },
    });
    for (const f of found) existingIds.add(f.id);
  }

  const restoreUpdatedAt: { id: string; at: Date }[] = [];
  for (const c of chats) {
    const ownerId = userIdMap.get(c.user_id);
    if (!ownerId) {
      summary.chatsUnknownOwner++;
      continue;
    }
    const convId = asUuid(c.id) ?? randomUUID();
    if (existingIds.has(convId)) {
      summary.chatsSkippedExisting++;
      continue;
    }

    let chatJson: unknown = null;
    try {
      chatJson = c.chat ? JSON.parse(c.chat) : null;
    } catch {
      /* unreadable chat JSON → treated as empty below */
    }
    const thread = linearizeOwuiChat(chatJson);
    if (thread.length === 0) {
      summary.chatsEmpty++;
      continue;
    }

    const createdAt =
      owuiDate(c.created_at) ?? owuiDate(thread[0]?.timestamp) ?? new Date();
    const updatedAt = owuiDate(c.updated_at) ?? createdAt;

    await db.conversation.create({
      data: {
        id: convId,
        userId: ownerId,
        title: c.title?.trim() || "Imported chat",
        pinned: c.pinned === 1,
        createdAt,
      },
    });
    // Never store two rows of one chat at the same instant: OWUI stamps a
    // question and its answer with the same SECOND, and a tie is broken by
    // whatever the database's sort happens to do that day (thread-order.ts).
    const stamps = strictlyIncreasing(
      thread.map((m, i) => owuiDate(m.timestamp) ?? new Date(createdAt.getTime() + i * 1000)),
    );
    await db.message.createMany({
      data: thread.map((m, i) => {
        // Always mint fresh message ids: OWUI reuses message ids across
        // cloned/shared chats, and ours are a global primary key (found live
        // on the real backup). Idempotency rides on the CONVERSATION id.
        if (m.hadFiles) summary.attachmentsNotImported++;
        return {
          id: randomUUID(),
          conversationId: convId,
          role: m.role,
          content: m.content,
          // The author of a user turn (v0.5 shared chats). The migration
          // back-filled every pre-existing row, so NULL now means "the
          // account is gone" and renders as "Former member" — which is what
          // an imported chat would show for its OWNER's own messages the
          // moment they shared it, with no way back short of SQL (a re-import
          // skips chats it already has). Assistant turns carry no author.
          userId: m.role === "user" ? ownerId : null,
          model: m.role === "assistant" ? (m.model ?? null) : null,
          meta: { imported: "owui" },
          // Keep original timing; fall back to a stable in-thread order.
          createdAt: stamps[i],
        };
      }),
    });
    restoreUpdatedAt.push({ id: convId, at: updatedAt });
    summary.chatsImported++;
    summary.messagesImported += thread.length;
    if (c.archived === 1) summary.archivedIncluded++;
    summary.importedConversationIds.push(convId);
  }

  // Prisma stamps @updatedAt on create — put the real OWUI activity times
  // back so the sidebar sorts imported chats correctly (same trick as
  // backup-restore).
  for (const r of restoreUpdatedAt) {
    await db.$executeRaw`UPDATE conversations SET updated_at = ${r.at} WHERE id = ${r.id}::uuid`;
  }

  // ---- memories ----
  for (const m of memories) {
    const ownerId = userIdMap.get(m.user_id);
    const content = m.content?.trim();
    if (!ownerId || !content) {
      summary.memoriesSkipped++;
      continue;
    }
    // Memory v2: OWUI memories are one-liners; they land in the person's
    // "About you" note (lines the note already has are skipped) and the next
    // idle-chat pass sorts them into the right notes.
    const before = (await db.userMemoryTopic.findUnique({
      where: { userId_key: { userId: ownerId, key: "about" } },
      select: { text: true },
    }))?.text ?? "";
    await appendToTopic(ownerId, "about", [content]);
    const after = (await db.userMemoryTopic.findUnique({
      where: { userId_key: { userId: ownerId, key: "about" } },
      select: { text: true },
    }))?.text ?? "";
    if (after === before) {
      summary.memoriesSkipped++;
      continue;
    }
    summary.memoriesImported++;
  }

  return summary;
}
