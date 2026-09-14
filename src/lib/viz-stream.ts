/**
 * Streaming parser for the visualisation marker protocol (v0.3 step 8; tool
 * retired 2026-07-13 — the model emits markers DIRECTLY, no declaration call).
 *
 * The model emits, as plain text inside its reply:
 *   @@@VIZ-START Optional title on the marker line
 *   <svg>…</svg> or HTML fragment
 *   @@@VIZ-END
 *
 * The chat route feeds text deltas through this parser and receives ORDERED
 * events: user-visible text, viz content, and block start/end boundaries
 * (start carries the title). Markers may straddle delta boundaries — a
 * possible partial marker (and, in viz mode, a short trailing-whitespace run
 * that may precede the END marker) is held back until disambiguated; the
 * title line is held until its newline arrives. Pure module; unit-tested.
 */

export const VIZ_START = "@@@VIZ-START";
export const VIZ_END = "@@@VIZ-END";
/** Max trailing-whitespace run held back in viz mode awaiting a marker. */
const MAX_WS_HOLD = 16;
/** Title runs to end-of-line; cap the hold so a missing newline can't stall. */
const MAX_TITLE_HOLD = 160;

/** Longest suffix of `s` that is a proper prefix of `marker`. */
export function partialMarkerSuffix(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

export type VizEvent =
  | { kind: "text"; data: string }
  | { kind: "viz"; data: string }
  | { kind: "start"; title?: string }
  | { kind: "end" };

export class VizStreamParser {
  private mode: "text" | "title" | "viz" = "text";
  private held = "";
  /** Strip leading whitespace of a freshly-started viz block. */
  private stripLead = false;

  private emitViz(events: VizEvent[], data: string): void {
    let out = data;
    if (this.stripLead) {
      out = out.replace(/^\s+/, "");
      if (out.length === 0) return; // still nothing but lead whitespace
      this.stripLead = false;
    }
    if (out) events.push({ kind: "viz", data: out });
  }

  /** Close the title line: emit `start` (with any title) and enter viz mode. */
  private startBlock(events: VizEvent[], titleRaw: string): void {
    const title = titleRaw.replace(/^[ \t:—-]+/, "").trim().slice(0, 120);
    events.push(title ? { kind: "start", title } : { kind: "start" });
    this.mode = "viz";
    this.stripLead = true;
  }

  feed(delta: string): VizEvent[] {
    let work = this.held + delta;
    this.held = "";
    const events: VizEvent[] = [];

    for (;;) {
      if (this.mode === "title") {
        // The title runs to the first newline — or the first "<", since a
        // fragment always opens with a tag (covers single-line blocks like
        // "@@@VIZ-START<svg>…" where the model skipped the newline).
        const nl = work.indexOf("\n");
        const lt = work.indexOf("<");
        const cut = [nl, lt].filter((i) => i !== -1).sort((a, b) => a - b)[0] ?? -1;
        if (cut === -1 && work.length < MAX_TITLE_HOLD) {
          this.held = work;
          return events;
        }
        const end = cut === -1 ? work.length : cut;
        this.startBlock(events, work.slice(0, end).replace(/\r$/, ""));
        // A newline is consumed; a "<" stays — it's the fragment's first char.
        work = work.slice(cut === nl && cut !== -1 ? end + 1 : end);
        continue;
      }

      const marker = this.mode === "text" ? VIZ_START : VIZ_END;
      const idx = work.indexOf(marker);
      if (idx !== -1) {
        const before = work.slice(0, idx);
        if (this.mode === "text") {
          // Keep at most one newline before the marker.
          const text = before.replace(/\n[ \t]*$/, "\n");
          if (text) events.push({ kind: "text", data: text });
          // The rest of the marker's line (if any) is the title.
          this.mode = "title";
          work = work.slice(idx + marker.length);
        } else {
          this.emitViz(events, before.replace(/\s+$/, ""));
          events.push({ kind: "end" });
          this.mode = "text";
          // Swallow one newline immediately after the END marker.
          work = work.slice(idx + marker.length).replace(/^[ \t]*\r?\n/, "");
        }
        continue;
      }

      // No full marker: hold back a possible partial marker at the tail —
      // and, in viz mode, an adjacent trailing-whitespace run (it may turn
      // out to precede the END marker and must not leak into the viz).
      let holdFrom = work.length - partialMarkerSuffix(work, marker);
      if (this.mode === "viz") {
        while (
          holdFrom > 0 &&
          work.length - holdFrom < MAX_WS_HOLD &&
          /[ \t\r\n]/.test(work[holdFrom - 1])
        ) {
          holdFrom--;
        }
      }
      const release = work.slice(0, holdFrom);
      this.held = work.slice(holdFrom);
      if (release) {
        if (this.mode === "text") events.push({ kind: "text", data: release });
        else this.emitViz(events, release);
      }
      return events;
    }
  }

  /** End of stream: whatever is held can no longer become a marker. */
  flush(): VizEvent[] {
    const rest = this.held;
    this.held = "";
    const events: VizEvent[] = [];
    if (this.mode === "text") {
      if (rest) events.push({ kind: "text", data: rest });
    } else if (this.mode === "title") {
      // Stream ended on the marker line — open and close an empty block.
      this.startBlock(events, rest);
      events.push({ kind: "end" });
      this.mode = "text";
    } else {
      // Unterminated viz block — release the remainder and close it.
      this.emitViz(events, rest.replace(/\s+$/, ""));
      events.push({ kind: "end" });
      this.mode = "text";
    }
    return events;
  }
}
