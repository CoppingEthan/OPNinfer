/**
 * The artifact panel — what a file previews AS, pure and client-safe.
 *
 * The panel opens a file the assistant produced beside the conversation, so
 * you can read the thing while still reading the chat about it. Two rules
 * shape everything here:
 *
 * IMAGES ARE NEVER PREVIEWED (owner rule). They already render inline in the
 * reply, where they belong — an image is the answer, not an attachment to it.
 * Putting them in a side panel too would mean the same picture in two places,
 * one of them worse.
 *
 * AND A PREVIEW IS NOT A DOWNLOAD. Anything too big to read comfortably, or of
 * a kind a browser cannot show honestly, offers the download button instead of
 * pretending. Guessing wrong here means a spinner that never resolves.
 */

export type PreviewKind = "markdown" | "code" | "text" | "html" | "pdf" | "none";

/** Past this we hand over to Download rather than pull it into the browser.
 *  A preview is for reading; a 10 MB CSV is for a spreadsheet. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "bash", "zsh", "ps1",
  "sql", "json", "yml", "yaml", "toml", "ini", "xml", "css", "scss", "less",
  "r", "jl", "lua", "pl", "dockerfile", "makefile", "env", "conf",
]);

const TEXT_EXTENSIONS = new Set(["txt", "log", "csv", "tsv", "rtf", "srt", "vtt"]);

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  // "Dockerfile" and "Makefile" carry their type in the whole name.
  if (dot <= 0) return base.toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

/**
 * How to show this file, from the type the ingestion pipeline detected and the
 * name it was given. The mime type is checked first but not trusted alone:
 * `syncPool` registers everything the Sandbox writes as
 * `application/octet-stream`, so a real `report.md` arrives with no useful
 * type at all and only its name to go on.
 */
export function previewKind(mimeType: string | null | undefined, filename: string): PreviewKind {
  const mime = (mimeType ?? "").toLowerCase();
  const ext = extensionOf(filename);

  // Never, whatever the name says. Images belong inline in the reply.
  if (mime.startsWith("image/")) return "none";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"].includes(ext)) return "none";

  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "none";

  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (mime.startsWith("text/")) return "text";

  return "none";
}

/** Kinds whose bytes we pull into the page as a string. */
export function isTextual(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "code" || kind === "text";
}

/** Kinds the browser renders itself, in a sandboxed frame. */
export function isFramed(kind: PreviewKind): boolean {
  return kind === "html" || kind === "pdf";
}

/** Can this file be shown at all, at this size? */
export function canPreview(
  file: { mimeType?: string | null; filename: string; sizeBytes: number },
): boolean {
  const kind = previewKind(file.mimeType, file.filename);
  if (kind === "none") return false;
  // A framed kind streams, so size is the browser's problem, not ours.
  if (isFramed(kind)) return true;
  return file.sizeBytes <= MAX_PREVIEW_BYTES;
}

/** The Prism grammar for a filename, or null to render it plain. */
export function languageFor(filename: string): string | null {
  const ext = extensionOf(filename);
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
    cjs: "javascript", py: "python", rb: "ruby", sh: "bash", bash: "bash",
    zsh: "bash", json: "json", yml: "yaml", yaml: "yaml", css: "css",
    scss: "css", html: "markup", htm: "markup", xml: "markup", sql: "sql",
    md: "markdown", markdown: "markdown",
  };
  return map[ext] ?? null;
}

/** "5.6 KB". Bytes below a kilobyte read as bytes; nothing needs three decimals. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * The URL the panel reads, carrying the file's own version.
 *
 * `v` is what makes "it updated almost instantly" true: the browser caches an
 * in-page fetch by URL alone, so a re-presented file under the same id would
 * otherwise keep showing the old bytes until a reload — the exact bug that had
 * to be fixed for re-presented images.
 */
export function previewUrl(fileId: string, version?: string | number | null): string {
  const v = version == null ? "" : `?v=${encodeURIComponent(String(version))}`;
  return `/api/files/${fileId}/preview${v}`;
}
