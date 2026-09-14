---
name: visualize
description: Design guidance for inline charts, diagrams and visuals emitted with the @@@VIZ markers.
---

# Visualisation design guide

Load this before building any non-trivial chart or diagram. Mechanics: emit
the fragment DIRECTLY in your reply between plain-text markers (no tool call,
never inside a code fence), with the title on the START line:
`@@@VIZ-START Your title here` … fragment … `@@@VIZ-END`. Start emitting
immediately — the visual renders live as you write.

## Layout
- The frame is ~720px wide, auto-height. Design for that width; make SVGs
  `width="100%"` with a `viewBox`.
- One visual = one idea. Prefer two separate visuals over one crowded one.
- Margins: leave 8–12px breathing room; axis labels must never clip.

## Colour & theme
- Use ONLY the provided CSS variables — they adapt to light/dark:
  text `var(--fg)`, secondary text `var(--muted)`, lines `var(--border)`,
  emphasis `var(--accent)`, panel `var(--surface)`.
- Series colours, in order of use: `var(--blue)`, `var(--teal)`,
  `var(--coral)`, `var(--amber)`, `var(--purple)`, `var(--green)`,
  `var(--pink)`, `var(--red)`, `var(--gray)`. Area/bar fills: the matching
  `var(--blue-fill)` etc., with the solid colour as a 1.5px stroke.
- Never hardcode hex colours; never use gradients, shadows, blur or glow.

## Typography & style
- Flat design. Sentence case labels. Minimum 11px text; 400 weight (500 for
  emphasis only). Numbers right-aligned in tables.
- No emoji anywhere in the visual — use SVG shapes for icons.
- All explanatory prose belongs in the chat text OUTSIDE the markers; the
  visual carries only its own labels, values and a short title if needed.

## Technique
- Prefer pure SVG for charts (bars, lines, donuts) — deterministic and crisp.
- Inline `<script>` runs (sandboxed, no network) for interactivity, but
  external libraries/CDNs will NOT load — don't reference them.
- Tables: plain HTML with `var(--border)` borders and 4px/8px cell padding.
- Bar charts: 60–70% bar width, gap between groups, value labels at bar ends
  when there are ≤8 bars.
- Always include units and a source line (11px, `var(--muted)`) when the data
  came from a file or the web.
