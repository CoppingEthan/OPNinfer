import "server-only";
import { readFile } from "node:fs/promises";
import { db } from "./db";
import { resolveStoredPathForRead } from "./storage";
import { formatBytes } from "./format";
import { prepareImageForEdit, prepareImageForVision, VISION_MIMES } from "./image-vision";
import type { ImagePart, ToolDef } from "./providers/types";
import type { SourceRef, ToolOutput } from "./tools/types";

/**
 * The assistant's window onto a conversation's storage pool (token-efficiency
 * core): every turn gets a compact MANIFEST of the chat's files, and the model
 * pulls prepared content on demand via `read_file` — the map first, the
 * content only when needed, never a blind dump.
 */

/** One read_file page — keeps a single tool result comfortably bounded. */
const PAGE_CHARS = 12_000;

/** Largest file `read_file(raw: true)` will pull into memory whole. Anything
 *  bigger is a job for the sandbox (grep/sed/head), not for a 12k page. */
const MAX_RAW_READ_BYTES = 8 * 1024 * 1024;
/** Native-vision guardrails. Attached/viewed images AND image_edit/blend
 *  sources are DOWNSCALED before they're sent to the model (see
 *  image-vision.ts), so the guard is a generous SOURCE cap — we read + shrink
 *  files up to this, rather than rejecting big uploads. */
const MAX_VISION_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 6;

export const FILE_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description:
      "List the files in this conversation's storage pool with status, type, size and metadata. Use when you need to re-check what files exist.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description:
      "Read a file from this conversation's storage pool. Default: the PREPARED content (markdown/transcript/schema — token-efficient). Pass raw=true for the file's exact text bytes. Content is paged; call again with the next page number if truncated.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact filename from the manifest." },
        page: {
          type: "number",
          description: "1-based page (default 1).",
        },
        raw: {
          type: "boolean",
          description: "Read the file's exact text instead of the prepared version.",
        },
      },
      required: ["name"],
    },
  },
];

type FileRow = {
  id: string;
  filename: string;
  sizeBytes: bigint;
  status: string;
  processorGroup: string | null;
  contentPath: string | null;
  meta: unknown;
  tokenEstimate: number | null;
  mimeType: string;
  detectedMime: string | null;
  storagePath: string;
  kind: string;
};

function poolFiles(conversationId: string): Promise<FileRow[]> {
  return db.file.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  }) as unknown as Promise<FileRow[]>;
}

