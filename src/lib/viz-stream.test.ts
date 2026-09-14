import { describe, expect, it } from "vitest";
import {
  VizStreamParser,
  partialMarkerSuffix,
  VIZ_START,
  VIZ_END,
  type VizEvent,
} from "./viz-stream";

/** Run a stream through the parser and fold the ordered events. */
function run(deltas: string[]) {
  const p = new VizStreamParser();
  const events: VizEvent[] = [];
  for (const d of deltas) events.push(...p.feed(d));
  events.push(...p.flush());
  let text = "";
  let viz = "";
  let starts = 0;
  let ends = 0;
  const blocks: string[] = [];
  const titles: (string | undefined)[] = [];
  for (const e of events) {
    if (e.kind === "text") text += e.data;
    else if (e.kind === "viz") {
      viz += e.data;
      blocks[blocks.length - 1] += e.data;
    } else if (e.kind === "start") {
      starts++;
      blocks.push("");
      titles.push(e.title);
    } else ends++;
  }
  return { text, viz, starts, ends, blocks, titles };
}

describe("partialMarkerSuffix", () => {
  it("finds partial prefixes at the tail", () => {
    expect(partialMarkerSuffix("hello @@@VIZ-ST", VIZ_START)).toBe(9);
    expect(partialMarkerSuffix("hello @", VIZ_START)).toBe(1);
    expect(partialMarkerSuffix("hello", VIZ_START)).toBe(0);
  });
  it("never returns the full marker length", () => {
    expect(partialMarkerSuffix(VIZ_START, VIZ_START)).toBeLessThan(VIZ_START.length);
  });
});

describe("VizStreamParser", () => {
  it("passes plain text straight through", () => {
    const r = run(["Hello ", "world."]);
    expect(r).toMatchObject({ text: "Hello world.", viz: "", starts: 0, ends: 0 });
  });

  it("extracts a viz block in one delta", () => {
    const r = run([`Here you go:\n${VIZ_START}\n<svg>x</svg>\n${VIZ_END}\nDone.`]);
    expect(r.text).toBe("Here you go:\nDone.");
    expect(r.viz).toBe("<svg>x</svg>");
    expect(r.starts).toBe(1);
    expect(r.ends).toBe(1);
  });

  it("handles markers straddling delta boundaries (3-char chunks)", () => {
    const full = `Intro\n${VIZ_START}\n<div>chart</div>\n${VIZ_END}\nOutro`;
    const deltas: string[] = [];
    for (let i = 0; i < full.length; i += 3) deltas.push(full.slice(i, i + 3));
    const r = run(deltas);
    expect(r.text).toBe("Intro\nOutro");
    expect(r.viz).toBe("<div>chart</div>");
    expect(r.starts).toBe(1);
    expect(r.ends).toBe(1);
  });

  it("handles single-character streaming", () => {
    const full = `A${VIZ_START}<b>v</b>${VIZ_END}B`;
    const r = run(full.split(""));
    expect(r.text).toBe("AB");
    expect(r.viz).toBe("<b>v</b>");
  });

  it("extracts a title from the START marker line", () => {
    const r = run([`${VIZ_START} Quarterly revenue (£k)\n<svg>x</svg>\n${VIZ_END}`]);
    expect(r.titles).toEqual(["Quarterly revenue (£k)"]);
    expect(r.viz).toBe("<svg>x</svg>");
  });

  it("extracts a title that straddles delta boundaries", () => {
    const full = `${VIZ_START} My chart title\n<div>d</div>\n${VIZ_END}`;
    const deltas: string[] = [];
    for (let i = 0; i < full.length; i += 2) deltas.push(full.slice(i, i + 2));
    const r = run(deltas);
    expect(r.titles).toEqual(["My chart title"]);
    expect(r.viz).toBe("<div>d</div>");
  });

  it("no title when the marker line is bare", () => {
    const r = run([`${VIZ_START}\n<svg>y</svg>\n${VIZ_END}`]);
    expect(r.titles).toEqual([undefined]);
    expect(r.viz).toBe("<svg>y</svg>");
  });

  it("title ends at '<' when the fragment shares the marker line", () => {
    const r = run([`${VIZ_START} Sales<svg>z</svg>${VIZ_END}`]);
    expect(r.titles).toEqual(["Sales"]);
    expect(r.viz).toBe("<svg>z</svg>");
  });

  it("releases held @ runs that never become markers", () => {
    const r = run(["email: user@", "@example.com and @@@ art"]);
    expect(r.text).toBe("email: user@@example.com and @@@ art");
    expect(r.viz).toBe("");
  });

  it("keeps internal viz newlines but trims the block edges", () => {
    const r = run([`${VIZ_START}\n<div>\n  <p>a</p>\n</div>\n${VIZ_END}`]);
    expect(r.viz).toBe("<div>\n  <p>a</p>\n</div>");
  });

  it("closes an unterminated viz block at flush", () => {
    const r = run([`${VIZ_START}\n<svg>partial`]);
    expect(r.viz).toBe("<svg>partial");
    expect(r.ends).toBe(1);
    expect(r.text).toBe("");
  });

  it("supports two viz blocks in one reply, kept separate", () => {
    const r = run([
      `${VIZ_START}\n<p>one</p>\n${VIZ_END}\nmiddle\n${VIZ_START}\n<p>two</p>\n${VIZ_END}`,
    ]);
    expect(r.starts).toBe(2);
    expect(r.ends).toBe(2);
    expect(r.blocks).toEqual(["<p>one</p>", "<p>two</p>"]);
    expect(r.text.trim()).toBe("middle");
  });
});
