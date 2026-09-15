import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Source pins for the artifact panel.
 *
 * Both of these are failures with NO runtime symptom — nothing throws, nothing
 * is logged, and the panel looks like it is working right up until you read
 * what it is showing. Neither can be caught by a normal browser test either:
 * Playwright's bundled Chromium has no PDF viewer, so it renders every PDF as
 * a blank frame whether the code is right or wrong.
 */
const SRC = readFileSync(path.join(process.cwd(), "src/components/chat/artifact-panel.tsx"), "utf8");
const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

describe("a PDF is never handed to the browser's viewer", () => {
  const PDFVIEW = readFileSync(path.join(process.cwd(), "src/components/chat/pdf-view.tsx"), "utf8");

  it("renders PDFs itself rather than framing them", () => {
    // Two browser behaviours make an <iframe> unusable for a PDF, and NEITHER
    // is detectable from the page: a sandboxed frame is refused outright, and
    // a reader who has set "Download PDF files instead of automatically
    // opening them" gets a grey icon and an Open button in place of every
    // embedded PDF on the web. Both were reproduced; the second is what the
    // owner actually saw.
    expect(SRC).toContain("<PdfView");
    expect(SRC).toMatch(/\) : pdfish \? \(/);
    // The branch order matters: pdfish must be tested BEFORE isFramed, or a
    // PDF falls into the iframe again.
    expect(SRC.indexOf(") : pdfish ? (")).toBeLessThan(SRC.indexOf(") : isFramed(meta.kind) ? ("));
  });

  it("and the frame that is left — markup only — is sandboxed unconditionally", () => {
    // With PDFs gone, everything reaching the iframe is markup somebody else
    // wrote, so there is no case left in which the sandbox should be relaxed.
    expect(SRC).toMatch(/<iframe[\s\S]{0,900}?\n\s+sandbox=""/);
    expect(SRC).not.toContain('meta.kind === "office" ? {} : { sandbox');
  });

  it("serves the viewer's own assets from THIS origin, never a CDN", () => {
    // A portal with no outbound internet has to render documents identically.
    expect(PDFVIEW).toContain('"/api/pdfjs/build/pdf.worker.min.mjs"');
    expect(PDFVIEW).toContain('"/api/pdfjs/cmaps/"');
    expect(PDFVIEW).toContain('"/api/pdfjs/standard_fonts/"');
    expect(PDFVIEW).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/);
  });

  it("…and the standalone build is told to ship them", () => {
    // Nothing IMPORTS the cmaps or the worker — the route reads them off disk
    // at runtime — so the tracer would ship none of them and every document
    // would fail to open in production only. Same class as CHANGELOG.md.
    const cfg = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    expect(cfg).toContain("pdfjs-dist@*/node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
    expect(cfg).toContain("pdfjs-dist@*/node_modules/pdfjs-dist/cmaps/**");
    expect(cfg).toContain("pdfjs-dist@*/node_modules/pdfjs-dist/standard_fonts/**");
  });

  it("the preview route still sandboxes and nosniffs what it serves", () => {
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/files/[id]/preview/route.ts"),
      "utf8",
    );
    expect(route).toContain('"Content-Security-Policy": "sandbox"');
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
  });

  it("the asset route is allowlisted, not a reader for all of node_modules", () => {
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/pdfjs/[...path]/route.ts"),
      "utf8",
    );
    expect(route).toContain("ALLOWED");
    expect(route).toContain('rel.includes("..")');
    expect(route).toMatch(/startsWith\(pkg \+ path\.sep\)/);
    // And it must NOT ask the bundler where the package is: webpack rewrites
    // require.resolve inside a route into its own module path, which no stat
    // will ever find — the symptom is a silent 404 and a viewer that never
    // opens a document.
    //
    // CODE lines only. The comment above says "require.resolve" in order to
    // explain why it is absent, and an assertion over the whole file fails on
    // its own explanation — the trap ui/dialog.test.ts already fell into.
    const code = route
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(" ");
    expect(code).not.toContain("require.resolve");
    expect(code).not.toContain("createRequire");
    // And it is behind sign-in like every other /api route.
    expect(route).toContain("await auth()");
  });
});

describe("the panel slides rather than appearing", () => {
  it("uses a keyframe, not a transition on a class that flips after mount", () => {
    // A transition needs the browser to have painted the starting state. An
    // element inserted and revealed inside one frame has none, so it jumps —
    // which is exactly what the first version did (45 frames, one position).
    expect(SRC).toContain("oi-artifact-in");
    expect(SRC).toContain("oi-artifact-out");
    expect(SRC).not.toContain("translate-x-full");
  });

  it("and the CSS defines both directions, with reduced motion honoured", () => {
    expect(CSS).toMatch(/@keyframes oi-artifact-in/);
    expect(CSS).toMatch(/@keyframes oi-artifact-out/);
    expect(CSS).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,200}animation: none/);
    // `backwards`, never `both`: a transform left on the element afterwards
    // gives it its own stacking layer for ever — the lesson the file cards'
    // entrance animation already taught.
    expect(CSS).toMatch(/\.oi-artifact-in \{[\s\S]{0,140}backwards;/);
  });
});
