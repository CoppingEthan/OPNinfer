import { describe, expect, it } from "vitest";
import {
  AGENT_AUTO_ALLOWED_TOOLS,
  AGENT_DISALLOWED_TOOLS,
  askAnswersForAgent,
  askQuestionsFromAgent,
  buildAgentSystemAppend,
  classifySubscriptionFailure,
  decideToolUse,
  summariseAgentRun,
} from "./policy";

describe("decideToolUse — workspace containment", () => {
  it("allows writes inside the workspace", () => {
    expect(decideToolUse("Write", { file_path: "/workspace/out/report.md" })).toEqual({ behavior: "allow" });
    expect(decideToolUse("Edit", { file_path: "/workspace/a.py" })).toEqual({ behavior: "allow" });
  });

  it("denies writes anywhere else, with guidance naming the workspace", () => {
    for (const [tool, key] of [["Write", "file_path"], ["Edit", "file_path"], ["MultiEdit", "file_path"], ["NotebookEdit", "notebook_path"]] as const) {
      const d = decideToolUse(tool, { [key]: "/tmp/x" });
      expect(d.behavior).toBe("deny");
      expect((d as { message: string }).message).toMatch(/\/workspace/);
    }
  });

  it("a missing or relative path is denied too (never assume it's inside)", () => {
    expect(decideToolUse("Write", {}).behavior).toBe("deny");
    expect(decideToolUse("Write", { file_path: "relative.txt" }).behavior).toBe("deny");
    // Prefix must be a directory boundary: /workspace-evil is NOT inside.
    expect(decideToolUse("Write", { file_path: "/workspace-evil/x" }).behavior).toBe("deny");
  });

  it("refuses a connected service's tool unless that service is set up here (connectors stay out)", () => {
    const allow = new Set(["figma"]);
    expect(decideToolUse("mcp__figma__get_design_context", { url: "x" }, "/workspace", allow)).toEqual({ behavior: "allow" });
    const d = decideToolUse("mcp__claude_ai_Gmail__search_emails", { q: "x" }, "/workspace", allow);
    expect(d.behavior).toBe("deny");
    expect((d as { message: string }).message).toMatch(/claude_ai_Gmail/);
    // Our own server is always fine; and with no allow-set given nothing changes.
    expect(decideToolUse("mcp__opninfer__present_files", { names: ["a"] }, "/workspace", allow)).toEqual({ behavior: "allow" });
    expect(decideToolUse("mcp__claude_ai_Gmail__search_emails", {})).toEqual({ behavior: "allow" });
  });

  it("routes AskUserQuestion to the user's card", () => {
    expect(decideToolUse("AskUserQuestion", { questions: [] })).toEqual({ behavior: "ask_user" });
  });

  it("everything else is allowed — the container is the boundary", () => {
    expect(decideToolUse("Bash", { command: "rm -rf /tmp/x" })).toEqual({ behavior: "allow" });
    expect(decideToolUse("Read", { file_path: "/etc/hosts" })).toEqual({ behavior: "allow" });
    expect(decideToolUse("SomeFutureTool", {})).toEqual({ behavior: "allow" });
  });
});

