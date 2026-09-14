import { describe, expect, it } from "vitest";
import { buildProgressiveToolset, ENABLE_TOOLS_DEF } from "./disclosure";
import type { Toolset } from "./registry";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolGroup } from "./types";

function def(name: string): ToolDef {
  return { name, description: name, parameters: { type: "object", properties: {} } };
}

function fakeToolset(entries: { group: ToolGroup; name: string }[]): Toolset {
  const defs = entries.map((e) => ({ group: e.group, def: def(e.name) }));
  return {
    tools: defs.map((e) => e.def),
    groups: [...new Set(defs.map((e) => e.group))],
    entries: defs,
    disabledGroups: [],
    executeTool: async (name) => ({ text: `ran ${name}` }),
  };
}

const FULL = fakeToolset([
  { group: "datetime", name: "date_time_now" },
  { group: "memory", name: "memory_update" },
  { group: "files", name: "read_file" },
  { group: "image", name: "view_image" },
  { group: "image", name: "image_generation" },
  { group: "web", name: "web_search" },
  { group: "web", name: "download_file" },
  { group: "capability", name: "invoice_record" },
  { group: "capability", name: "invoice_search" },
]);

describe("buildProgressiveToolset", () => {
  it("keeps cheap groups live and defers the heavy ones behind enable_tools", () => {
    const p = buildProgressiveToolset(FULL);
    const names = p.defs.map((d) => d.name);
    expect(names).toContain("date_time_now");
    expect(names).toContain("memory_update");
    expect(names).toContain("read_file");
    expect(names).toContain("enable_tools");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("invoice_record");
    expect(names).not.toContain("image_generation");
    expect(names).not.toContain("invoice_search");
  });

  it("view_image stays live even though its group is deferred (files workflow)", () => {
    const p = buildProgressiveToolset(FULL);
    expect(p.defs.map((d) => d.name)).toContain("view_image");
  });

  it("directory lists every deferred group with its tool names", () => {
    const p = buildProgressiveToolset(FULL);
    expect(p.directory).toBeTruthy();
    for (const s of ["web_search", "download_file", "invoice_record", "image_generation", "invoice_search", "enable_tools"]) {
      expect(p.directory).toContain(s);
    }
    expect(p.directory).not.toContain("view_image");
  });

  it("enable_tools grows the SAME defs array in place", async () => {
    const p = buildProgressiveToolset(FULL);
    const ref = p.defs;
    const out = await p.executeTool("enable_tools", JSON.stringify({ groups: ["web"] }));
    expect(out.text).toContain("web_search");
    expect(ref.map((d) => d.name)).toContain("web_search");
    expect(ref.map((d) => d.name)).toContain("download_file");
    expect(ref.map((d) => d.name)).not.toContain("invoice_record");
  });

  it("enabling twice is idempotent; multiple groups work", async () => {
    const p = buildProgressiveToolset(FULL);
    await p.executeTool("enable_tools", JSON.stringify({ groups: ["web"] }));
    const again = await p.executeTool("enable_tools", JSON.stringify({ groups: ["web", "capability"] }));
    expect(again.text).toContain("invoice_record");
    expect(p.defs.filter((d) => d.name === "web_search")).toHaveLength(1);
  });

  it("invalid or missing groups return an error naming the valid ones", async () => {
    const p = buildProgressiveToolset(FULL);
    const out = await p.executeTool("enable_tools", JSON.stringify({ groups: ["poetry"] }));
    expect(out.text).toMatch(/^Error:/);
    expect(out.text).toContain("web");
    const bad = await p.executeTool("enable_tools", "{not json");
    expect(bad.text).toMatch(/^Error:/);
  });

  it("delegates every other tool to the underlying toolset", async () => {
    const p = buildProgressiveToolset(FULL);
    expect((await p.executeTool("date_time_now", "{}")).text).toBe("ran date_time_now");
  });

  it("no deferred groups → passthrough with no directory and no enable_tools", () => {
    const p = buildProgressiveToolset(
      fakeToolset([
        { group: "datetime", name: "date_time_now" },
        { group: "files", name: "read_file" },
      ]),
    );
    expect(p.directory).toBeNull();
    expect(p.defs.map((d) => d.name)).not.toContain(ENABLE_TOOLS_DEF.name);
  });
});
