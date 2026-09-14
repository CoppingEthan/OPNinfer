import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentBridge, agentToolLabel, displayPath, type AgentEvent } from "./bridge";

/**
 * Replays a RECORDED real Agent SDK session (bridge-fixture.ndjson — the
 * container spike's fib.py run, captured verbatim) through the bridge and
 * checks the mapping against an oracle rebuilt from the raw fixture, so the
 * tests describe what the SDK actually sends rather than what we hoped.
 */

const FIXTURE = path.join(process.cwd(), "src/lib/agent/bridge-fixture.ndjson");
const messages: Record<string, any>[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

/** Oracle: the complete arguments of every tool_use, rebuilt from the raw
 *  partial_json deltas — independently of the bridge's own tap. */
function oracleArgs(): Map<string, { name: string; args: Record<string, unknown> }> {
  const byIndex = new Map<number, { id: string; name: string; json: string }>();
  const done = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.type !== "stream_event") continue;
    const ev = m.event;
    if (ev.type === "message_start") byIndex.clear();
    else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      byIndex.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
      const b = byIndex.get(ev.index);
      if (b) b.json += ev.delta.partial_json ?? "";
    } else if (ev.type === "content_block_stop") {
      const b = byIndex.get(ev.index);
      if (b) done.set(b.id, { name: b.name, args: JSON.parse(b.json || "{}") });
    }
  }
  return done;
}

function replay(now?: () => number): AgentEvent[] {
  const bridge = new AgentBridge(now);
  const out: AgentEvent[] = [];
  for (const m of messages) out.push(...bridge.feed(m));
  return out;
}

const runEvents = (events: AgentEvent[], id: string) =>
  events.filter((e) => "id" in e && (e as { id: string }).id === id);