describe("tool lists", () => {
  it("nothing that can write is auto-allowed (a bare allowlist entry skips the callback)", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "AskUserQuestion"]) {
      expect(AGENT_AUTO_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it("the core working tools are never disallowed", () => {
    for (const t of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"]) {
      expect(AGENT_DISALLOWED_TOOLS).not.toContain(t);
    }
  });

  it("the two lists don't overlap", () => {
    for (const t of AGENT_AUTO_ALLOWED_TOOLS) expect(AGENT_DISALLOWED_TOOLS).not.toContain(t);
  });
});

describe("AskUserQuestion ↔ the chat's ask card", () => {
  const input = {
    questions: [
      { header: "Format", question: "Which format?", options: [{ label: "PDF" }, { label: "Word" }] },
      { header: "Tone", question: "Which tone?", options: [{ label: "Formal" }, { label: "Casual" }], multiSelect: true },
    ],
  };

  it("translates the agent's questions through the existing validator", () => {
    const qs = askQuestionsFromAgent(input)!;
    expect(qs).toHaveLength(2);
    expect(qs[0].question).toBe("Which format?");
    expect(qs[0].options.map((o) => o.label)).toEqual(["PDF", "Word"]);
  });

  it("rejects malformed questions as null (the caller denies with guidance)", () => {
    expect(askQuestionsFromAgent({})).toBeNull();
    expect(askQuestionsFromAgent({ questions: "nope" })).toBeNull();
    expect(askQuestionsFromAgent({ questions: [{ question: "x?", options: [{ label: "only one" }] }] })).toBeNull();
  });

  it("answers are keyed by question text, multi-select comma-joined, skipped → default instruction", () => {
    const qs = askQuestionsFromAgent(input)!;
    const out = askAnswersForAgent(input, qs, [
      { header: "Format", question: "Which format?", chosen: ["PDF"] },
      { header: "Tone", question: "Which tone?", chosen: ["Formal", "Casual"] },
    ]);
    expect(out.answers).toEqual({ "Which format?": "PDF", "Which tone?": "Formal, Casual" });
    expect(out.questions).toBe(input.questions); // the input rides along untouched
    const skipped = askAnswersForAgent(input, qs, [{ header: "Format", question: "Which format?", chosen: [], skipped: true }]);
    expect((skipped.answers as Record<string, string>)["Which format?"]).toMatch(/default/i);
    expect((skipped.answers as Record<string, string>)["Which tone?"]).toMatch(/default/i);
  });
});

describe("classifySubscriptionFailure", () => {
  it("recognises a lost or expired sign-in", () => {
    expect(classifySubscriptionFailure("Not logged in · Please run /login")).toBe("signed_out");
    expect(classifySubscriptionFailure("authentication_error: invalid x-api-key")).toBe("signed_out");
    expect(classifySubscriptionFailure("OAuth token expired")).toBe("signed_out");
  });

  it("recognises a spent plan, from the text or from the plan's own status", () => {
    expect(classifySubscriptionFailure("You've hit your usage limit. Resets at 5pm.")).toBe("rate_limit");
    expect(classifySubscriptionFailure("429 Too Many Requests")).toBe("rate_limit");
    expect(classifySubscriptionFailure("Rate limit exceeded")).toBe("rate_limit");
    expect(classifySubscriptionFailure("some unrelated error", "rejected")).toBe("rate_limit");
  });

  it("a sign-out outranks a limit when both could apply", () => {
    expect(classifySubscriptionFailure("Not logged in", "rejected")).toBe("signed_out");
  });

  it("an ordinary task failure is neither", () => {
    expect(classifySubscriptionFailure("Reached max turns")).toBeNull();
    expect(classifySubscriptionFailure("Error: file not found", "allowed")).toBeNull();
    expect(classifySubscriptionFailure("")).toBeNull();
  });
});

describe("prompt and summary", () => {
  it("the system append says where it is, how to hand files over, and who it works for", () => {
    const s = buildAgentSystemAppend({ assistantBlock: "You are Acme Assistant. Be terse." });
    expect(s).toContain("/workspace");
    expect(s).toContain("present_files");
    expect(s).toContain("You are Acme Assistant. Be terse.");
  });

  it("tells the agent the browser is already installed (a hung `playwright install` cost a live run its whole budget, twice)", () => {
    const s = buildAgentSystemAppend({ assistantBlock: "x" });
    expect(s).toContain("Never run `playwright install`");
    expect(s).toContain("PLAYWRIGHT_BROWSERS_PATH");
  });

  it("a successful run lists what was presented and never repeats contents", () => {
    const s = summariseAgentRun({ ok: true, text: "Made the report.", presented: ["report.pdf"], numTurns: 6, durationMs: 42_000, denials: 0, subtype: "success" });
    expect(s).toContain("Made the report.");
    expect(s).toContain("report.pdf");
    expect(s).toMatch(/6 steps in 42s/);
    expect(s).not.toMatch(/^Error/);
  });

  it("a successful run that presented nothing says so (the common miss)", () => {
    const s = summariseAgentRun({ ok: true, text: "Done.", presented: [], numTurns: 2, durationMs: 1000, denials: 0, subtype: "success" });
    expect(s).toMatch(/No files were presented/);
  });

  it("a failed run is an Error the conversation model can explain, with guidance marked for it", () => {
    const s = summariseAgentRun({ ok: false, text: "Not logged in", presented: [], numTurns: 0, durationMs: 100, denials: 0, subtype: "error_during_execution" });
    expect(s).toMatch(/^Error:/);
    expect(s).toContain("error_during_execution");
    expect(s).toContain("[To the assistant:");
  });

  it("never relays 'the user also said' inside the tool result (the model reads it as injection)", () => {
    const s = summariseAgentRun({ ok: true, text: "Done.", presented: ["a.txt"], numTurns: 2, durationMs: 0, denials: 0, subtype: "success" });
    expect(s).not.toMatch(/user ALSO said/i);
  });

  it("counts blocked actions in the trailer", () => {
    const s = summariseAgentRun({ ok: true, text: "x", presented: ["a"], numTurns: 3, durationMs: 0, denials: 2, subtype: "success" });
    expect(s).toMatch(/2 blocked action/);
  });
});

describe("write containment is a path check, not a prefix (audit 2026-09-05)", () => {
  it("refuses dot-dot escapes that start with the workspace prefix", () => {
    for (const p of ["/workspace/../home/sandbox/.claude-shared/.claude.json", "/workspace/a/../../tmp/x", "/workspace/.."]) {
      const d = decideToolUse("Write", { file_path: p }, "/workspace");
      expect(d.behavior, p).toBe("deny");
    }
  });
  it("still allows ordinary and dotted-but-inside paths", () => {
    for (const p of ["/workspace/out.txt", "/workspace/a/./b.txt", "/workspace/a/../b.txt"]) {
      const d = decideToolUse("Write", { file_path: p }, "/workspace");
      expect(d.behavior, p).toBe("allow");
    }
  });
});
