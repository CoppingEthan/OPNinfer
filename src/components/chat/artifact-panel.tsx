"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getArtifactMeta, type ArtifactMeta } from "@/app/actions/artifact";
import { formatSize, isFramed, isTextual, languageFor, previewUrl } from "@/lib/artifact";
import { CodeView } from "./tool-run";

/**
 * The artifact panel: a file the assistant produced, open beside the chat.
 *
 * Opened by clicking a file card, and automatically when a turn presents
 * something — always at the LATEST version, which is the whole reason the
 * preview URL carries the file's mtime. The browser caches an in-page fetch by
 * URL alone, so a re-presented file under the same id would otherwise sit
 * there showing the old bytes, which is the exact bug that had to be fixed for
 * re-presented images.
 *
 * Never images: they render inline in the reply, where they are the answer
 * rather than an attachment to it (`previewKind` enforces this, with tests).
 */

export const ARTIFACT_EVENT = "oi-open-artifact";

/** Ask for a file to be shown. Anything in the chat can call this. */
export function openArtifact(fileId: string): void {
  window.dispatchEvent(new CustomEvent(ARTIFACT_EVENT, { detail: { fileId } }));
}

const WIDTH_KEY = "oi-artifact-width";
const MIN_WIDTH = 340;
/**
 * Framed previews render at a fixed logical width and are then scaled to fit.
 *
 * A design artifact is built at an exact size — the agent writes a 1080px
 * advert — so rendering it at whatever the panel happens to be wide shows you
 * the top-left corner of it. And the frame is sandboxed into a unique origin,
 * so its real width cannot be measured from here. Rendering at a known width
 * and scaling is the one approach that works for both a fixed-size design and
 * a page of flowing text.
 */
const FRAME_WIDTH = 1200;
const MAX_WIDTH = 900;

