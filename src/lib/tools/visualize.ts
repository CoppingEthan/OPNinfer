import "server-only";

/**
 * Inline visualisations (v0.3 step 8; REDESIGNED 2026-07-13, owner call).
 *
 * Originally a declaration tool (`render_visualization`) taught the marker
 * protocol via its result — but models repeatedly re-declared instead of
 * emitting (seen live: 4 calls burning tool rounds, then view_image("dummy")
 * attempts), and the visual couldn't start streaming until the tool round-
 * trips finished. Now the protocol is taught UP FRONT as a system block
 * (mirroring the OWUI inline-visualizer approach): the model just writes the
 * markers directly, so the chart streams from its first token. The title
 * rides the START marker line; `VizStreamParser` extracts it server-side.
 * The deep design guide still lives in the `visualize` skill.
 *
 * The block is injected by the chat route whenever the `visualize` group
 * isn't admin-disabled (Tools page toggle — group survives with no tools).
 */

export const VIZ_PROTOCOL_BLOCK = `INLINE VISUALS — you can render charts, diagrams and small interactive visuals DIRECTLY in the chat. When a visual would serve better than prose (data comparisons, trends, structures), emit one — no tool call needed — like this, as plain text (NEVER inside a code fence):

@@@VIZ-START Short title for the visual
<svg viewBox="0 0 720 320" width="100%">…</svg>
@@@VIZ-END

Rules:
- Markers are plain text; the title sits on the START line. Start emitting the fragment IMMEDIATELY — it renders live as you write.
- Emit a FRAGMENT (svg/div/style/script) — no <!DOCTYPE>, <html>, <head> or <body>. It renders in a sandboxed frame ~720px wide, auto-height, matching the app theme.
- Use the provided CSS variables: var(--bg) var(--fg) var(--muted) var(--border) var(--accent) var(--font-sans) var(--font-mono), plus colour ramps var(--blue) var(--teal) var(--coral) var(--amber) var(--purple) var(--green) var(--pink) var(--red) var(--gray) (each with a -fill variant, e.g. var(--blue-fill)). Never hardcode hex colours.
- Flat design: no gradients, shadows or emoji; sentence-case labels; min 11px text. Explanatory prose belongs in the chat OUTSIDE the markers, after @@@VIZ-END.
- Inline <script> runs sandboxed with no network; external libraries will NOT load.
- Before a complex or unfamiliar visual, load the "visualize" skill for the full design guide.
- You cannot see or re-open your own visual (view_image is for FILES only — a visual is not a file), and no tool renders it for you. Emit the markers, trust the render, move on.`;
