import { describe, expect, it } from "vitest";
import { ToolArgTap, ToolRunTracker, lineDiffStat, type TapEvent } from "./tool-run";

/** Feed a full args-JSON string in fixed-size chunks; fold the events. */
function tap(tool: string, json: string, chunkSize = json.length) {
  const t = new ToolArgTap(tool);
  const events: TapEvent[] = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    events.push(...t.feed(json.slice(i, i + chunkSize)));
  }
  let code = "";
  let file: string | undefined;
  for (const e of events) {
    if (e.kind === "code") code += e.delta;
    else file = e.name;
  }
  return { code, file };
}

describe("ToolArgTap", () => {
  const WRITE = JSON.stringify({ name: "fib.py", content: 'def fib(n):\n\treturn "x"' });

  it("extracts content + name from write_file args in one chunk", () => {
    const r = tap("write_file", WRITE);
    expect(r.file).toBe("fib.py");
    expect(r.code).toBe('def fib(n):\n\treturn "x"');
  });

  it("survives single-character streaming (escapes split at every boundary)", () => {
    const r = tap("write_file", WRITE, 1);
    expect(r.file).toBe("fib.py");
    expect(r.code).toBe('def fib(n):\n\treturn "x"');
  });

  it("handles content arriving BEFORE name (key order not guaranteed)", () => {
    const r = tap("write_file", '{"content":"a\\nb","name":"out.txt"}', 3);
    expect(r.code).toBe("a\nb");
    expect(r.file).toBe("out.txt");
  });

  it("decodes \\uXXXX escapes, including split across chunks", () => {
    const json = JSON.stringify({ name: "e.txt", content: "£ → 😀" });
    expect(tap("write_file", json, 2).code).toBe("£ → 😀");
  });

  it("taps `replace` for edit_file and ignores `search`", () => {
    const r = tap("edit_file", JSON.stringify({ name: "a.py", search: "old()", replace: "new()" }));
    expect(r.code).toBe("new()");
    expect(r.file).toBe("a.py");
  });

  it("taps `command` for execute_command (no file key)", () => {
    const r = tap("execute_command", JSON.stringify({ command: "ls -la | head", timeout_seconds: 60 }), 4);
    expect(r.code).toBe("ls -la | head");
    expect(r.file).toBeUndefined();
  });

  it("skips nested object/array values without false-triggering on inner keys", () => {
    const json = '{"meta":{"content":"DECOY","list":["content"]},"name":"n.txt","content":"real"}';
    const r = tap("write_file", json, 5);
    expect(r.code).toBe("real");
    expect(r.file).toBe("n.txt");
  });

  it("ignores numeric/boolean values between string members", () => {
    const r = tap("run_script", '{"timeout_seconds":120,"name":"s.sh","content":"echo hi"}', 7);
    expect(r.code).toBe("echo hi");
    expect(r.file).toBe("s.sh");
  });
});

describe("ToolRunTracker", () => {
  it("emits start once, then code deltas and the file when it closes", () => {
    const tr = new ToolRunTracker();
    const e1 = tr.feedDelta("c1", "write_file", '{"name":"a');
    expect(e1[0]).toEqual({ type: "run_start", id: "c1", tool: "write_file" });
    const e2 = tr.feedDelta("c1", "write_file", '.py","content":"x=1"}');
    expect(e2.some((e) => e.type === "run_code" && e.file === "a.py")).toBe(true);
    expect(e2.some((e) => e.type === "run_code" && e.delta === "x=1")).toBe(true);
    expect(e2.some((e) => e.type === "run_start")).toBe(false);
  });

  it("ignores non-run tools entirely", () => {
    const tr = new ToolRunTracker();
    expect(tr.feedDelta("c2", "web_search", '{"query":"x"}')).toEqual([]);
    expect(tr.isRun("web_search")).toBe(false);
  });

  it("ensureStarted synthesizes start + full code when no deltas streamed", () => {
    const tr = new ToolRunTracker();
    const events = tr.ensureStarted("c3", "run_script", JSON.stringify({ name: "go.py", content: "print(1)" }));
    expect(events[0]).toEqual({ type: "run_start", id: "c3", tool: "run_script" });
    expect(events.some((e) => e.type === "run_code" && e.file === "go.py")).toBe(true);
    expect(events.some((e) => e.type === "run_code" && e.delta === "print(1)")).toBe(true);
    // Already started → no double start.
    expect(tr.ensureStarted("c3", "run_script", "{}")).toEqual([]);
  });

  it("ensureStarted is a no-op after deltas already started the run", () => {
    const tr = new ToolRunTracker();
    tr.feedDelta("c4", "write_file", '{"name":"a.txt"');
    expect(tr.ensureStarted("c4", "write_file", '{"name":"a.txt","content":"x"}')).toEqual([]);
  });
});

describe("lineDiffStat", () => {
  it("new file → all lines added", () => {
    expect(lineDiffStat("", "a\nb\nc")).toEqual({ added: 3, removed: 0 });
  });
  it("identical → zero", () => {
    expect(lineDiffStat("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
  });
  it("pure additions", () => {
    expect(lineDiffStat("a\nb", "a\nb\nc\nd")).toEqual({ added: 2, removed: 0 });
  });
  it("changed line counts as +1 −1", () => {
    expect(lineDiffStat("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });
  it("deletions", () => {
    expect(lineDiffStat("a\nb\nc", "b")).toEqual({ added: 0, removed: 2 });
  });
  it("duplicate lines respect multiplicity", () => {
    expect(lineDiffStat("x\nx", "x")).toEqual({ added: 0, removed: 1 });
  });
});