/** One compact human line of metadata (dimensions, sheets, duration, …). */
function metaSummary(row: FileRow): string {
  const m = (row.meta ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (m.width && m.height) bits.push(`${m.width}×${m.height}`);
  if (m.durationSeconds) bits.push(`${m.durationSeconds}s`);
  if (m.videoCodec) bits.push(String(m.videoCodec));
  if (m.language) bits.push(String(m.language));
  if (Array.isArray(m.sheets)) {
    bits.push(
      (m.sheets as { name: string; rows: number }[])
        .map((s) => `${s.name} (${s.rows} rows)`)
        .join(", "),
    );
  }
  if (Array.isArray(m.tables)) {
    bits.push(
      `tables: ${(m.tables as { name: string }[]).map((t) => t.name).join(", ")}`,
    );
  }
  if (m.rows && !Array.isArray(m.sheets)) bits.push(`${m.rows} rows`);
  if (m.lines) bits.push(`${m.lines} lines`);
  if (m.note) bits.push(String(m.note));
  return bits.join(" · ");
}

/** Total chars of file content inlined into the manifest each turn (~6k
 *  tokens). Newest files get the budget first; the rest fall back to
 *  read_file. Admin-tunable later via a setting if needed. */
const MANIFEST_CONTENT_BUDGET_CHARS = Number(
  process.env.MANIFEST_CONTENT_BUDGET_CHARS ?? 24_000,
);
/** Below this many remaining chars, don't bother inlining a truncated head. */
const MIN_INLINE_CHARS = 400;

/**
 * How much of a file's content to inline given the budget left (pure — the
 * allocation rule, unit-tested). Full if it fits; a truncated head if there's
 * a meaningful chunk of budget left; nothing otherwise (→ read_file).
 */
export function planInlineTake(contentLength: number, remainingBudget: number): number {
  if (remainingBudget <= 0) return 0;
  if (contentLength <= remainingBudget) return contentLength;
  if (remainingBudget >= MIN_INLINE_CHARS) return remainingBudget;
  return 0;
}

/** Content-status suffix for a manifest line, given whether/how it's inlined. */
function manifestLine(row: FileRow, inline?: { truncated: boolean }): string {
  const type = row.processorGroup ?? row.detectedMime ?? row.mimeType;
  const size = formatBytes(Number(row.sizeBytes));
  const parts = [`- ${row.filename} — ${type}, ${size}`];
  if (row.kind === "generated") parts.push("(assistant-generated)");
  const summary = metaSummary(row);
  if (summary) parts.push(`· ${summary}`);
  if (row.status === "pending" || row.status === "processing") {
    parts.push("· still being prepared — content not readable yet");
  } else if (row.status === "failed") {
    parts.push("· preparation failed — stored, but no readable content");
  } else if (inline?.truncated) {
    parts.push("· content below (truncated — read_file for the full text)");
  } else if (inline) {
    parts.push("· content below");
  } else if (row.contentPath) {
    parts.push(`· ~${row.tokenEstimate ?? "?"} tokens via read_file`);
  } else if (row.processorGroup === "image") {
    parts.push("· image — shown to you directly (view_image to re-examine)");
  } else {
    parts.push("· metadata only, no readable content");
  }
  return parts.join(" ");
}

/**
 * The per-turn system block describing the pool. Readable files' prepared
 * content is inlined DIRECTLY (newest first, up to a token budget) so the
 * model knows what's attached without a tool round-trip; larger files are
 * truncated with a read_file fallback, and files past the budget stay
 * metadata-only. Images ride the turn natively (vision). Null when the chat
 * has no files (zero token cost on file-less chats).
 */
export async function buildFileManifest(
  conversationId: string,
): Promise<string | null> {
  const rows = await poolFiles(conversationId);
  if (rows.length === 0) return null;

  // Allocate the inline-content budget newest-first (recent attachments win),
  // reading each candidate's prepared content until the budget is spent.
  const inline = new Map<string, { text: string; truncated: boolean }>();
  let budget = MANIFEST_CONTENT_BUDGET_CHARS;
  for (const row of [...rows].reverse()) {
    if (budget <= 0) break;
    if (!row.contentPath) continue; // images / metadata-only
    if (row.status === "pending" || row.status === "processing" || row.status === "failed") continue;
    let content: string;
    try {
      content = await readFile(await resolveStoredPathForRead(row.contentPath), "utf8");
    } catch {
      continue;
    }
    const take = planInlineTake(content.length, budget);
    if (take <= 0) continue;
    inline.set(row.id, { text: content.slice(0, take), truncated: take < content.length });
    budget -= take;
  }

  const header =
    "FILES: this conversation has a private storage pool with the user's " +
    "uploaded files. Each readable file's content is included INLINE below " +
    "(newest first, up to a budget) — answer from it directly, don't guess. " +
    "Larger files are truncated and some may be listed without content; call " +
    "`read_file` with the exact name for a file's full text (it's paged), and " +
    "`list_files` to refresh. Images are shown to you directly (view_image to " +
    "re-examine). Large tabular files are summarised as schema + samples.";

  const blocks = rows.map((row) => {
    const line = manifestLine(row, inline.get(row.id));
    const inl = inline.get(row.id);
    if (!inl) return line;
    const tail = inl.truncated
      ? `\n… [truncated — call read_file("${row.filename}") for the full text]`
      : "";
    return `${line}\n--- content of ${row.filename} ---\n${inl.text}${tail}\n--- end of ${row.filename} ---`;
  });

  return `${header}\n${blocks.join("\n")}`;
}

/** A read file becomes a user-visible "source" under the reply — clicking it
 *  opens the same context viewer as the chip (what the model actually read). */
function fileSource(row: { id: string; filename: string }): SourceRef[] {
  return [{ kind: "file", fileId: row.id, url: `/api/files/${row.id}`, title: row.filename }];
}

/** Execute a file tool call; ownership is enforced via the conversation id. */
export async function executeFileTool(
  conversationId: string,
  name: string,
  argsJson: string,
): Promise<string | ToolOutput> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "Error: tool arguments were not valid JSON.";
  }

  if (name === "list_files") {
    const rows = await poolFiles(conversationId);
    if (rows.length === 0) return "The storage pool is empty.";
    return rows.map((r) => manifestLine(r)).join("\n");
  }

  if (name === "read_file") {
    const target = String(args.name ?? "");
    const page = Math.max(1, Math.trunc(Number(args.page ?? 1)) || 1);
    const rows = await poolFiles(conversationId);
    const row = rows.find((r) => r.filename === target);
    if (!row) {
      const names = rows.map((r) => r.filename).join(", ") || "(none)";
      return `Error: no file named "${target}" in this conversation. Available: ${names}`;
    }
    // raw=true: the file's exact text (what edit_file operates on).
    if (args.raw === true) {
      // Bound it: every other path that touches upload bytes has a cap, this
      // one had none. A 200 MB log meant a 200 MB buffer plus a ~400 MB UTF-16
      // string in a single-process app that is streaming other people's
      // replies, all to return one 12k page.
      if (Number(row.sizeBytes) > MAX_RAW_READ_BYTES) {
        return `Error: "${target}" is ${formatBytes(Number(row.sizeBytes))} — too large to read raw. Use the prepared content, or process it with execute_command (grep/sed/head).`;
      }
      let rawContent: string;
      try {
        const buf = await readFile(await resolveStoredPathForRead(row.storagePath));
        if (buf.includes(0)) {
          return `Error: "${target}" is binary (${row.mimeType}) — raw text read isn't possible. Use the prepared content or execute_command.`;
        }
        rawContent = buf.toString("utf8");
      } catch {
        return `Error: "${target}" is missing from storage.`;
      }
      const rawPages = Math.max(1, Math.ceil(rawContent.length / PAGE_CHARS));
      const rawClamped = Math.min(page, rawPages);
      const rawSlice = rawContent.slice((rawClamped - 1) * PAGE_CHARS, rawClamped * PAGE_CHARS);
      const rawHeader =
        rawPages > 1
          ? `[${target} RAW — page ${rawClamped} of ${rawPages}. Call again with page=${rawClamped + 1} for more.]\n\n`
          : "";
      return { text: rawHeader + rawSlice, sources: fileSource(row) };
    }
    if (row.status === "pending" || row.status === "processing") {
      return `"${target}" is still being prepared — try again shortly.`;
    }
    if (!row.contentPath) {
      const summary = metaSummary(row) || "no further metadata";
      return (
        `"${target}" has no readable text content (${row.processorGroup ?? "unsupported"}). ` +
        `Metadata: ${summary}. Size: ${formatBytes(Number(row.sizeBytes))}.`
      );
    }
    let content: string;
    try {
      content = await readFile(await resolveStoredPathForRead(row.contentPath), "utf8");
    } catch {
      return `Error: prepared content for "${target}" is missing from storage.`;
    }
    const pages = Math.max(1, Math.ceil(content.length / PAGE_CHARS));
    const clamped = Math.min(page, pages);
    const slice = content.slice((clamped - 1) * PAGE_CHARS, clamped * PAGE_CHARS);
    const header =
      pages > 1
        ? `[${target} — page ${clamped} of ${pages}. Call read_file with page=${clamped + 1} for more.]\n\n`
        : "";
    return { text: header + slice, sources: fileSource(row) };
  }

  return `Error: unknown tool "${name}".`;
}

