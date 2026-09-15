"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileContextModal, type Attachment } from "./file-chip";
import { fileCardInfo, type FileCategory } from "@/lib/file-card";
import { openArtifact } from "./artifact-panel";

/**
 * Files the assistant CREATED and presented, as Claude.ai-style cards (owner
 * ask, 2026-09-02): a coloured type tile, a humanised title, "Kind · EXT",
 * a Download button with a caret menu (open / view contents), a "Download
 * all" when there are several, a soft staggered entrance, a subtle wash of
 * the tile's colour across the card, and a per-type icon animation on hover.
 * Images are not cards — they render inline through the generated-image
 * flow. Clicking the title opens the context viewer (what the model wrote);
 * the real filename is the tooltip, the download name, and `data-file-card`
 * for tests.
 */
export function GeneratedFiles({ files }: { files: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);

  const downloadAll = () => {
    // Staggered so the browser doesn't collapse them into one.
    files.forEach((f, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = `/api/files/${f.id}`;
        a.download = f.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400);
    });
  };

  return (
    <div className="mt-2 flex max-w-[34rem] flex-col gap-2">
      {files.map((f, i) => (
        <FileCard
          key={f.id}
          file={f}
          index={i}
          // Clicking the card opens it in the side panel, beside the chat.
          // The kebab's "View contents" keeps the old modal, which shows the
          // PREPARED text the model was given — a different question.
          onView={() => openArtifact(f.id)}
          onViewContext={() => setOpen(f)}
        />
      ))}

      {files.length > 1 ? (
        <button
          type="button"
          onClick={downloadAll}
          style={{ "--oi-i": files.length } as CSSProperties}
          className="oi-file-in inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <DownloadIcon />
          Download all
        </button>
      ) : null}

      {open ? (
        <FileContextModal fileId={open.id} filename={open.filename} showDownload onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function FileCard({
  file,
  index,
  onView,
  onViewContext,
}: {
  file: Attachment;
  index: number;
  onView: () => void;
  onViewContext: () => void;
}) {
  const info = fileCardInfo(file.filename, file.mimeType);
  const ready = file.status !== "pending" && file.status !== "processing";
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const href = `/api/files/${file.id}`;

  return (
    <div
      data-file-card={file.filename}
      style={{ "--oi-i": index } as CSSProperties}
      className={`oi-file-card oi-file-in relative flex items-center gap-3 rounded-2xl border border-border bg-surface bg-gradient-to-r p-1.5 pr-2 hover:border-border/80 ${TINT[info.category]} ${menu ? "z-30" : ""}`}
    >
      <span
        className={`oi-file-tile flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white/95 shadow-sm ${TONE[info.category]}`}
        aria-hidden="true"
      >
        <CategoryIcon category={info.category} />
      </span>

      <button
        type="button"
        onClick={() => ready && onView()}
        disabled={!ready}
        title={ready ? file.filename : `${file.filename} — still processing…`}
        className="flex min-w-0 flex-1 flex-col text-left"
      >
        <span className="truncate text-sm font-semibold leading-tight text-foreground">{info.title}</span>
        <span className="mt-0.5 truncate text-[11px] text-muted">{info.subtitle}</span>
      </button>

      <div className="relative flex shrink-0 items-stretch" ref={menuRef}>
        <a
          href={href}
          download={file.filename}
          className="inline-flex items-center rounded-l-lg border border-border bg-surface-hover/60 px-3 py-1 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          Download
        </a>
        <button
          type="button"
          aria-label="More options"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="inline-flex items-center rounded-r-lg border border-l-0 border-border bg-surface-hover/60 px-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition-transform ${menu ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {menu ? (
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 text-sm shadow-lg"
          >
            <a role="menuitem" href={href} download={file.filename} onClick={() => setMenu(false)} className="block px-3 py-1.5 text-foreground hover:bg-surface-hover">
              Download
            </a>
            <a role="menuitem" href={href} target="_blank" rel="noreferrer" onClick={() => setMenu(false)} className="block px-3 py-1.5 text-foreground hover:bg-surface-hover">
              Open in new tab
            </a>
            {ready ? (
              <button role="menuitem" type="button" onClick={() => { setMenu(false); onViewContext(); }} className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-surface-hover">
                View contents
              </button>
            ) : null}
            <div className="mx-3 my-1 border-t border-border" />
            <div className="truncate px-3 py-1 text-[11px] text-muted" title={file.filename}>
              {file.filename}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Tile gradients per category — literal class names so Tailwind's scanner sees them. */
const TONE: Record<FileCategory, string> = {
  web: "from-rose-500 to-pink-600",
  code: "from-orange-500 to-rose-500",
  document: "from-sky-500 to-blue-600",
  text: "from-slate-500 to-slate-600",
  spreadsheet: "from-emerald-500 to-green-600",
  presentation: "from-amber-500 to-orange-600",
  pdf: "from-red-500 to-rose-600",
  image: "from-indigo-500 to-violet-600",
  archive: "from-yellow-500 to-amber-600",
  audio: "from-fuchsia-500 to-purple-600",
  video: "from-cyan-500 to-sky-600",
  data: "from-teal-500 to-emerald-600",
  file: "from-slate-400 to-slate-500",
};

/** A subtle wash of the tile's colour across the whole card (left → clear). */
const TINT: Record<FileCategory, string> = {
  web: "from-rose-500/10 via-transparent to-transparent",
  code: "from-orange-500/10 via-transparent to-transparent",
  document: "from-sky-500/10 via-transparent to-transparent",
  text: "from-slate-500/10 via-transparent to-transparent",
  spreadsheet: "from-emerald-500/10 via-transparent to-transparent",
  presentation: "from-amber-500/10 via-transparent to-transparent",
  pdf: "from-red-500/10 via-transparent to-transparent",
  image: "from-indigo-500/10 via-transparent to-transparent",
  archive: "from-yellow-500/10 via-transparent to-transparent",
  audio: "from-fuchsia-500/10 via-transparent to-transparent",
  video: "from-cyan-500/10 via-transparent to-transparent",
  data: "from-teal-500/10 via-transparent to-transparent",
  file: "from-slate-400/10 via-transparent to-transparent",
};

/**
 * One icon per category, each with its own hover animation on the card
 * (owner ask 2026-09-02: "like our GUI icons, but unique per type") — the
 * archive lid lifts, braces and brackets move apart, the document's lines
 * animate in and out, the grid draws, the notes bounce, the play button
 * nudges. Sub-elements carry `oi-fc-*` classes; the keyframes live in
 * globals.css under `.oi-file-card:hover`.
 */
function CategoryIcon({ category }: { category: FileCategory }) {
  const p = { viewBox: "0 0 24 24", className: "h-[22px] w-[22px]", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (category) {
    case "web":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <g className="oi-fc-globe"><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></g>
        </svg>
      );
    case "code":
      return (
        <svg {...p}>
          <path className="oi-fc-l" d="M8 7l-5 5 5 5" />
          <path className="oi-fc-r" d="M16 7l5 5-5 5" />
          <path className="oi-fc-slash" d="M14 4l-4 16" />
        </svg>
      );
    case "data":
      return (
        <svg {...p}>
          <path className="oi-fc-l" d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3" />
          <path className="oi-fc-r" d="M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3" />
        </svg>
      );
    case "spreadsheet":
      return (
        <svg {...p}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path className="oi-fc-draw" d="M3 10h18M3 15h18M9 4v16M15 4v16" />
        </svg>
      );
    case "presentation":
      return (
        <svg {...p}>
          <rect className="oi-fc-screen" x="3" y="4" width="18" height="12" rx="2" />
          <path d="M12 16v4M8 20h8" />
        </svg>
      );
    case "image":
      return (
        <svg {...p}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle className="oi-fc-sun" cx="9" cy="10" r="1.6" />
          <path className="oi-fc-mtn" d="M21 16l-5-5-8 8" />
        </svg>
      );
    case "archive":
      return (
        <svg {...p}>
          <rect className="oi-fc-lid" x="3" y="4" width="18" height="5" rx="1" />
          <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M10 13h4" />
        </svg>
      );
    case "audio":
      return (
        <svg {...p}>
          <path className="oi-fc-note" d="M9 18V6l11-2v12" />
          <circle className="oi-fc-note" cx="6" cy="18" r="3" />
          <circle className="oi-fc-note2" cx="17" cy="16" r="3" />
        </svg>
      );
    case "video":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="14" height="14" rx="2" />
          <path className="oi-fc-play" d="M17 10l4-2v8l-4-2z" />
        </svg>
      );
    case "pdf":
    case "document":
    case "text":
    default:
      return (
        <svg {...p}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path className="oi-fc-line oi-fc-line-1" d="M9 12h6" />
          <path className="oi-fc-line oi-fc-line-2" d="M9 15h6" />
          <path className="oi-fc-line oi-fc-line-3" d="M9 18h4" />
        </svg>
      );
  }
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}
