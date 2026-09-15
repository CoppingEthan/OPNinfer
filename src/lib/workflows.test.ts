import { describe, it, expect } from "vitest";
import {
  MAX_BODY_CHARS,
  MAX_LISTED,
  MAX_NOTES,
  NOTES_HEADING,
  appendNote,
  buildWorkflowsBlock,
  canEdit,
  canLeave,
  canManage,
  clipBody,
  disambiguate,
  isShared,
  newBody,
  normaliseDescription,
  normaliseName,
  roleFor,
} from "./workflows";

const owner = "u-owner";
const mate = "u-mate";
const stranger = "u-stranger";

describe("who may do what", () => {
  const priv = { userId: owner };
  const shared = { userId: owner, members: [{ userId: owner }, { userId: mate }] };

  it("knows the owner, a member, and a stranger apart", () => {
    expect(roleFor(priv, owner)).toBe("owner");
    expect(roleFor(priv, mate)).toBeNull();
    expect(roleFor(shared, mate)).toBe("member");
    expect(roleFor(shared, stranger)).toBeNull();
  });

  it("shared means it has member rows", () => {
    expect(isShared(priv)).toBe(false);
    expect(isShared(shared)).toBe(true);
  });

  it("only the owner renames, deletes or shares", () => {
    expect(canManage("owner")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(null)).toBe(false);
  });

  it("only a member leaves — the owner deletes instead", () => {
    expect(canLeave("member")).toBe(true);
    expect(canLeave("owner")).toBe(false);
  });

  it("anyone it is shared with may EDIT the body", () => {
    // The point of sharing rather than copying: a colleague can fix step 4
    // for everybody instead of forking it.
    expect(canEdit("member")).toBe(true);
    expect(canEdit("owner")).toBe(true);
    expect(canEdit(null)).toBe(false);
  });
});

describe("names", () => {
  it("collapses whitespace and caps length", () => {
    expect(normaliseName("  Rewrite   a\n document  ")).toBe("Rewrite a document");
    expect(normaliseName("x".repeat(200)).length).toBe(60);
    expect(normaliseDescription("a\n\nb").length).toBe(3);
    expect(normaliseDescription("y".repeat(500)).length).toBe(160);
  });
});

describe("disambiguate — the model addresses these BY NAME", () => {
  it("leaves distinct names alone", () => {
    const out = disambiguate([
      { id: "1", name: "Rewrite a document", description: "d" },
      { id: "2", name: "Reply to an email", description: "d" },
    ]);
    expect(out.map((w) => w.name)).toEqual(["Rewrite a document", "Reply to an email"]);
  });

  it("keeps YOUR name plain and labels the shared clash with who shared it", () => {
    const out = disambiguate([
      { id: "2", name: "Rewrite a document", description: "d", sharedBy: "Priya Shah" },
      { id: "1", name: "Rewrite a document", description: "d" },
    ]);
    const names = out.map((w) => w.name);
    expect(names).toContain("Rewrite a document");
    expect(names).toContain("Rewrite a document (from Priya)");
    expect(new Set(names).size).toBe(2);
  });

  it("falls back to a number when even the sharer's name collides", () => {
    const out = disambiguate([
      { id: "1", name: "Plan", description: "d" },
      { id: "2", name: "Plan", description: "d", sharedBy: "Sam Ash" },
      { id: "3", name: "Plan", description: "d", sharedBy: "Sam Bell" },
    ]);
    const names = out.map((w) => w.name);
    expect(new Set(names).size).toBe(3);
  });

  it("never produces two identical names, whatever it is handed", () => {
    const out = disambiguate(
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        name: "Same",
        description: "d",
        sharedBy: i === 0 ? null : "Alex Doe",
      })),
    );
    expect(new Set(out.map((w) => w.name)).size).toBe(12);
  });
});

