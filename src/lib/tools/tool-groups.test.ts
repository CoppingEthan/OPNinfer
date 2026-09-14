import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_GROUPS } from "./types";

/**
 * The Admin → Tools checkboxes and the action that saves them must agree.
 *
 * They didn't: `ask` ("Clarifying questions") was added to the type and to the
 * page, but not to the action's hand-written validator — so unticking it was
 * filtered out before the setting was written. The admin got a green "Saved.",
 * the checkbox stayed unticked until the next reload, and the assistant went
 * on asking questions indefinitely. Any other group unticked in the same save
 * DID persist, which made the switch look like it worked.
 *
 * Both sides now derive from `TOOL_GROUPS`; these tests fail if either drifts.
 */

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** The group ids the Tools page actually offers, read from its source. */
function renderedGroupIds(): string[] {
  const src = read("src/components/admin/tools-forms.tsx");
  const start = src.indexOf("const GROUP_LABELS");
  expect(start, "GROUP_LABELS not found — has the Tools page been restructured?").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n];", start));
  return [...body.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("tool group toggles", () => {
  it("offers a checkbox for something (so this can't pass by reading nothing)", () => {
    expect(renderedGroupIds().length).toBeGreaterThanOrEqual(9);
  });

  it("every group the admin can untick is one the save action accepts", () => {
    const unsaveable = renderedGroupIds().filter(
      (id) => !(TOOL_GROUPS as readonly string[]).includes(id),
    );
    expect(unsaveable, `offered in the UI but silently dropped on save: ${unsaveable.join(", ")}`)
      .toEqual([]);
  });

  it("does not offer a group that isn't real", () => {
    const known = new Set<string>(TOOL_GROUPS);
    expect(renderedGroupIds().filter((id) => !known.has(id))).toEqual([]);
  });

  it("includes the group whose toggle was dead — clarifying questions", () => {
    expect(TOOL_GROUPS).toContain("ask");
    expect(renderedGroupIds()).toContain("ask");
  });

  it("the save action validates against the shared list, not a copy of it", () => {
    // A literal array here is how the two drifted apart in the first place.
    const action = read("src/app/actions/tools.ts");
    expect(action).toMatch(/VALID_GROUPS[^=]*=\s*TOOL_GROUPS/);
  });
});
