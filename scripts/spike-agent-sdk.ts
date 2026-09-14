/**
 * Stage 1 spike — prove the Agent SDK gives us what the Sandbox-tier design
 * assumes, BEFORE building anything around it. Not a regression harness; a
 * one-off proof with a written verdict. Run:
 *
 *   pnpm exec tsx scripts/spike-agent-sdk.ts
 *
 * What it must demonstrate (each becomes a ✓/✗ verdict line):
 *   1. `includePartialMessages` delivers token-level deltas — BOTH text_delta
 *      (prose) and input_json_delta (watching the model type a tool call's
 *      arguments), which is what feeds the existing live code block.
 *   2. `canUseTool` fires for a tool that is neither allowlisted nor covered
 *      by the permission mode (Bash here) — the seam the admin capability
 *      toggles and the ask_user bridge will hang off.
 *   3. An in-process MCP tool (registered host-side via createSdkMcpServer)
 *      executes — the mechanism present_files will use.
 *   4. accountInfo() names the credential the run billed — must be the
 *      machine's subscription login, never an API key (none is in the env,
 *      and the spike strips every ANTHROPIC/CLAUDE-prefixed var regardless).
 *   5. The result message carries usable usage/modelUsage numbers.
 *
 * The full message stream lands in logs/agent-spike.ndjson for inspection;
 * stderr in logs/agent-spike.stderr.log. The workspace is
 * logs/agent-spike-workspace/ (all three git-ignored).
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const ROOT = process.cwd();
const LOG = join(ROOT, "logs", "agent-spike.ndjson");
const ERRLOG = join(ROOT, "logs", "agent-spike.stderr.log");
const WORKSPACE = join(ROOT, "logs", "agent-spike-workspace");

rmSync(WORKSPACE, { recursive: true, force: true });
mkdirSync(WORKSPACE, { recursive: true });
writeFileSync(LOG, "");
writeFileSync(ERRLOG, "");

// This script itself runs INSIDE a Claude Code session, whose environment is
// full of nested-session plumbing (CLAUDECODE, CLAUDE_CODE_SESSION_ID,
// CLAUDE_CODE_MESSAGING_SOCKET, …). Strip every ANTHROPIC*/CLAUDE*/AI_AGENT
// var so the spawned CLI starts clean and — the part that matters — no API
// key can ever reach it: the run must bill the machine's subscription login.
// NB Options.env REPLACES the subprocess environment (it does not merge), so
// everything else (PATH, HOME, USERPROFILE, …) is passed through explicitly.
const env: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(ANTHROPIC|CLAUDE|AI_AGENT)/i.test(k)) continue;
  // PWD/INIT_CWD/OLDPWD point at the REPO, not the workspace — leaking them
  // gave the model two different ideas of where it was, and it wrote its file
  // to the repo root (found on the first spike run; the file landed outside
  // cwd and a bare allowedTools "Write" entry auto-approved it anyway).
  if (/^(PWD|OLDPWD|INIT_CWD)$/i.test(k)) continue;
  env[k] = v;
}

// --- verdict counters --------------------------------------------------------
let textDeltas = 0;
let inputJsonDeltas = 0;
let toolUseStarts: string[] = [];
const canUseToolCalls: string[] = [];
const deniedWrites: string[] = [];
let mcpToolRan = false;
let mcpToolArg = "";
let sessionId = "";
let account: unknown = null;
let result: Record<string, unknown> | null = null;
let sawStderr = false;

// --- the in-process MCP tool (the present_files mechanism) -------------------
const opninferServer = createSdkMcpServer({
  name: "opninfer",
  version: "0.0.1",
  tools: [
    tool(
      "present_files",
      "Hand a finished deliverable file over to the user. Call this with the filename once the work is done.",
      { filename: z.string().describe("Name of the finished file") },
      async (args) => {
        mcpToolRan = true;
        mcpToolArg = args.filename;
        return {
          content: [{ type: "text", text: `Presented ${args.filename} to the user.` }],
        };
      },
    ),
  ],
});

// --- streaming input mode (what production will use) -------------------------
async function* prompts(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Write a Python script fib.py that prints the first 10 Fibonacci numbers, " +
        "run it with `python fib.py` to check it works, then call the " +
        "present_files tool with filename fib.py.",
    },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

