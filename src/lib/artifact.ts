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

export type PreviewKind =
  | "markdown"
  | "code"
  | "text"
  /** Comma/tab separated — rendered as a table rather than as lines. */
  | "csv"
  | "html"
  /** Vector art. Framed like HTML rather than treated as an image: it is never
   *  rendered inline in a reply, so there is nothing to duplicate, and it is
   *  usually the deliverable rather than an illustration. */
  | "svg"
  | "pdf"
  /**
   * Word, Excel, PowerPoint, OpenDocument, iWork. Converted to PDF by the
   * Gotenberg/LibreOffice container the ingestion pipeline already uses, so it
   * previews with the REAL layout rather than as extracted text. Framed,
   * because what comes back is a PDF.
   */
  | "office"
  /**
   * A format no browser can render and LibreOffice cannot lay out either — a
   * .zip, an .eml, an .epub. The ingestion worker already turned these into
   * text when they were uploaded, so the panel shows that, labelled as a
   * conversion rather than passed off as the document.
   */
  | "converted"
  | "none";

/** Past this we hand over to Download rather than pull it into the browser.
 *  A preview is for reading; a 10 MB CSV is for a spreadsheet. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "bash", "zsh", "ps1",
  "sql", "json", "yml", "yaml", "toml", "ini", "xml", "css", "scss", "less",
  "r", "jl", "lua", "pl", "dockerfile", "makefile", "env", "conf",
]);

const TEXT_EXTENSIONS = new Set(["txt", "log", "rtf", "srt", "vtt"]);
const TABLE_EXTENSIONS = new Set(["csv", "tsv"]);

/** Anything LibreOffice can lay out. Gotenberg turns these into a PDF, so they
 *  preview exactly as the office suite would draw them. */
const OFFICE_EXTENSIONS = new Set([
  "docx", "doc", "dot", "xlsx", "xls", "pptx", "ppt", "pps",
  "odt", "ods", "odp", "rtf", "pages", "numbers", "key", "wpd",
]);

/** Formats neither a browser nor LibreOffice can lay out, but the ingestion
 *  worker turned into text. Mirrors the worker's five-group routing map. */
const CONVERTIBLE_EXTENSIONS = new Set(["epub", "zip", "eml", "msg", "mbox"]);

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

  // SVG first: it is an image/* type but is checked BEFORE the image rule,
  // because it is vector source and is never rendered inline in a reply.
  if (mime === "image/svg+xml" || ext === "svg") return "svg";

  // Never, whatever the name says. RASTER images belong inline in the reply.
  if (mime.startsWith("image/")) return "none";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff"].includes(ext)) {
    return "none";
  }
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "none";

  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (TABLE_EXTENSIONS.has(ext) || mime === "text/csv") return "csv";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  if (CONVERTIBLE_EXTENSIONS.has(ext)) return "converted";
  if (mime.startsWith("text/")) return "text";

  // Types whose extension was lost but whose mime survived.
  if (/officedocument|opendocument|ms-excel|ms-powerpoint|msword/.test(mime)) return "office";
  if (/epub|zip|rfc822/.test(mime)) return "converted";

  return "none";
}

/** Kinds whose bytes we pull into the page as a string. */
export function isTextual(kind: PreviewKind): boolean {
  return (
    kind === "markdown" || kind === "code" || kind === "text" ||
    kind === "csv" || kind === "converted"
  );
}

/** Kinds the browser renders itself, in a sandboxed frame. */
export function isFramed(kind: PreviewKind): boolean {
  return kind === "html" || kind === "pdf" || kind === "svg" || kind === "office";
}

/** Can this file be shown at all, at this size? */
export function canPreview(file: {
  mimeType?: string | null;
  filename: string;
  sizeBytes: number;
  /** Did the ingestion worker produce prepared text for this one? */
  hasPrepared?: boolean;
  /** Is the LibreOffice conversion engine configured on this instance? */
  officeToPdf?: boolean;
}): boolean {
  const kind = previewKind(file.mimeType, file.filename);
  if (kind === "none") return false;
  // An office file needs the conversion engine. Without it the route falls
  // back to the prepared text, so it is previewable either way — but only if
  // ONE of the two is actually available.
  if (kind === "office") return file.officeToPdf !== false || file.hasPrepared === true;
  // A framed kind streams, so size is the browser's problem, not ours.
  if (isFramed(kind)) return true;
  // A convertible format is only previewable if the conversion actually
  // happened — a .docx whose ingestion failed has nothing to show, and
  // pretending otherwise gives a spinner that never resolves.
  if (kind === "converted") return file.hasPrepared === true;
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

/** Split a CSV/TSV line, honouring double quotes. Not a full parser — enough
 *  to draw a readable table without pulling in a dependency for a preview. */
export function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Rows for the table preview: header + body, capped so a 50,000-row export
 *  does not lock the tab up in the name of a glance. */
export function parseTable(
  text: string,
  filename: string,
  maxRows = 200,
): { header: string[]; rows: string[][]; truncated: boolean } {
  const delimiter = extensionOf(filename) === "tsv" ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const all = lines.map((l) => splitDelimited(l, delimiter));
  const header = all[0] ?? [];
  const rows = all.slice(1, 1 + maxRows);
  return { header, rows, truncated: all.length - 1 > rows.length };
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