export function ArtifactPanel() {
  const [fileId, setFileId] = useState<string | null>(null);
  const [meta, setMeta] = useState<ArtifactMeta | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(480);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WIDTH_KEY);
      if (raw) setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(raw) || 480)));
    } catch {
      /* private window — the default is fine */
    }
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ fileId: string }>).detail?.fileId;
      if (id) setFileId(id);
    };
    window.addEventListener(ARTIFACT_EVENT, onOpen);
    return () => window.removeEventListener(ARTIFACT_EVENT, onOpen);
  }, []);

  /** Re-read metadata and, for a textual kind, the body. */
  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    const m = await getArtifactMeta(id);
    if (!m) {
      setMeta(null);
      setBody(null);
      setError("That file is no longer available.");
      setLoading(false);
      return;
    }
    setMeta(m);
    if (isTextual(m.kind) && m.previewable) {
      try {
        const res = await fetch(previewUrl(m.id, m.version));
        setBody(res.ok ? await res.text() : null);
        if (!res.ok) setError(res.status === 413 ? "Too large to preview." : "Could not read this file.");
      } catch {
        setError("Could not read this file.");
      }
    } else {
      setBody(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!fileId) return;
    void load(fileId);
  }, [fileId, load]);

  // The file changed under us — a turn re-presented it, or the agent finished
  // and the pool re-synced. Re-read rather than leave a stale document open.
  useEffect(() => {
    if (!fileId) return;
    const refresh = () => void load(fileId);
    window.addEventListener(ARTIFACT_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACT_EVENT, refresh);
  }, [fileId, load]);

  // ---- drag to resize -----------------------------------------------------
  // How much to shrink a framed preview so it fits the panel.
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setScale(Math.min(1, el.clientWidth / FRAME_WIDTH));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fileId, expanded]);

  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      setWidth(next);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* nothing worth failing a drag over */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [width]);

  useEffect(() => {
    if (!fileId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFileId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileId]);

  if (!fileId) return null;

  const close = () => {
    setFileId(null);
    setMeta(null);
    setBody(null);
    setError(null);
  };

  return (
    <aside
      data-artifact-panel={meta?.id ?? fileId}
      data-artifact-expanded={expanded ? "1" : "0"}
      // The width rides a CSS VARIABLE rather than an inline `width`, because
      // an inline width wins over `inset-0` and made the panel 480px wide on a
      // 390px phone — pushing Download, Expand and Close off the right edge,
      // so there was no way to shut it.
      style={{ ["--oi-artifact-w" as string]: `${width}px` }}
      className={
        // Under md it is the whole screen, with a cross — a 400px reading
        // panel on a phone is neither the chat nor the document.
        "fixed inset-0 z-40 flex w-full flex-col border-border bg-background " +
        "md:relative md:inset-auto md:z-auto md:border-l " +
        (expanded ? "md:w-full" : "md:w-[var(--oi-artifact-w)] md:shrink-0")
      }
    >
      {/* Drag handle — desktop only, and not while expanded. */}
      {!expanded ? (
        <div
          onMouseDown={() => {
            dragging.current = true;
            document.body.style.cursor = "col-resize";
          }}
          className="absolute left-0 top-0 hidden h-full w-1 cursor-col-resize hover:bg-accent/40 md:block"
          aria-hidden
        />
      ) : null}

      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="truncate text-sm font-medium text-foreground" title={meta?.filename}>
            {meta?.filename ?? "Loading…"}
          </p>
          <p className="text-xs text-muted">
            {meta ? (
              <>
                {meta.kind === "none" ? "Not previewable" : meta.kind}
                {meta.sizeBytes ? ` · ${formatSize(meta.sizeBytes)}` : null}
              </>
            ) : null}
          </p>
        </div>

        {meta ? (
          <a
            href={`/api/files/${meta.id}`}
            download={meta.filename}
            title="Download"
            aria-label="Download"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <DownloadIcon />
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Shrink" : "Expand"}
          aria-label={expanded ? "Shrink" : "Expand"}
          className="hidden rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground md:inline-flex"
        >
          <ExpandIcon expanded={expanded} />
        </button>
        <button
          type="button"
          onClick={close}
          title="Close"
          aria-label="Close"
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <CloseIcon />
        </button>
      </header>

      <div ref={viewport} className="oi-scroll min-h-0 flex-1 overflow-auto">
        {loading && !meta ? (
          <p className="p-4 text-sm text-muted">Opening…</p>
        ) : error ? (
          <p className="p-4 text-sm text-muted">{error}</p>
        ) : !meta ? null : !meta.previewable ? (
          <div className="p-5 text-sm text-muted">
            <p className="mb-3">
              {meta.kind === "none"
                ? "This kind of file doesn't preview here."
                : "This one is too big to show — download it instead."}
            </p>
            <a
              href={`/api/files/${meta.id}`}
              download={meta.filename}
              className="inline-flex rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            >
              Download {formatSize(meta.sizeBytes)}
            </a>
          </div>
        ) : isFramed(meta.kind) ? (
          <div
            // The wrapper takes the SCALED size, so the scroll container sees
            // the real footprint rather than the pre-scale one.
            style={{ width: FRAME_WIDTH * scale, height: `${100 / scale}%` }}
            className="origin-top-left"
          >
            <iframe
              // `key` on the versioned URL: a src change alone does not always
              // re-load a frame, and a stale advert is exactly what this panel
              // exists to avoid.
              key={previewUrl(meta.id, meta.version)}
              src={previewUrl(meta.id, meta.version)}
              title={meta.filename}
              // Belt and braces with the route's `CSP: sandbox`.
              sandbox=""
              style={{ width: FRAME_WIDTH, transform: `scale(${scale})` }}
              // A document with no background of its own would otherwise show
              // the browser's default white through a dark page.
              className="h-full origin-top-left border-0 bg-white"
            />
          </div>
        ) : meta.kind === "markdown" && body !== null ? (
          <div className="markdown p-5 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
          </div>
        ) : body !== null ? (
          <div className="p-3">
            <CodeView code={body} lang={languageFor(meta.filename)} />
          </div>
        ) : (
          <p className="p-4 text-sm text-muted">Reading…</p>
        )}
      </div>
    </aside>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 3.5v9m0 0 3.2-3.2M10 12.5 6.8 9.3M4 14.5v1.2c0 .6.5 1.1 1.1 1.1h9.8c.6 0 1.1-.5 1.1-1.1v-1.2" />
    </svg>
  );
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {expanded ? (
        <path d="M12 8h4M12 8V4M8 12H4M8 12v4" />
      ) : (
        <path d="M16 4h-4M16 4v4M4 16h4M4 16v-4" />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M5.5 5.5l9 9m0-9-9 9" />
    </svg>
  );
}