const t0 = Date.now();
const q = query({
  prompt: prompts(),
  options: {
    cwd: WORKSPACE,
    env,
    model: "claude-sonnet-5",
    // acceptEdits auto-approves Write/Edit INSIDE cwd only. Nothing else is
    // allowlisted — the first run proved a bare "Write" in allowedTools
    // auto-approves the tool for ANY path, before canUseTool is consulted
    // (the SDK even warns about it). So: out-of-cwd writes, Bash and the MCP
    // tool all fall through to canUseTool, which enforces the workspace
    // boundary the way production will.
    permissionMode: "acceptEdits",
    allowedTools: ["Read"],
    canUseTool: async (toolName, input) => {
      canUseToolCalls.push(toolName);
      // The workspace guard: a Write/Edit reaching this callback is one
      // acceptEdits did NOT auto-approve, i.e. outside cwd. Deny with
      // guidance instead of letting the agent write over the host.
      if (toolName === "Write" || toolName === "Edit") {
        const p = String((input as Record<string, unknown>).file_path ?? "");
        console.log(`  [canUseTool] ${toolName} outside cwd (${p}) → DENY`);
        deniedWrites.push(p);
        return {
          behavior: "deny",
          message: `Write only inside the workspace directory (${WORKSPACE}). Use a relative path.`,
        };
      }
      console.log(`  [canUseTool] ${toolName} → allow`);
      return { behavior: "allow", updatedInput: input };
    },
    mcpServers: { opninfer: opninferServer },
    // Production hygiene, tested here for parity: no filesystem settings, no
    // CLAUDE.md, no .mcp.json, no plugins — a file in the workspace must not
    // be able to configure the agent.
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true,
    maxTurns: 10,
    stderr: (d: string) => {
      sawStderr = true;
      appendFileSync(ERRLOG, d.endsWith("\n") ? d : d + "\n");
    },
  },
});

// Watchdog: a hung spike must not sit forever (and firing it also exercises
// interrupt(), which Stage 2 needs anyway).
const watchdog = setTimeout(() => {
  console.log("! watchdog: 240s elapsed — interrupting");
  q.interrupt().catch(() => {});
}, 240_000);

try {
  for await (const msg of q as AsyncIterable<Record<string, any>>) {
    appendFileSync(LOG, JSON.stringify(msg) + "\n");

    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
      console.log(
        `init: session=${msg.session_id} model=${msg.model} cc=${msg.claude_code_version ?? "?"} tools=${(msg.tools ?? []).length} mcp=${JSON.stringify(msg.mcp_servers ?? [])}`,
      );
      // Who is this run billed to? Must be the subscription login.
      q.accountInfo?.()
        .then((a: unknown) => {
          account = a;
          console.log(`  [accountInfo] ${JSON.stringify(a)}`);
        })
        .catch((e: Error) => console.log(`  [accountInfo] failed: ${e.message}`));
    } else if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        toolUseStarts.push(ev.content_block.name);
        console.log(`  [tool_use opens] ${ev.content_block.name} (name known before args — card can open now)`);
      } else if (ev?.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") textDeltas++;
        else if (ev.delta?.type === "input_json_delta") inputJsonDeltas++;
      }
    } else if (msg.type === "assistant") {
      const kinds = (msg.message?.content ?? []).map((b: { type: string }) => b.type).join(",");
      console.log(`  [assistant] blocks: ${kinds}`);
    } else if (msg.type === "user") {
      const kinds = (msg.message?.content ?? []).map?.((b: { type: string }) => b.type).join(",") ?? "text";
      console.log(`  [tool result in] ${kinds}`);
    } else if (msg.type === "result") {
      result = msg;
    }
  }
} finally {
  clearTimeout(watchdog);
}

// --- verdicts ----------------------------------------------------------------
const fib = join(WORKSPACE, "fib.py");
const fibExists = existsSync(fib);
const checks: [string, boolean, string][] = [
  // >0, not some larger number: a terse run may narrate in only a handful of
  // deltas — the check is that the MECHANISM delivers, not that the model chats.
  ["text_delta streaming", textDeltas > 0, `${textDeltas} deltas`],
  [
    "input_json_delta streaming (live tool-arg typing)",
    inputJsonDeltas > 3,
    `${inputJsonDeltas} deltas across tool_use blocks: ${[...new Set(toolUseStarts)].join(", ")}`,
  ],
  [
    "canUseTool fired for a non-allowlisted tool",
    canUseToolCalls.length > 0,
    `calls: ${canUseToolCalls.join(", ") || "(none)"}`,
  ],
  ["in-process MCP tool executed host-side", mcpToolRan, mcpToolRan ? `present_files("${mcpToolArg}")` : "never ran"],
  ["the agent actually did the work", fibExists, fibExists ? `fib.py exists (${readFileSync(fib, "utf8").length} bytes)` : "fib.py missing"],
  ["session id captured", !!sessionId, sessionId],
  [
    "result carries usage",
    !!(result && (result as any).usage),
    result
      ? `subtype=${(result as any).subtype} turns=${(result as any).num_turns} cost=$${(result as any).total_cost_usd} models=${Object.keys((result as any).modelUsage ?? {}).join(",")}`
      : "no result message",
  ],
];

console.log(`\n=== SPIKE VERDICT (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
  if (!ok) failed++;
}
console.log(`account: ${JSON.stringify(account)}`);
if (sawStderr) console.log(`(stderr was written — see logs/agent-spike.stderr.log)`);
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