/**
 * Load ONE image from this conversation's pool DOWNSCALED for vision (the
 * view_image tool). Big photos are shrunk to a vision-sized image before
 * inlining — cheaper tokens, and files past the raw inline cap still reach the
 * model. Ownership is implicit (lookup scoped to the conversation).
 */
export async function loadImageForVision(
  conversationId: string,
  name: string,
): Promise<ImagePart | string> {
  const rows = await poolFiles(conversationId);
  const row = rows.find((r) => r.filename === name);
  if (!row) {
    const images = rows
      .filter((r) => VISION_MIMES.has((r.detectedMime ?? r.mimeType).toLowerCase()))
      .map((r) => r.filename)
      .join(", ");
    return `Error: no file named "${name}" here. Images available: ${images || "(none)"}.`;
  }
  const mime = (row.detectedMime ?? row.mimeType).toLowerCase();
  if (!VISION_MIMES.has(mime)) {
    return `Error: "${name}" is ${mime} — not a viewable image format (png/jpeg/gif/webp).`;
  }
  if (Number(row.sizeBytes) > MAX_VISION_SOURCE_BYTES) {
    return `Error: "${name}" is too large to view (${formatBytes(Number(row.sizeBytes))}).`;
  }
  try {
    const data = await readFile(await resolveStoredPathForRead(row.storagePath));
    return await prepareImageForVision(data, mime);
  } catch {
    return `Error: "${name}" is missing from storage.`;
  }
}

