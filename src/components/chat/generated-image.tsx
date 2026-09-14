"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** One generated image on an assistant reply — placeholder while generating,
 *  then the real image blur-fading in. `id` (the tool call id) links the
 *  streamed start→done events. */
export interface GenImage {
  id: string;
  aspectRatio: string;
  prompt: string;
  operation: string; // "generate" | "edit" | "blend"
  fileId?: string;
  /** Changes whenever the file's BYTES change (its mtime at present time).
   *  Rides the URL as ?v= — the browser's in-page image cache keys on the
   *  URL alone, so a re-presented file under the same id (the agent
   *  recoloured the design in place) showed the OLD bitmap until a reload
   *  (owner bug, 2026-09-02). Cache-Control doesn't reach that cache. */
  version?: number;
  status: "pending" | "ready" | "error";
  estimateMs?: number;
  /** Client ms timestamp when the pending state began (for the countdown). */
  startedAt?: number;
  error?: string;
}

function ratioNum(ar: string): number {
  const [w, h] = ar.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
}

const OP_LABEL: Record<string, string> = { generate: "Generated", edit: "Edited", blend: "Blended" };

export function GeneratedImage({ image }: { image: GenImage }) {
  const r = ratioNum(image.aspectRatio);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [remaining, setRemaining] = useState(image.estimateMs ?? 0);
  const imgRef = useRef<HTMLImageElement>(null);

  // Live ETA countdown while generating.
  useEffect(() => {
    if (image.status !== "pending") return;
    const started = image.startedAt ?? Date.now();
    const est = image.estimateMs ?? 0;
    const tick = () => setRemaining(Math.max(0, est - (Date.now() - started)));
    tick();
    const t = setInterval(tick, 300);
    return () => clearInterval(t);
  }, [image.status, image.estimateMs, image.startedAt]);

  const src = image.fileId ? `/api/files/${image.fileId}${image.version ? `?v=${image.version}` : ""}` : undefined;

  // Cached-image race: on reload the browser may finish loading the <img>
  // BEFORE React attaches onLoad, so onLoad never fires and it stays hidden.
  // Check `complete` on mount and reveal it.
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setLoaded(true);
  }, [src]);

  const boxStyle = { aspectRatio: String(r), maxWidth: "28rem", maxHeight: "30rem" } as const;
  const showPlaceholder = image.status !== "error" && (image.status === "pending" || !loaded);

  return (
    <figure className="my-3">
      <div
        className="group/gi relative w-full overflow-hidden rounded-2xl border border-border bg-surface"
        style={boxStyle}
      >
        {image.status === "error" ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-4 text-center">
            <ImageIcon className="h-6 w-6 text-red-500/70" />
            <span className="text-xs text-muted">Couldn&apos;t generate this image.</span>
            {image.error ? <span className="text-[11px] text-muted/70">{image.error}</span> : null}
          </div>
        ) : (
          <>
            {/* Developing placeholder — soft blurred glow (no visible gradient
                line) with the prompt shown inside while it forms. */}
            {showPlaceholder && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center">
                {/* Blurred animated layer sits BEHIND the text. */}
                <div className="oi-gi-develop" aria-hidden="true" />
                <ImageIcon className="relative h-7 w-7 text-muted/60" />
                <span className="relative text-xs font-medium text-foreground/80">
                  {OP_LABEL[image.operation] ?? "Generating"}…
                </span>
                {image.status === "pending" ? (
                  <span className="relative text-[11px] tabular-nums text-muted">
                    {remaining > 500 ? `~${Math.ceil(remaining / 1000)}s remaining` : "finishing up…"}
                  </span>
                ) : null}
                {image.prompt ? (
                  <span className="relative mt-1 line-clamp-3 max-w-[22rem] text-[11px] leading-snug text-muted/80">
                    {image.prompt}
                  </span>
                ) : null}
              </div>
            )}

            {/* Real image — right-clickable; blur-fades in on load. */}
            {src && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                src={src}
                alt={image.prompt || "Generated image"}
                onLoad={() => setLoaded(true)}
                onClick={() => loaded && setExpanded(true)}
                className={`h-full w-full cursor-zoom-in object-cover transition-all duration-700 ease-out ${
                  loaded ? "scale-100 opacity-100 blur-0" : "scale-105 opacity-0 blur-2xl"
                }`}
              />
            )}

            {/* Prompt overlay on the finished image (bottom gradient bar). */}
            {loaded && src && image.prompt ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-2.5 pt-6">
                <p className="line-clamp-2 text-[11px] leading-snug text-white/90">{image.prompt}</p>
              </div>
            ) : null}

            {/* Hover actions — appear once the image is loaded. */}
            {loaded && src ? (
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/gi:opacity-100">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  title="View full size"
                  className="rounded-lg bg-black/55 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                >
                  <ExpandIcon />
                </button>
                <a
                  href={src}
                  download
                  title="Download"
                  className="rounded-lg bg-black/55 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                >
                  <DownloadIcon />
                </a>
              </div>
            ) : null}
          </>
        )}
      </div>

      {expanded && src ? <Lightbox src={src} alt={image.prompt} onClose={() => setExpanded(false)} /> : null}
    </figure>
  );
}

/** Full-screen preview; click anywhere or Esc to close. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || "Generated image"}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      <a
        href={src}
        download
        onClick={(e) => e.stopPropagation()}
        title="Download"
        className="absolute right-4 top-4 rounded-lg bg-white/15 p-2 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
      >
        <DownloadIcon />
      </a>
    </div>,
    document.body,
  );
}

function ImageIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}
