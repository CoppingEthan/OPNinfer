"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A PDF drawn by US, not by the browser.
 *
 * The panel used to put the file in an `<iframe>` and let Chrome's built-in
 * viewer handle it. That works until somebody has ticked "Download PDF files
 * instead of automatically opening them in Chrome" — then every embedded PDF
 * on the web, ours included, is replaced by a grey icon and an Open button.
 * Reproduced exactly, and it is not a setting we can reach or detect: the
 * placeholder is drawn by the browser in place of the frame's content.
 *
 * So the viewer is ours. pdf.js renders each page to a canvas at the panel's
 * width, with a transparent TEXT LAYER on top so the words can still be
 * selected and copied — which is the thing a picture of a page loses, and the
 * reason this is not just an image per page.
 *
 * Everything it needs is served from this origin (`/api/pdfjs/...`): no CDN,
 * so a portal with no outbound internet renders documents exactly the same.
 */

const WORKER = "/api/pdfjs/build/pdf.worker.min.mjs";
const CMAPS = "/api/pdfjs/cmaps/";
const FONTS = "/api/pdfjs/standard_fonts/";

/** Render a page when it comes within this much of the viewport. */
const NEAR = 600;
/** A canvas is capped here: a 2x backing store on a 4k page is a lot of RAM. */
const MAX_DPR = 2;

type Pdfjs = typeof import("pdfjs-dist");
type PdfTask = ReturnType<Pdfjs["getDocument"]>;
type PdfDoc = Awaited<PdfTask["promise"]>;
type RenderTask = { cancel: () => void; promise: Promise<void> };