describe("the per-turn block", () => {
  it("is null when the person has none, so an unused instance pays nothing", () => {
    expect(buildWorkflowsBlock([])).toBeNull();
  });

  it("carries the name and description, and says who shared one", () => {
    const block = buildWorkflowsBlock([
      { id: "1", name: "Rewrite a document", description: "Put a draft into our tone" },
      { id: "2", name: "Weekly update", description: "Turn notes into an update", sharedBy: "Priya Shah" },
    ])!;
    expect(block).toContain("load_workflow");
    expect(block).toContain("Rewrite a document: Put a draft into our tone");
    expect(block).toContain("shared by Priya Shah");
  });

  it("is bounded, so a hoarder cannot inflate every prompt", () => {
    const many = Array.from({ length: MAX_LISTED + 20 }, (_, i) => ({
      id: String(i),
      name: `W${i}`,
      description: "d",
    }));
    const lines = buildWorkflowsBlock(many)!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(MAX_LISTED);
  });
});

describe("appendNote — how a workflow learns without losing what you wrote", () => {
  const when = new Date("2026-09-15T10:00:00Z");

  it("creates the section when there isn't one, leaving the steps untouched", () => {
    const body = "1. Read the draft\n2. Rewrite it";
    const out = appendNote(body, "They prefer British spelling", when);
    expect(out).toContain("1. Read the draft");
    expect(out).toContain("2. Rewrite it");
    expect(out).toContain(NOTES_HEADING);
    expect(out).toContain("- 2026-09-15 — They prefer British spelling");
  });

  it("appends under an existing section rather than starting another", () => {
    const body = `Steps\n\n${NOTES_HEADING}\n\n- 2026-01-01 — first\n`;
    const out = appendNote(body, "second", when);
    expect(out.match(/## Notes from past runs/g)).toHaveLength(1);
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });

  it("NEVER touches anything above the heading", () => {
    const steps = "# Rewrite a document\n\n1. Ask for the audience\n2. Keep quotes verbatim";
    const out = appendNote(`${steps}\n\n${NOTES_HEADING}\n`, "a lesson", when);
    expect(out.startsWith(steps)).toBe(true);
  });

  it("keeps content that comes AFTER the notes section", () => {
    const body = `Steps\n\n${NOTES_HEADING}\n\n- old\n\n## Examples\n\nkeep me`;
    const out = appendNote(body, "new", when);
    expect(out).toContain("## Examples");
    expect(out).toContain("keep me");
    expect(out).toContain("new");
  });

  it("caps the notes so they cannot crowd out the playbook", () => {
    let body = `Steps\n\n${NOTES_HEADING}\n`;
    for (let i = 0; i < MAX_NOTES + 10; i++) body = appendNote(body, `note ${i}`, when);
    const notes = body.split("\n").filter((l) => l.startsWith("- "));
    expect(notes).toHaveLength(MAX_NOTES);
    // The newest survive, the oldest fall off.
    expect(body).toContain(`note ${MAX_NOTES + 9}`);
    expect(body).not.toContain("note 0 ");
  });

  it("ignores an empty note and clips a rambling one", () => {
    const body = `Steps\n\n${NOTES_HEADING}\n`;
    expect(appendNote(body, "   ", when)).toBe(body);
    const long = appendNote(body, "x".repeat(900), when);
    const line = long.split("\n").find((l) => l.startsWith("- "))!;
    expect(line.length).toBeLessThan(330);
  });
});

describe("bodies", () => {
  it("clips on a line boundary rather than mid-word", () => {
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const out = clipBody(body);
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(out.endsWith("\n")).toBe(false);
    expect(out.split("\n").pop()).toMatch(/^line \d+$/);
  });

  it("leaves a body under the cap exactly as it was", () => {
    expect(clipBody("short")).toBe("short");
  });

  it("gives a new workflow somewhere for its first note to go", () => {
    expect(newBody("1. Do the thing")).toContain(NOTES_HEADING);
    expect(appendNote(newBody("1. Do the thing"), "learned", new Date())).toContain("- ");
  });
});
