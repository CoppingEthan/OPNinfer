"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Sandboxed inline visualisation (v0.3 step 8). Renders assistant-generated
 * SVG/HTML in an iframe with `sandbox="allow-scripts"` ONLY (no same-origin —
 * the frame can't touch cookies, storage, or the app) plus a CSP that blocks
 * all network except data:/https: images. Theme variables are read from the
 * live document so visuals match light/dark. While streaming, content updates
 * via postMessage (innerHTML swap — fast, no reload flicker); once complete,
 * the final HTML is embedded directly so inline <script> executes.
 *
 * DARK MODE (owner bug, 2026-09-04): the frame's document MUST declare the
 * same `color-scheme` as the page. The app sets `color-scheme: dark` on
 * <html>; a frame that says nothing is "normal" (= light), and when an
 * iframe's used colour scheme differs from its embedder's the browser paints
 * an OPAQUE canvas behind it (CSS Color Adjust — deliberate, so a light page
 * can't turn unreadable inside a dark one). So `background: transparent` was
 * silently ignored in dark mode: white frame, light text, unreadable chart.
 * The shell now declares the scheme AND paints the card's own surface colour
 * itself, so it never depends on that transparency rule again. Proof:
 * scripts/test-viz-dark.ts (pixel-measured in both themes).
 */

export interface VizData {
  title: string;
  html: string;
  /** Still streaming in? */
  done: boolean;
}

const THEME_VARS = [
  "--background", "--surface", "--foreground", "--muted", "--border", "--accent",
] as const;

/** Colour ramps offered to the model (light/dark tuned, flat design). */
const RAMPS: Record<string, [string, string]> = {
  // name: [stroke/solid, light fill]
  purple: ["#7c5cbf", "#efeaf9"],
  teal: ["#2a9d8f", "#e4f4f2"],
  coral: ["#e76f51", "#fcece6"],
  pink: ["#d0679d", "#f9e8f1"],
  gray: ["#6b7280", "#eef0f3"],
  blue: ["#4a7dbf", "#e8eff8"],
  green: ["#4c9a52", "#e9f4ea"],
  amber: ["#d99a2b", "#faf1de"],
  red: ["#c95252", "#f9e9e9"],
};

function buildShell(theme: Record<string, string>, dark: boolean): string {
  const rampVars = Object.entries(RAMPS)
    .map(([n, [stroke, fill]]) => `--${n}:${stroke};--${n}-fill:${dark ? stroke + "33" : fill};`)
    .join("");
  const vars =
    `--bg:${theme["--background"] || "#fff"};--fg:${theme["--foreground"] || "#111"};` +
    `--muted:${theme["--muted"] || "#687180"};--border:${theme["--border"] || "#e3e7ec"};` +
    `--accent:${theme["--accent"] || "#5b7aa6"};--surface:${theme["--surface"] || "#f2f4f7"};` +
    `--font-sans:ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,monospace;${rampVars}`;
  // color-scheme MUST match the page's, or the browser backs the frame with
  // an opaque (white) canvas — see the header comment. The surface is painted
  // here too, so the frame matches its card without relying on transparency.
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">
<style>
:root{${vars}color-scheme:${dark ? "dark" : "light"}}
html,body{margin:0;padding:0;background:var(--surface);color:var(--fg);font-family:var(--font-sans);font-size:13px}
#root{padding:4px 2px}
svg{max-width:100%;height:auto}
table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:4px 8px}
</style></head><body><div id="root"></div>
<script>
  const root = document.getElementById("root");
  let raf = 0;
  function report() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      parent.postMessage({ __oiViz: true, height: document.documentElement.scrollHeight }, "*");
    });
  }
  addEventListener("message", (e) => {
    // Only the page that owns us may swap the content — never a sibling
    // frame (another visual in the same thread could otherwise overwrite this one).
    if (e.source !== parent) return;
    if (e.data && e.data.__oiVizHtml !== undefined) {
      root.innerHTML = e.data.__oiVizHtml;
      report();
    }
  });
  new ResizeObserver(report).observe(document.body);
  // Handshake: content pushed before this listener existed is LOST (seen
  // live — Anthropic's bursty deltas can deliver the whole fragment before
  // the frame boots, leaving it blank). Tell the parent we're ready; it
  // re-delivers the latest HTML.
  parent.postMessage({ __oiVizReady: true }, "*");
  report();
