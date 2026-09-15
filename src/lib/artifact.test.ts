import { describe, it, expect } from "vitest";
import {
  MAX_PREVIEW_BYTES,
  canPreview,
  extensionOf,
  formatSize,
  isFramed,
  isTextual,
  languageFor,
  parseTable,
  previewKind,
  previewUrl,
  splitDelimited,
} from "./artifact";

describe("RASTER images are never previewed", () => {
  // The owner's rule: an image is the answer and already renders inline in the
  // reply. Showing it in a side panel too puts the same picture in two places,
  // one of them worse.
  it("refuses every image, by type and by name", () => {
    for (const [mime, name] of [
      ["image/png", "chart.png"],
      ["image/jpeg", "photo.jpg"],
      ["image/webp", "hero.webp"],
      ["image/gif", "loop.gif"],
    ] as const) {
      expect(previewKind(mime, name), name).toBe("none");
    }
  });

  it("refuses an image even when the stored type is useless", () => {
    // syncPool registers everything the Sandbox writes as octet-stream, so the
    // NAME is all there is to go on.
    expect(previewKind("application/octet-stream", "advert-1080.png")).toBe("none");
  });

  it("refuses one whose name lies about being text", () => {
    expect(previewKind("image/png", "notes.md")).toBe("none");
  });

  it("refuses audio and video too", () => {
    expect(previewKind("audio/mpeg", "call.mp3")).toBe("none");
    expect(previewKind("video/mp4", "clip.mp4")).toBe("none");
  });

  it("but SVG is NOT one of them", () => {
    // Vector source, and never rendered inline in a reply — so unlike a PNG
    // there is nothing to duplicate, and it is usually the deliverable.
    expect(previewKind("image/svg+xml", "logo.svg")).toBe("svg");
    expect(previewKind("application/octet-stream", "mark.svg")).toBe("svg");
    expect(isFramed("svg")).toBe(true);
  });
});

describe("what a file previews as", () => {
  it("reads the name when the stored type is octet-stream", () => {
    expect(previewKind("application/octet-stream", "report.md")).toBe("markdown");
    expect(previewKind("application/octet-stream", "build.py")).toBe("code");
    expect(previewKind("application/octet-stream", "advert.html")).toBe("html");
    expect(previewKind("application/octet-stream", "invoice.pdf")).toBe("pdf");
    expect(previewKind("application/octet-stream", "rows.csv")).toBe("csv");
  });

  it("honours a real mime type", () => {
    expect(previewKind("text/markdown", "x")).toBe("markdown");
    expect(previewKind("application/pdf", "x")).toBe("pdf");
    expect(previewKind("text/html", "x")).toBe("html");
    expect(previewKind("text/plain", "x")).toBe("text");
  });

  it("sends office files down the LibreOffice route, for the real layout", () => {
    expect(previewKind("application/octet-stream", "report.docx")).toBe("office");
    expect(previewKind("application/octet-stream", "budget.xlsx")).toBe("office");
    expect(previewKind("application/octet-stream", "deck.pptx")).toBe("office");
    expect(previewKind("application/octet-stream", "notes.odt")).toBe("office");
    // …and by mime when the name lost its extension.
    expect(
      previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a"),
    ).toBe("office");
    expect(isFramed("office")).toBe(true);
  });

  it("falls back to the worker's text for what LibreOffice cannot lay out", () => {
    expect(previewKind("application/zip", "bundle.zip")).toBe("converted");
    expect(previewKind("application/octet-stream", "book.epub")).toBe("converted");
    expect(previewKind("application/octet-stream", "thread.eml")).toBe("converted");
  });

  it("draws delimited files as a table", () => {
    expect(previewKind("text/csv", "rows.csv")).toBe("csv");
    expect(previewKind("application/octet-stream", "rows.tsv")).toBe("csv");
  });

  it("still says none for something genuinely unshowable", () => {
    expect(previewKind("application/octet-stream", "data.bin")).toBe("none");
    expect(previewKind("application/x-executable", "tool")).toBe("none");
  });

  it("handles extensionless names that carry their type", () => {
    expect(extensionOf("Dockerfile")).toBe("dockerfile");
    expect(previewKind(null, "Dockerfile")).toBe("code");
    expect(extensionOf("/tmp/deep/path/notes.md")).toBe("md");
  });

  it("splits textual from framed", () => {
    expect(isTextual("markdown")).toBe(true);
    expect(isTextual("code")).toBe(true);
    expect(isTextual("html")).toBe(false);
    expect(isFramed("html")).toBe(true);
    expect(isFramed("pdf")).toBe(true);
    expect(isFramed("text")).toBe(false);
  });
});