/**
 * Load ONE image from this conversation's pool as an image_edit/blend SOURCE,
 * DOWNSCALED to the tier matching the requested output quality ("max" → the
 * higher-res pro profile, else normal — see image-vision.ts). The on-disk
 * upload is left at full resolution; only the copy sent to Gemini is shrunk,
 * so cost stays down and big phone photos are editable instead of rejected.
 * Ownership is implicit — lookup is scoped to the conversation. Returns an
 * error string on any miss so the model can react.
 */
export async function loadImageByName(
  conversationId: string,
  name: string,
  quality: "standard" | "max" = "standard",
): Promise<ImagePart | string> {
  const rows = await poolFiles(conversationId);
  const row = rows.find((r) => r.filename === name);
  if (!row) {
    const images = rows
      .filter((r) => VISION_MIMES.has((r.detectedMime ?? r.mimeType).toLowerCase()))
      .map((r) => r.filename)
      .join(", ");
    return `Error: no file named "${name}" here. Images available: ${images || "(none)"}.`;
  }
  const mime = (row.detectedMime ?? row.mimeType).toLowerCase();
  if (!VISION_MIMES.has(mime)) {
    return `Error: "${name}" is ${mime} — not an editable image format (png/jpeg/gif/webp).`;
  }
  if (Number(row.sizeBytes) > MAX_VISION_SOURCE_BYTES) {
    return `Error: "${name}" is too large to edit (${formatBytes(Number(row.sizeBytes))}; limit ${formatBytes(MAX_VISION_SOURCE_BYTES)}).`;
  }
  try {
    const data = await readFile(await resolveStoredPathForRead(row.storagePath));
    return await prepareImageForEdit(data, mime, quality);
  } catch {
    return `Error: "${name}" is missing from storage.`;
  }
}

/**
 * Load the current turn's attached images as native-vision parts (bounded in
 * count + size; only web-safe raster formats every provider accepts).
 */
export async function loadImagesForTurn(
  conversationId: string,
  fileIds: string[] | undefined,
): Promise<ImagePart[]> {
  if (!fileIds?.length) return [];
  const rows = (await db.file.findMany({
    where: { id: { in: fileIds }, conversationId },
  })) as unknown as FileRow[];

  const images: ImagePart[] = [];
  for (const row of rows) {
    const mime = (row.detectedMime ?? row.mimeType).toLowerCase();
    if (!VISION_MIMES.has(mime)) continue;
    // Downscaled before inlining, so the guard is a generous SOURCE cap — big
    // camera photos are shrunk to a vision-sized image rather than dropped.
    if (Number(row.sizeBytes) > MAX_VISION_SOURCE_BYTES) continue;
    if (images.length >= MAX_IMAGES_PER_TURN) break;
    try {
      const data = await readFile(await resolveStoredPathForRead(row.storagePath));
      images.push(await prepareImageForVision(data, mime));
    } catch {
      /* file missing — skip */
    }
  }
  return images;
}
