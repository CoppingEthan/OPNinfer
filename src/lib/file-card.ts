/**
 * File-card presentation rules (owner ask, 2026-09-02: "make ours look like
 * Claude.ai's"). Pure and client-safe: a humanised title from the filename,
 * and a category (label + colour tone + icon key) from the extension/mime.
 * Images are NOT cards — they render inline — so "image" here only covers
 * formats the inline flow does not display (svg, bmp, tiff, psd…).
 */

export type FileCategory =
  | "code"
  | "web"
  | "document"
  | "text"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image"
  | "archive"
  | "audio"
  | "video"
  | "data"
  | "file";

export interface FileCardInfo {
  /** "pr-property-email_signature.html" → "Pr property email signature". */
  title: string;
  /** Upper-case extension, "" when none. */
  ext: string;
  category: FileCategory;
  /** "Code · HTML", "Image · JPG", "Text · TXT". */
  subtitle: string;
}

const CATEGORY_LABEL: Record<FileCategory, string> = {
  code: "Code",
  web: "Code",
  document: "Document",
  text: "Text",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  pdf: "Document",
  image: "Image",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  data: "Data",
  file: "File",
};

const BY_EXT: Record<string, FileCategory> = {
  html: "web", htm: "web", css: "web", svg: "image",
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rb: "code", go: "code",
  rs: "code", java: "code", kt: "code", c: "code", h: "code", cpp: "code", cs: "code", php: "code", sh: "code",
  bash: "code", ps1: "code", sql: "code", r: "code", swift: "code", lua: "code", pl: "code", scala: "code",
  txt: "text", md: "text", markdown: "text", rtf: "text", log: "text",
  doc: "document", docx: "document", odt: "document", pages: "document",
  pdf: "pdf",
  xls: "spreadsheet", xlsx: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet", ods: "spreadsheet", numbers: "spreadsheet",
  ppt: "presentation", pptx: "presentation", key: "presentation", odp: "presentation",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", tiff: "image", tif: "image",
  psd: "image", ai: "image", heic: "image", ico: "image",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", "7z": "archive", rar: "archive", bz2: "archive", xz: "archive",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", flac: "audio", aac: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  json: "data", yaml: "data", yml: "data", xml: "data", toml: "data", ini: "data", env: "data", db: "data", sqlite: "data",
};

function extOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileCategory(filename: string, mimeType?: string): FileCategory {
  const ext = extOf(filename);
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/html")) return "web";
  if (m.startsWith("text/")) return "text";
  if (/zip|compressed|tar/.test(m)) return "archive";
  if (/json|xml|yaml/.test(m)) return "data";
  if (/word|opendocument\.text/.test(m)) return "document";
  if (/sheet|excel|csv/.test(m)) return "spreadsheet";
  if (/presentation|powerpoint/.test(m)) return "presentation";
  return "file";
}

/**
 * "README-how-to-install_the.signature.txt" → "Readme how to install the signature".
 * Separators become spaces, everything is lower-cased, first letter up — the
 * way Claude.ai titles a file. The real filename is still shown beside the
 * type, so nothing is hidden.
 */
export function humaniseFilename(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  if (/^\.[^.]+$/.test(base)) return base; // a dotfile IS its name (.env)
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/[-_.+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return base;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function fileCardInfo(filename: string, mimeType?: string): FileCardInfo {
  const category = fileCategory(filename, mimeType);
  const ext = extOf(filename).toUpperCase();
  const label = CATEGORY_LABEL[category];
  return {
    title: humaniseFilename(filename),
    ext,
    category,
    subtitle: ext ? `${label} · ${ext}` : label,
  };
}