describe("AgentBridge — replaying a real session", () => {
  const events = replay();
  const oracle = oracleArgs();
  const toolUses = [...oracle.entries()];
  const writes = toolUses.filter(([, v]) => v.name === "Write");
  const bashes = toolUses.filter(([, v]) => v.name === "Bash");

  it("opens with the session identity, before anything else", () => {
    expect(events[0]).toMatchObject({ type: "session", model: "claude-sonnet-5" });
    expect((events[0] as { sessionId: string }).sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((events[0] as { tools: string[] }).tools).toContain("Write");
  });

  it("maps Write onto the existing write_file run block, opened before any args", () => {
    for (const [id] of writes) {
      const ev = runEvents(events, id);
      expect(ev[0]).toEqual({ type: "run_start", id, tool: "write_file" });
    }
  });

  it("streams the file body byte-for-byte as run_code deltas, and names the file", () => {
    for (const [id, { args }] of writes) {
      const ev = runEvents(events, id);
      const code = ev
        .filter((e) => e.type === "run_code")
        .map((e) => (e as { delta: string }).delta)
        .join("");
      expect(code).toBe(args.content);
      const named = ev.find((e) => e.type === "run_code" && (e as { file?: string }).file);
      expect((named as { file: string }).file).toBe(displayPath(String(args.file_path)));
    }
  });

  it("the denied Write (outside the workspace) lands as a run_done error, path shown in full", () => {
    const denied = writes.find(([, v]) => !String(v.args.file_path).startsWith("/workspace/"))!;
    expect(denied).toBeDefined();
    const ev = runEvents(events, denied[0]);
    const done = ev.find((e) => e.type === "run_done") as { error?: string };
    expect(done.error).toMatch(/Write inside \/workspace/);
    const named = ev.find((e) => e.type === "run_code" && (e as { file?: string }).file) as { file: string };
    expect(named.file).toBe("/tmp/fib.py"); // NOT stripped — a write to /tmp is worth seeing
  });

  it("the successful Write reports a created-file diff with the right line count", () => {
    const ok = writes.find(([, v]) => String(v.args.file_path).startsWith("/workspace/"))!;
    const done = runEvents(events, ok[0]).find((e) => e.type === "run_done") as {
      diff?: { added: number; removed: number; created?: boolean };
      error?: string;
    };
    expect(done.error).toBeUndefined();
    expect(done.diff).toEqual({
      added: String(ok[1].args.content).split("\n").length,
      removed: 0,
      created: true,
    });
  });

  it("maps Bash onto execute_command: start → typed command → exec → console → done", () => {
    expect(bashes.length).toBeGreaterThan(0);
    for (const [id, { args }] of bashes) {
      const ev = runEvents(events, id);
      const types = ev.map((e) => e.type);
      expect(types[0]).toBe("run_start");
      expect((ev[0] as { tool: string }).tool).toBe("execute_command");
      const typed = ev
        .filter((e) => e.type === "run_code")
        .map((e) => (e as { delta: string }).delta)
        .join("");
      expect(typed).toBe(args.command);
      expect(types.indexOf("run_exec")).toBeGreaterThan(types.lastIndexOf("run_code"));
      expect((ev.find((e) => e.type === "run_exec") as { command: string }).command).toBe(args.command);
      expect(types.indexOf("run_out")).toBeGreaterThan(types.indexOf("run_exec"));
      const done = ev[ev.length - 1] as { type: string; exec?: { exitCode: number; lines: number } };
      expect(done.type).toBe("run_done");
      expect(done.exec?.exitCode).toBe(0);
      expect(done.exec?.lines).toBeGreaterThan(0);
    }
  });

  it("the Fibonacci output actually reaches the console tail", () => {
    const outs = events.filter((e) => e.type === "run_out").map((e) => (e as { delta: string }).delta);
    expect(outs.join("\n")).toMatch(/0\s*\n1\s*\n1\s*\n2\s*\n3\s*\n5\s*\n8/);
  });

  it("plumbing tools (ToolSearch, our own MCP tools) produce no status line", () => {
    const labels = events.filter((e) => e.type === "status").map((e) => (e as { label: string }).label);
    // Precisely the humanised-tool-name forms, not any label containing the
    // word — the agent's own narration legitimately says "present".
    expect(labels.some((l) => /^Tool ?search$/i.test(l))).toBe(false);
    expect(labels.some((l) => /^Mcp /i.test(l))).toBe(false);
  });

  it("the agent's narration arrives as status lines, not as text", () => {
    const labels = events.filter((e) => e.type === "status").map((e) => (e as { label: string }).label);
    expect(labels.length).toBeGreaterThan(0);
    expect(events.some((e) => (e as { type: string }).type === "text")).toBe(false);
  });

  it("surfaces the plan-limit reading", () => {
    expect(events.some((e) => e.type === "rate_limit")).toBe(true);
  });

  it("the result carries ok, turns, cost and usage summed from modelUsage", () => {
    const raw = messages.find((m) => m.type === "result")!;
    const result = events.find((e) => e.type === "result") as Extract<AgentEvent, { type: "result" }>;
    expect(result.ok).toBe(true);
    expect(result.numTurns).toBe(raw.num_turns);
    expect(result.costUsd).toBeCloseTo(raw.total_cost_usd, 6);
    expect(result.text).toMatch(/fib\.py/);
    const mu = raw.modelUsage["claude-sonnet-5"];
    expect(result.usage).toEqual({
      inputTokens: mu.inputTokens,
      outputTokens: mu.outputTokens,
      cacheReadTokens: mu.cacheReadInputTokens,
      cacheWriteTokens: mu.cacheCreationInputTokens,
    });
    expect(Object.keys(result.byModel)).toEqual(["claude-sonnet-5"]);
  });

  it("every run that opened was closed — nothing left dangling", () => {
    const bridge = new AgentBridge();
    for (const m of messages) bridge.feed(m);
    expect(bridge.danglingRuns()).toEqual([]);
    const starts = events.filter((e) => e.type === "run_start").length;
    const dones = events.filter((e) => e.type === "run_done").length;
    expect(dones).toBe(starts);
  });

  it("measures each run's duration with the injected clock", () => {
    let t = 1_000;
    const ev = replay(() => (t += 500));
    const done = ev.find((e) => e.type === "run_done" && (e as { exec?: unknown }).exec) as {
      exec: { durationMs: number };
    };
    expect(done.exec.durationMs).toBeGreaterThan(0);
  });
});

describe("AgentBridge — shapes the fixture doesn't cover", () => {
  const wrap = (ev: Record<string, unknown>) => ({ type: "stream_event", event: ev, parent_tool_use_id: null });

  it("Edit reports a real +N −M diff from old_string/new_string", () => {
    const b = new AgentBridge();
    const id = "toolu_edit";
    b.feed({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    b.feed(wrap({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Edit", input: {} } }));
    const args = { file_path: "/workspace/a.py", old_string: "x = 1\ny = 2\n", new_string: "x = 1\ny = 3\nz = 4\n" };
    b.feed(wrap({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } }));
    b.feed(wrap({ type: "content_block_stop", index: 0 }));
    const out = b.feed({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });
    expect(out).toEqual([{ type: "run_done", id, diff: { added: 2, removed: 1 } }]);
  });

  it("a run whose arguments never streamed is still named at block stop", () => {
    const b = new AgentBridge();
    b.feed(wrap({ type: "message_start" }));
    const start = b.feed(wrap({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Write", input: {} } }));
    expect(start).toEqual([{ type: "run_start", id: "t1", tool: "write_file" }]);
    // No deltas at all, then stop with… nothing to parse. Degrades quietly.
    expect(b.feed(wrap({ type: "content_block_stop", index: 0 }))).toEqual([]);
  });

  it("non-run tools become status lines once their args are complete", () => {
    const b = new AgentBridge();
    b.feed(wrap({ type: "message_start" }));
    b.feed(wrap({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "r1", name: "Read", input: {} } }));
    b.feed(wrap({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/workspace/notes.md"}' } }));
    expect(b.feed(wrap({ type: "content_block_stop", index: 0 }))).toEqual([{ type: "status", label: "Reading notes.md" }]);
  });

  it("sub-agent traffic is ignored (collapsed to the Task tool's own line)", () => {
    const b = new AgentBridge();
    const sub = { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "inner", name: "Bash" } } };
    expect(b.feed(sub)).toEqual([]);
  });

  it("api_retry and compact_boundary become their own events", () => {
    const b = new AgentBridge();
    expect(b.feed({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error: "rate_limit" })).toEqual([
      { type: "retry", attempt: 2, maxRetries: 10, delayMs: 4000, reason: "rate_limit" },
    ]);
    expect(b.feed({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150_000 } })).toEqual([
      { type: "compact", preTokens: 150_000 },
    ]);
  });

  it("an error result is ok:false with the error text", () => {
    const b = new AgentBridge();
    const [r] = b.feed({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 50, duration_ms: 1, total_cost_usd: 0.5, errors: ["Reached max turns"], modelUsage: {} }) as Extract<AgentEvent, { type: "result" }>[];
    expect(r.ok).toBe(false);
    expect(r.subtype).toBe("error_max_turns");
    expect(r.text).toBe("Reached max turns");
  });

  it("never throws: garbage in, nothing out", () => {
    const b = new AgentBridge();
    for (const junk of [null, 42, "str", {}, { type: "stream_event" }, { type: "user", message: { content: "plain" } }, { type: "system", subtype: "init" }]) {
      expect(() => b.feed(junk)).not.toThrow();
    }
    expect(b.feed({ type: "result", modelUsage: "not-an-object" })).toHaveLength(1);
  });
});

describe("labels and paths", () => {
  it("displayPath strips the workspace prefix and nothing else", () => {
    expect(displayPath("/workspace/out/report.pdf")).toBe("out/report.pdf");
    expect(displayPath("/tmp/x")).toBe("/tmp/x");
    expect(displayPath("relative.txt")).toBe("relative.txt");
  });

  it("agentToolLabel covers the common tools and hides plumbing", () => {
    expect(agentToolLabel("WebSearch", { query: "uk bank holidays 2027" })).toBe("Searching the web: “uk bank holidays 2027”");
    expect(agentToolLabel("WebFetch", { url: "https://example.com/a/b" })).toBe("Reading example.com");
    expect(agentToolLabel("Grep", { pattern: "TODO" })).toBe("Searching for “TODO”");
    expect(agentToolLabel("Task", { description: "research pricing" })).toBe("Working on a sub-task: research pricing");
    expect(agentToolLabel("ToolSearch", {})).toBeNull();
    expect(agentToolLabel("mcp__opninfer__present_files", {})).toBeNull();
    expect(agentToolLabel("mcp__figma__get_design_context", {})).toBe("Using Figma: get design context");
    expect(agentToolLabel("SomeNewTool", {})).toBe("SomeNewTool");
  });
});
