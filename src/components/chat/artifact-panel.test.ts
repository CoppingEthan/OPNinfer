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

describe("the preview frame", () => {
  it("does NOT sandbox a PDF — Chrome's viewer refuses to run in a sandboxed frame", () => {
    // Measured in real Chrome, all six combinations: sandbox="" and even
    // sandbox="allow-scripts" draw the sad-face placeholder, with or without
    // the CSP header; no attribute renders the document. A bare sandbox=""
    // here means every Office and PDF preview is silently blank.
    expect(SRC).toMatch(/meta\.kind === "pdf" \|\| meta\.kind === "office" \? \{\} : \{ sandbox/);
    // …and the attribute is never set unconditionally on the frame.
    expect(SRC).not.toMatch(/<iframe[\s\S]{0,600}?\n\s+sandbox=""/);
  });

  it("still sandboxes everything else, and the ROUTE still sends CSP: sandbox", () => {
    // What makes dropping the attribute safe for a PDF: the response is still
    // in an opaque origin and still nosniff.
    expect(SRC).toContain('sandbox: "" as const');
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/files/[id]/preview/route.ts"),
      "utf8",
    );
    expect(route).toContain('"Content-Security-Policy": "sandbox"');
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
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
