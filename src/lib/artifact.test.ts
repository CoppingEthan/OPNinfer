import { describe, it, expect } from "vitest";
import {
  MAX_PREVIEW_BYTES,
  canPreview,
  extensionOf,
  formatSize,
  isFramed,
  isTextual,
  languageFor,
  previewKind,
  previewUrl,
} from "./artifact";

describe("images are never previewed", () => {
  // The owner's rule: an image is the answer and already renders inline in the
  // reply. Showing it in a side panel too puts the same picture in two places,
  // one of them worse.
  it("refuses every image, by type and by name", () => {
    for (const [mime, name] of [
      ["image/png", "chart.png"],
      ["image/jpeg", "photo.jpg"],
      ["image/svg+xml", "logo.svg"],
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
});

describe("what a file previews as", () => {
  it("reads the name when the stored type is octet-stream", () => {
    expect(previewKind("application/octet-stream", "report.md")).toBe("markdown");
    expect(previewKind("application/octet-stream", "build.py")).toBe("code");
    expect(previewKind("application/octet-stream", "advert.html")).toBe("html");
    expect(previewKind("application/octet-stream", "invoice.pdf")).toBe("pdf");
    expect(previewKind("application/octet-stream", "rows.csv")).toBe("text");
  });

  it("honours a real mime type", () => {
    expect(previewKind("text/markdown", "x")).toBe("markdown");
    expect(previewKind("application/pdf", "x")).toBe("pdf");
    expect(previewKind("text/html", "x")).toBe("html");
    expect(previewKind("text/plain", "x")).toBe("text");
  });

  it("says none for things a browser cannot show honestly", () => {
    expect(previewKind("application/zip", "bundle.zip")).toBe("none");
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("none");
    expect(previewKind("application/octet-stream", "data.bin")).toBe("none");
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
