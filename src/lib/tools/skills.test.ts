import { describe, expect, it } from "vitest";
import { parseSkillMd } from "./skills";

describe("parseSkillMd", () => {
  it("parses anthropics/skills-style frontmatter", () => {
    const { meta, body } = parseSkillMd(
      "---\nname: email-drafting\ndescription: Draft professional emails.\n---\n\n# Body here\ntext",
    );
    expect(meta.name).toBe("email-drafting");
    expect(meta.description).toBe("Draft professional emails.");
    expect(body.startsWith("# Body here")).toBe(true);
  });
  it("tolerates CRLF and extra keys", () => {
    const { meta } = parseSkillMd(
      "---\r\nname: x\r\nlicense: MIT\r\ndescription: y\r\n---\r\nbody",
    );
    expect(meta.name).toBe("x");
    expect(meta.license).toBe("MIT");
  });
  it("returns the whole file as body when no frontmatter", () => {
    const { meta, body } = parseSkillMd("just a file");
    expect(meta).toEqual({});
    expect(body).toBe("just a file");
  });
});
