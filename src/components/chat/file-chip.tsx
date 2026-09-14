"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface Attachment {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  /** Ingestion state (pending → processing → ready/unsupported/failed). */
  status?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type FileKind =
  | "image"
  | "pdf"
  | "word"
  | "sheet"
  | "archive"
  | "audio"
  | "video"
  | "code"
  | "file";

/** Human category label per kind (for the "Document · PDF" subtitle). */
export const KIND_LABEL: Record<FileKind, string> = {
  image: "Image",
  pdf: "Document",
  word: "Document",
  sheet: "Spreadsheet",
  archive: "Archive",
  audio: "Audio",
  video: "Video",
  code: "Code",
  file: "File",
};

/** Classify a file by MIME type, falling back to its extension. */
export function fileKind(mime: string | undefined, filename: string): FileKind {
  const m = (mime ?? "").toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
  if (m.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.includes("word") || ["doc", "docx", "rtf", "odt"].includes(ext)) return "word";
  if (
    m.includes("sheet") ||
    m.includes("excel") ||
    m === "text/csv" ||
    ["xls", "xlsx", "csv", "ods"].includes(ext)
  )
    return "sheet";
  if (
    m.includes("zip") ||
    m.includes("compress") ||
    m.includes("tar") ||
    ["zip", "rar", "7z", "gz", "tar"].includes(ext)
  )
    return "archive";
  if (
    m.includes("json") ||
    m.includes("javascript") ||
    m.includes("xml") ||
    [
      "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp",
      "cs", "php", "sh", "css", "html", "json", "yml", "yaml", "sql", "md",
    ].includes(ext)
  )
    return "code";
  return "file";
}

/** Tile colour per kind (image is handled separately as a thumbnail). */
const KIND_TILE: Record<Exclude<FileKind, "image">, string> = {
  pdf: "bg-red-500/15 text-red-600 dark:text-red-400",
  word: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  sheet: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  archive: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  audio: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  video: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
  code: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  file: "bg-surface-hover text-muted",
};

/** Leading visual: image preview thumbnail, or a type-coloured icon tile. */
export function Thumb({ file }: { file: Attachment }) {
  const kind = fileKind(file.mimeType, file.filename);
  if (kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/files/${file.id}`}
        alt=""
        loading="lazy"
        className="h-9 w-9 shrink-0 rounded-md object-cover ring-1 ring-border"
      />
    );
  }
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${KIND_TILE[kind]}`}
      aria-hidden="true"
    >
      <KindGlyph kind={kind} />
    </span>
  );
}

/** Ingestion-state dot: spinner while preparing, red on failure. */
function StatusBadge({ status }: { status?: string }) {
  if (status === "pending" || status === "processing") {
    return (
      <span
        className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface ring-1 ring-border"
        title="Preparing for the assistant…"
      >
        <span className="h-2 w-2 animate-spin rounded-full border border-muted border-t-transparent" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-surface"
        title="Couldn't prepare this file — it's still stored and downloadable."
      />
    );
  }
  return null;
}

/**
 * A file pill. Clicking the name/size opens the exact context the assistant
 * would read for it (`read_file`'s prepared content) — so users can see for
 * themselves what the model sees. In the composer it's also removable; for a
 * conversation's stored files, a "Download original" link lives inside that
 * modal. Images show a thumbnail; other files show an icon matching type.
 */
export function FileChip({
  file,
  onRemove,
  download,
}: {
  file: Attachment;
  onRemove?: () => void;
  download?: boolean;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const dot = file.filename.lastIndexOf(".");
  const ext = dot > 0 ? file.filename.slice(dot + 1).toUpperCase() : "";
  const meta = ext ? `${ext} · ${formatBytes(file.sizeBytes)}` : formatBytes(file.sizeBytes);
  const ready = file.status !== "pending" && file.status !== "processing";

  const inner = (
    <>
      <span className="relative shrink-0">
        <Thumb file={file} />
        <StatusBadge status={file.status} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[12rem] truncate text-xs font-medium text-foreground">
          {file.filename}
        </span>
        <span className="text-[10px] text-muted">{meta}</span>
      </span>
    </>
  );

  const base =
    "inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-2 py-1.5";

  return (
    <>
      <span className={base}>
        <button
          type="button"
          onClick={() => setContextOpen(true)}
          disabled={!ready}
          title={ready ? `View what the assistant reads for ${file.filename}` : "Still processing…"}
          className={`flex min-w-0 items-center gap-2 rounded-lg text-left transition-colors ${
            ready ? "hover:opacity-80" : "cursor-default"
          }`}
        >
          {inner}
        </button>
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove ${file.filename}`}
            onClick={onRemove}
            className="ml-0.5 shrink-0 text-muted transition-colors hover:text-red-600 dark:hover:text-red-400"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : null}
      </span>
      {contextOpen ? (
        <FileContextModal
          fileId={file.id}
          filename={file.filename}
          showDownload={download}
          onClose={() => setContextOpen(false)}
        />
      ) : null}
    </>
  );
}

interface FileContext {
  filename: string;
  sizeFormatted: string;
  type: string;
  status: string;
  tokenEstimate: number | null;
  content: string | null;
  note?: string;
}

/**
 * Shows the EXACT prepared content `read_file` hands the assistant for this
 * file — fetched fresh from /api/files/:id/context. Owner-only (enforced
 * server-side); this is a read-only viewer, not an editor. Also opened from
 * file-kind entries in a reply's sources panel.
 */
export function FileContextModal({
  fileId,
  filename,
  showDownload,
  onClose,
}: {
  fileId: string;
  filename: string;
  showDownload?: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<FileContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/files/${fileId}/context`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this file's context.");
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const copy = async () => {
    if (!data?.content) return;
    await navigator.clipboard.writeText(data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`What the assistant reads for ${filename}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{filename}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {data
                ? `${data.type} · ${data.sizeFormatted}${
                    data.tokenEstimate ? ` · ~${data.tokenEstimate} tokens as the assistant sees it` : ""
                  }`
                : "Loading…"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showDownload ? (
              <a
                href={`/api/files/${fileId}`}
                className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
              >
                Download original
              </a>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="px-4 py-10 text-center text-sm text-muted">{error}</p>
          ) : !data ? (
            <p className="px-4 py-10 text-center text-sm text-muted">Loading…</p>
          ) : data.content != null ? (
            <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
              {data.content}
            </pre>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-muted">{data.note}</p>
          )}
        </div>

        {data?.content ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
            <p className="text-[11px] text-muted">
              This is the exact prepared text the assistant reads via <code>read_file</code>.
            </p>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function KindGlyph({ kind }: { kind: Exclude<FileKind, "image"> }) {
  const cls = "h-[18px] w-[18px]";
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "sheet":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
        </svg>
      );
    case "archive":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2M4 7h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
          <path d="M12 7v4M10 11h4M11 15h2" />
        </svg>
      );
    case "audio":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <path d="M9 18V6l10-2v12" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      );
    case "video":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9l5 3-5 3V9Z" />
        </svg>
      );
    case "code":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" />
        </svg>
      );
    default:
      // pdf / word / generic file: document with a folded corner.
      return (
        <svg viewBox="0 0 24 24" className={cls} {...stroke} aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
  }
}