</script></body></html>`;
}

export function VizFrame({ viz }: { viz: VizData }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [theme, setTheme] = useState<Record<string, string>>({});
  // Dark-mode must be STATE set after mount, never read from `document`
  // during render — the server can't see the .dark class, so a render-time
  // check makes the SSR srcDoc differ from the client's (hydration mismatch).
  const [dark, setDark] = useState(false);
  // Streaming-delivery race guards: the shell iframe signals readiness, and
  // until then pushes are pointless (its listener doesn't exist yet). The
  // refs let the ready handler deliver the LATEST html without re-rendering.
  const frameReadyRef = useRef(false);
  const latestRef = useRef(viz);
  latestRef.current = viz;

  // Read the live theme once mounted (and again if the html/dark class flips).
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const t: Record<string, string> = {};
      for (const v of THEME_VARS) t[v] = cs.getPropertyValue(v).trim();
      setTheme(t);
      setDark(document.documentElement.classList.contains("dark"));
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  // The frame may not navigate itself away (audit 2026-09-05): the sandbox
  // blocks top-navigation and popups, not `location.href = …` INSIDE the
  // frame, so injected model HTML could replace the chart with an external
  // look-alike page under the portal's chrome. Each srcdoc (and each remount)
  // causes exactly one legitimate load; a second load means it navigated —
  // remount, which puts the shell back.
  //
  // Counting loads does not work: a script inside the fragment runs while
  // the srcdoc is still parsing, so the navigation starts before our shell
  // script at the end of the body ever runs, the srcdoc never finishes
  // loading, and the ONLY load event is the foreign page's. The tell is the
  // ready handshake instead — our shell posts `__oiVizReady` before load;
  // a load with no ready message is a document that is not ours. Twice is
  // the limit: after that the visual is blocked rather than remounted for
  // ever.
  const [reloadKey, setReloadKey] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const readySeen = useRef(false);
  const resets = useRef(0);
  const onFrameLoad = () => {
    // The ready message is queued before the load event; one macrotask of
    // grace lets it land.
    setTimeout(() => {
      if (readySeen.current) return;
      console.warn("[viz] a visual tried to navigate its frame away — reset");
      if (++resets.current > 2) {
        setBlocked(true);
        return;
      }
      setReloadKey((k) => k + 1);
    }, 50);
  };

  // Streaming: static shell + postMessage swaps (no reload flicker).
  // Done: embed the final fragment directly so inline <script> executes.
  const srcDoc = useMemo(() => {
    const shell = buildShell(theme, dark);
    if (!viz.done) return shell;
    return shell.replace('<div id="root"></div>', `<div id="root">${viz.html}</div>`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viz.done, theme, dark, viz.done ? viz.html : ""]);

  // A new srcdoc is about to load once, legitimately. Reset DURING render
  // (not in an effect): effects run after paint, and a fast srcdoc load can
  // fire before them — then the reset wiped the legitimate load and the
  // navigation that followed counted as the first.
  const lastDoc = useRef<string | null>(null);
  const docKey = `${reloadKey}:${srcDoc}`;
  if (lastDoc.current !== docKey) {
    lastDoc.current = docKey;
    readySeen.current = false;
  }

  // Frame messages: readiness handshake + height reports.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if (e.data?.__oiVizReady) {
        frameReadyRef.current = true;
        readySeen.current = true;
        // Deliver whatever streamed in before the shell could listen. Skip
        // once done — the final srcDoc embeds the html directly (this fires
        // again on that reload) and a swap would kill executed <script>s.
        const cur = latestRef.current;
        if (!cur.done && cur.html) {
          frameRef.current?.contentWindow?.postMessage({ __oiVizHtml: cur.html }, "*");
        }
      } else if (e.data?.__oiViz) {
        setHeight(Math.min(1400, Math.max(60, Number(e.data.height) || 120)));
      }
    };
    addEventListener("message", onMsg);
    return () => removeEventListener("message", onMsg);
  }, []);

  // While streaming, push the partial html into the shell (post-ready only —
  // anything earlier is re-delivered by the handshake above).
  useEffect(() => {
    if (viz.done || !frameReadyRef.current) return;
    frameRef.current?.contentWindow?.postMessage({ __oiVizHtml: viz.html }, "*");
  }, [viz.html, viz.done]);

  return (
    <figure className="my-3 overflow-hidden rounded-2xl border border-border bg-surface">
      <figcaption className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium text-muted">
        <ChartIcon />
        {viz.title}
        {!viz.done ? <span className="ml-auto animate-pulse">rendering…</span> : null}
      </figcaption>
      {blocked ? (
        <p className="px-3 py-4 text-xs text-muted" data-viz-blocked>
          This visual tried to leave the page and was blocked.
        </p>
      ) : (
      <iframe
        key={reloadKey}
        ref={frameRef}
        title={viz.title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={onFrameLoad}
        style={{ height }}
        className="w-full border-0 bg-transparent"
      />
      )}
    </figure>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4v16h16" />
      <path d="M8 16v-5M12 16V8M16 16v-3" />
    </svg>
  );
}
