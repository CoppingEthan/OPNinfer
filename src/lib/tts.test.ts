import { describe, expect, it } from "vitest";
import {
  FIRST_SEGMENT_CHARS,
  MAX_TTS_CHARS,
  SEGMENT_CHARS,
  speakableText,
  splitSpeech,
  stripLeadingId3,
} from "./tts";

describe("speakableText", () => {
  it("announces fenced code blocks instead of reading them", () => {
    const out = speakableText("Here you go:\n```python\nprint('hi')\n```\nDone.");
    expect(out).toContain("Code block omitted");
    expect(out).not.toContain("print");
    expect(out).toContain("Done.");
  });

  it("handles an unclosed fence at the end of a reply", () => {
    const out = speakableText("Sure:\n```js\nlet x = 1;");
    expect(out).not.toContain("let x");
    expect(out).toContain("Code block omitted");
  });

  it("keeps link labels and drops targets and bare URLs", () => {
    const out = speakableText("See [the docs](https://example.com/a?b=c) or https://raw.example.com/x");
    expect(out).toContain("the docs");
    expect(out).not.toContain("example.com");
    expect(out).toContain("link");
  });

  it("keeps inline code content without backticks", () => {
    expect(speakableText("Run `pnpm dev` now")).toBe("Run pnpm dev now");
  });

  it("strips headings, list markers, blockquotes and emphasis", () => {
    const out = speakableText("## Title\n> quoted\n- **bold** item\n2. second *thing*");
    expect(out).toContain("Title");
    expect(out).toContain("quoted");
    expect(out).toContain("bold item");
    expect(out).toContain("second thing");
    expect(out).not.toMatch(/[#>*]/);
  });

  it("reads table cells and drops separator rows", () => {
    const out = speakableText("| Name | Size |\n|---|---|\n| cat | small |");
    expect(out).toContain("Name, Size");
    expect(out).toContain("cat, small");
    expect(out).not.toContain("---");
    expect(out).not.toContain("|");
  });

  it("preserves snake_case identifiers while stripping emphasis underscores", () => {
    const out = speakableText("Call memory_create with _emphasis_ intact");
    expect(out).toContain("memory_create");
    expect(out).toContain("emphasis intact");
  });

  it("turns image markdown into its alt text", () => {
    expect(speakableText("![a sunny beach](img.png)")).toBe("a sunny beach");
  });

  it("collapses newlines into sentence pauses", () => {
    expect(speakableText("First line\n\nSecond line")).toBe("First line. Second line");
  });

  it("caps very long replies at a sentence boundary", () => {
    const long = `${"A sentence here. ".repeat(1000)}`;
    const out = speakableText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
    expect(out.endsWith(".")).toBe(true);
  });
});

describe("splitSpeech", () => {
  it("returns one segment for a short reply", () => {
    expect(splitSpeech("Just a short answer.")).toEqual(["Just a short answer."]);
  });

  it("keeps the first segment small for a fast playback start", () => {
    const text = "One short sentence. ".repeat(60);
    const segments = splitSpeech(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].length).toBeLessThanOrEqual(FIRST_SEGMENT_CHARS + 30);
  });

  it("ramps segment sizes and respects the cap", () => {
    const text = "One short sentence. ".repeat(200);
    const segments = splitSpeech(text);
    for (const [i, s] of segments.entries()) {
      // A whole sentence may overshoot a small budget slightly — tolerance.
      const limit = i === 0 ? FIRST_SEGMENT_CHARS : Math.min(SEGMENT_CHARS, 140 * 2 ** (i - 1));
      expect(s.length).toBeLessThanOrEqual(limit + 30);
    }
    // Later segments actually reach the cap (packing works).
    expect(segments.some((s) => s.length > SEGMENT_CHARS - 100)).toBe(true);
  });

  it("never splits mid-sentence, even an oversized one", () => {
    const monster = `${"word ".repeat(200)}end.`;
    const segments = splitSpeech(`Short opener. ${monster}`);
    expect(segments.some((s) => s.includes("end."))).toBe(true);
    for (const s of segments) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it("preserves every word across segments", () => {
    const text = "Alpha bravo charlie. Delta echo foxtrot! Golf hotel india? Juliet kilo lima. ".repeat(20);
    const joined = splitSpeech(text).join(" ").replace(/\s+/g, " ");
    expect(joined.replace(/\s/g, "")).toBe(text.trim().replace(/\s/g, ""));
  });
});

describe("stripLeadingId3", () => {
  it("removes an ID3v2 tag using its synchsafe size", () => {
    // "ID3" v2.4, flags 0, synchsafe size 35 → 10-byte header + 35-byte tag.
    const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 35, ...new Array(35).fill(0)]);
    const frames = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
    const joined = new Uint8Array([...tag, ...frames]);
    expect([...stripLeadingId3(joined)]).toEqual([...frames]);
  });

  it("returns untagged audio unchanged", () => {
    const frames = new Uint8Array([0xff, 0xfb, 9, 8, 7]);
    expect(stripLeadingId3(frames)).toBe(frames);
  });
});