export function PdfView({ src, filename }: { src: string; filename: string }) {
  const host = useRef<HTMLDivElement>(null);
  const lib = useRef<Pdfjs | null>(null);
  const doc = useRef<PdfDoc | null>(null);
  /** Page number → the render that is currently in flight or done, by scale. */
  const drawn = useRef(new Map<number, number>());
  /**
   * Page number → the render CURRENTLY DRAWING into that page's canvas.
   *
   * Two renders sharing one canvas is undefined behaviour in pdf.js, and the
   * canvases are reused: React keys pages by index, so opening a second
   * document draws into the first one's elements. Whatever is still in flight
   * then keeps writing into a canvas that the new render has meanwhile resized
   * — which resets the 2D context underneath it. The page comes out garbled or
   * upside down, and only ever the page that was on screen for both documents.
   */
  const inFlight = useRef(new Map<number, RenderTask>());

  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // ---- the document ----------------------------------------------------
  useEffect(() => {
    let dead = false;
    // The LOADING TASK owns teardown, not the document — destroying it is what
    // stops the worker and frees the pages.
    let task: PdfTask | null = null;
    setError(null);
    setSizes([]);
    drawn.current = new Map();

    (async () => {
      const pdfjs = lib.current ?? ((await import("pdfjs-dist")) as Pdfjs);
      if (dead) return;
      lib.current = pdfjs;
      pdfjs.GlobalWorkerOptions.workerSrc = WORKER;

      task = pdfjs.getDocument({
        url: src,
        cMapUrl: CMAPS,
        cMapPacked: true,
        standardFontDataUrl: FONTS,
      });
      const opened = await task.promise;
      if (dead) return;
      doc.current = opened;

      // Measure every page up front — it is metadata, not rendering — so the
      // scrollbar is honest from the start rather than growing as you read.
      const measured: { w: number; h: number }[] = [];
      for (let n = 1; n <= opened.numPages; n++) {
        const p = await opened.getPage(n);
        if (dead) return;
        const v = p.getViewport({ scale: 1 });
        measured.push({ w: v.width, h: v.height });
      }
      if (!dead) setSizes(measured);
    })().catch((e) => {
      if (!dead) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      dead = true;
      doc.current = null;
      for (const t of inFlight.current.values()) t.cancel();
      inFlight.current.clear();
      void task?.destroy().catch(() => {});
    };
  }, [src]);

  // ---- the width we draw at --------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(() => read());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A width change invalidates every canvas: they were rasterised for the old
  // one, and a scaled-up bitmap is exactly the blurry mess this avoids.
  useEffect(() => {
    drawn.current = new Map();
  }, [width]);

  const scaleFor = useCallback(
    (i: number) => (sizes[i] && width ? width / sizes[i].w : 0),
    [sizes, width],
  );

  const render = useCallback(
    async (num: number, wrap: HTMLDivElement) => {
      const pdfjs = lib.current;
      const d = doc.current;
      const scale = scaleFor(num - 1);
      if (!pdfjs || !d || !scale) return;
      if (drawn.current.get(num) === scale) return;
      drawn.current.set(num, scale);

      // Whatever was drawing into this canvas stops FIRST, and we wait for it
      // to actually stop — cancel() is a request, not an event.
      const previous = inFlight.current.get(num);
      if (previous) {
        previous.cancel();
        await previous.promise.catch(() => {});
      }

      const p = await d.getPage(num);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      // The CSS size the page occupies, and the bigger one it is rasterised at.
      // Scaling through the VIEWPORT rather than through a transform passed to
      // render(): one number, no matrix to get the sign of wrong.
      const viewport = p.getViewport({ scale });
      const device = p.getViewport({ scale: scale * dpr });

      const canvas = wrap.querySelector("canvas") as HTMLCanvasElement | null;
      const text = wrap.querySelector("[data-pdf-text]") as HTMLDivElement | null;
      if (!canvas || !text) return;

      canvas.width = Math.floor(device.width);
      canvas.height = Math.floor(device.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const task = p.render({ canvasContext: ctx, canvas, viewport: device }) as RenderTask;
      inFlight.current.set(num, task);
      try {
        await task.promise;
      } catch (e) {
        // A cancelled render leaves a half-drawn canvas, so the page must stop
        // counting as drawn or it will never be drawn again.
        drawn.current.delete(num);
        throw e;
      } finally {
        if (inFlight.current.get(num) === task) inFlight.current.delete(num);
      }

      // The selectable words, positioned over the picture of them.
      text.replaceChildren();
      // pdf.js positions every run with `calc(var(--total-scale-factor) * Npx)`,
      // and setLayerDimensions writes widths through the same variable — so the
      // scale has to be on the element BEFORE either runs, or every word lands
      // at the top-left corner.
      text.style.setProperty("--scale-factor", String(scale));
      pdfjs.setLayerDimensions(text, viewport);
      const layer = new pdfjs.TextLayer({
        textContentSource: p.streamTextContent(),
        container: text,
        viewport,
      });
      await layer.render();
    },
    [scaleFor],
  );

  // ---- draw what is on screen, and track which page that is -------------
  useEffect(() => {
    const el = host.current;
    if (!el || sizes.length === 0 || !width) return;

    const wraps = Array.from(el.querySelectorAll<HTMLDivElement>("[data-pdf-page]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const wrap = e.target as HTMLDivElement;
          const num = Number(wrap.dataset.pdfPage);
          if (e.isIntersecting) void render(num, wrap).catch(() => {});
        }
        // Whichever page covers most of the view is the one you are reading.
        const best = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) setPage(Number((best.target as HTMLDivElement).dataset.pdfPage));
      },
      { root: scrollParent(el), rootMargin: `${NEAR}px 0px`, threshold: [0, 0.25, 0.6] },
    );
    for (const w of wraps) io.observe(w);
    return () => io.disconnect();
  }, [sizes, width, render]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted">This document could not be opened here.</p>
        <p className="max-w-xs text-xs text-muted/80">{error}</p>
        <a
          href={src.replace(/\/preview(\?|$)/, "$1")}
          download={filename}
          className="rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
        >
          Download it instead
        </a>
      </div>
    );
  }

  return (
    <div ref={host} data-pdf-view className="relative w-full">
      {sizes.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">Opening…</p>
      ) : null}

      {sizes.map((s, i) => {
        const scale = scaleFor(i);
        return (
          <div
            key={i}
            data-pdf-page={i + 1}
            style={{ height: scale ? Math.floor(s.h * scale) : undefined }}
            className="relative mx-auto mb-2 w-full overflow-hidden bg-white shadow-sm last:mb-0"
          >
            <canvas className="block" />
            <div data-pdf-text className="oi-pdf-text" />
          </div>
        );
      })}

      {sizes.length > 1 ? (
        <div
          data-pdf-pager
          className="pointer-events-none sticky bottom-2 z-10 mx-auto w-fit rounded-full bg-foreground/80 px-2.5 py-1 text-xs font-medium text-background shadow"
        >
          {page} / {sizes.length}
        </div>
      ) : null}
    </div>
  );
}

/** The thing that actually scrolls this, so "on screen" means what it says. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}
