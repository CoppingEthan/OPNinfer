import { describe, expect, it } from "vitest";
import { annotateAssistantContent, provenanceNote } from "./provenance";

describe("provenanceNote", () => {
  it("returns null when there are no sources", () => {
    expect(provenanceNote(null)).toBeNull();
    expect(provenanceNote({})).toBeNull();
    expect(provenanceNote({ sources: [] })).toBeNull();
    expect(provenanceNote({ rating: "up" })).toBeNull();
  });

  it("lists web source URLs and the re-search nudge", () => {
    const note = provenanceNote({
      sources: [
        { url: "https://npr.org/a", title: "NPR" },
        { url: "https://bbc.com/b", title: "BBC", kind: "web" },
      ],
    });
    expect(note).toContain("live web search");
    expect(note).toContain("https://npr.org/a");
    expect(note).toContain("https://bbc.com/b");
    expect(note).toContain("use the web tools");
  });

  it("caps listed URLs and counts the rest", () => {
    const sources = Array.from({ length: 26 }, (_, i) => ({ url: `https://s${i}.test` }));
    const note = provenanceNote({ sources })!;
    expect(note).toContain("https://s7.test");
    expect(note).not.toContain("https://s8.test");
    expect(note).toContain("(+18 more)");
  });

  it("describes file sources by name", () => {
    const note = provenanceNote({
      sources: [{ url: "", kind: "file", fileId: "f1", title: "report.pdf" }],
    })!;
    expect(note).toContain("reading attached file(s): report.pdf");
    expect(note).not.toContain("live web search");
  });

  it("combines web and file sources", () => {
    const note = provenanceNote({
      sources: [
        { url: "https://npr.org/a" },
        { url: "", kind: "file", title: "notes.txt" },
      ],
    })!;
    expect(note).toContain("live web search");
    expect(note).toContain("notes.txt");
  });
});

describe("annotateAssistantContent", () => {
  it("appends the note only when sources exist", () => {
    expect(annotateAssistantContent("Hello.", null)).toBe("Hello.");
    const out = annotateAssistantContent("News summary.", {
      sources: [{ url: "https://npr.org/a" }],
    });
    expect(out.startsWith("News summary.\n\n[provenance note:")).toBe(true);
  });
});