describe("a preview is not a download", () => {
  it("refuses a textual file too big to read comfortably", () => {
    expect(canPreview({ mimeType: "text/csv", filename: "big.csv", sizeBytes: MAX_PREVIEW_BYTES + 1 })).toBe(false);
    expect(canPreview({ mimeType: "text/csv", filename: "ok.csv", sizeBytes: 5_000 })).toBe(true);
  });

  it("lets a framed kind through at any size — the browser streams it", () => {
    expect(canPreview({ mimeType: "application/pdf", filename: "big.pdf", sizeBytes: 90_000_000 })).toBe(true);
  });

  it("an office file needs EITHER the converter or prepared text", () => {
    const f = { mimeType: "application/octet-stream", filename: "report.docx", sizeBytes: 900_000 };
    expect(canPreview({ ...f, officeToPdf: true, hasPrepared: false })).toBe(true);
    expect(canPreview({ ...f, officeToPdf: false, hasPrepared: true })).toBe(true);
    // Neither: a spinner that never resolves is worse than an honest Download.
    expect(canPreview({ ...f, officeToPdf: false, hasPrepared: false })).toBe(false);
  });

  it("a .zip with no prepared text has nothing to show", () => {
    const f = { mimeType: "application/zip", filename: "b.zip", sizeBytes: 1000 };
    expect(canPreview({ ...f, hasPrepared: true })).toBe(true);
    expect(canPreview({ ...f, hasPrepared: false })).toBe(false);
  });

  it("never previews an image however small", () => {
    expect(canPreview({ mimeType: "image/png", filename: "tiny.png", sizeBytes: 12 })).toBe(false);
  });
});

describe("presentation", () => {
  it("formats sizes the way a person reads them", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(5_734)).toBe("5.6 KB");
    expect(formatSize(1024 * 1024 * 3.5)).toBe("3.5 MB");
    expect(formatSize(1024 * 1024 * 40)).toBe("40 MB");
    expect(formatSize(-1)).toBe("");
  });

  it("maps files to a Prism grammar, or null for plain", () => {
    expect(languageFor("a.ts")).toBe("typescript");
    expect(languageFor("run.sh")).toBe("bash");
    expect(languageFor("page.html")).toBe("markup");
    expect(languageFor("notes.txt")).toBeNull();
  });
});

describe("the version in the URL is what makes updates land", () => {
  // The browser caches an in-page fetch by URL alone, so a re-presented file
  // under the same id would keep showing the old bytes — the bug that had to
  // be fixed for re-presented images.
  it("carries the version when there is one", () => {
    expect(previewUrl("abc", 1726389000000)).toBe("/api/files/abc/preview?v=1726389000000");
  });

  it("omits it cleanly when there is not", () => {
    expect(previewUrl("abc")).toBe("/api/files/abc/preview");
    expect(previewUrl("abc", null)).toBe("/api/files/abc/preview");
  });

  it("produces a DIFFERENT url for a different version", () => {
    expect(previewUrl("abc", 1)).not.toBe(previewUrl("abc", 2));
  });
});

describe("delimited files", () => {
  it("splits on the delimiter, honouring quotes", () => {
    expect(splitDelimited("a,b,c", ",")).toEqual(["a", "b", "c"]);
    expect(splitDelimited('a,"b,c",d', ",")).toEqual(["a", "b,c", "d"]);
    expect(splitDelimited('"he said ""hi""",x', ",")).toEqual(['he said "hi"', "x"]);
    expect(splitDelimited("a\tb", "\t")).toEqual(["a", "b"]);
  });

  it("takes the first row as the header and caps the body", () => {
    const csv = ["name,qty", ...Array.from({ length: 500 }, (_, i) => `row${i},${i}`)].join("\n");
    const t = parseTable(csv, "x.csv", 200);
    expect(t.header).toEqual(["name", "qty"]);
    expect(t.rows).toHaveLength(200);
    // Saying so matters: showing 200 of 500 silently is a lie.
    expect(t.truncated).toBe(true);
  });

  it("does not claim truncation when it showed everything", () => {
    const t = parseTable("a,b\n1,2\n3,4", "x.csv", 200);
    expect(t.rows).toHaveLength(2);
    expect(t.truncated).toBe(false);
  });

  it("uses tabs for a .tsv", () => {
    const t = parseTable("a\tb\n1\t2", "x.tsv");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows[0]).toEqual(["1", "2"]);
  });
});
