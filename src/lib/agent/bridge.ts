import { ToolArgTap, lineDiffStat, type RunPipelineEvent } from "@/lib/tool-run";
import type { AskAnswer } from "@/lib/ask";
import { mcpToolLabel } from "./mcp";

/**
 * The agent event bridge — Agent SDK messages in, OPNinfer stream events out.
 *
 * Pure (no server imports, no I/O), following viz-stream.ts / tool-run.ts:
 * this is the file with the tests, replayed against a RECORDED real session
 * (bridge-fixture.ndjson) so the mapping is checked against what the SDK
 * actually sends rather than what its types suggest.
 *
 * The central trick is that it emits the EXISTING `RunPipelineEvent` shapes,
 * with Claude Code's tools mapped onto the names the run-block UI already
 * knows (Bash → execute_command, Write → write_file, Edit → edit_file). The
 * live 5-line code tail, the console tail, the +N −M / exit-code chips, the
 * click-to-expand and the reload persistence all come for free — no UI work.
 *
 * Owner decisions baked in (2026-09-01): the agent's own narration goes to
 * the activity panel as status lines, never into the reply prose (the reply
 * stays the conversation model's voice); sub-agent detail is collapsed to a
 * single status line rather than a dead region.
 */

// --- events ------------------------------------------------------------------

/** Per-model token totals in OPNinfer's TokenUsage convention: inputTokens is
 *  the UNCACHED input; cache tiers are separate. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AgentEvent =
  /** The run's identity — persist the session id immediately (resume needs it). */
  | { type: "session"; sessionId: string; model: string; tools: string[] }
  /** The rich run-block lifecycle, keyed by the agent's tool_use id. */
  | RunPipelineEvent
  /** A plain activity line: a non-run tool ("Reading config.py") or the
   *  agent's narration between steps. */
  | { type: "status"; label: string }
  /** The provider is being retried — on a subscription, usually the plan's
   *  limit. Worth a visible line: silence here reads as a hang. */
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; reason?: string }
  /** Context was compacted (long runs). */
  | { type: "compact"; preTokens: number }
  /** Plan-limit reading — the caller records it (limits-store). */
  | { type: "rate_limit"; info: unknown }
  /** The run finished. `usage` is a per-model breakdown summed; the SDK's
   *  totals are CUMULATIVE across turns of one query, so read the last. */
  | {
      type: "result";
      ok: boolean;
      subtype: string;
      text: string;
      numTurns: number;
      durationMs: number;
      costUsd: number;
      usage: AgentUsage;
      byModel: Record<string, AgentUsage>;
      permissionDenials: number;
    };

/**
 * What the Sandbox TOOL pushes up to the pipeline mid-run: every bridge event,
 * plus three the tool itself originates — a file hand-over (present_files
 * fired inside the agent), a usage report to record, and the settlement of a
 * question card the agent raised.
 */
export type AgentStreamEvent =
  | AgentEvent
  | { type: "presented"; names: string[] }
  | { type: "usage"; model: string; usage: AgentUsage; sessionId?: string }
  /** A message the user typed mid-run was fed to the agent (and persisted). */
  | { type: "interjected"; messageId: string; content: string }
  | {
      type: "ask_done";
      id: string;
      status: "answered" | "dismissed" | "expired";
      answers?: AskAnswer[];
    };

// --- tool mapping ------------------------------------------------------------

/** Claude Code tools that render as a run block, mapped onto the OPNinfer
 *  tool names the UI keys its language/labels/chips on, plus which of the
 *  agent's argument names carry the code and the file. */
const RUN_MAP: Record<string, { tool: string; codeKey: string; fileKey?: string }> = {
  Bash: { tool: "execute_command", codeKey: "command" },
  Write: { tool: "write_file", codeKey: "content", fileKey: "file_path" },
  Edit: { tool: "edit_file", codeKey: "new_string", fileKey: "file_path" },
  NotebookEdit: { tool: "edit_file", codeKey: "new_source", fileKey: "notebook_path" },
};

/** Container path of the chat's pool — stripped from displayed file names so
 *  the user sees `fib.py`, the way the old tools named files. Anything
 *  OUTSIDE it is shown in full on purpose: a write to /tmp is worth seeing. */
export const AGENT_WORKSPACE = "/workspace";

export function displayPath(p: string): string {
  return p.startsWith(AGENT_WORKSPACE + "/") ? p.slice(AGENT_WORKSPACE.length + 1) : p;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** File bodies must NOT be trimmed — a trailing newline is a line, and
 *  trimming it made the diff chip under-count by one on every write. */
function raw(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return clip(url, 40);
  }
}

/** Status label for a NON-run tool, once its arguments are complete. Null =
 *  plumbing the user needn't see (ToolSearch, our own MCP tools, which
 *  produce their own UI). */
export function agentToolLabel(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "Read":
      return str(args.file_path) ? `Reading ${displayPath(str(args.file_path))}` : "Reading a file";
    case "Glob":
      return str(args.pattern) ? `Finding files: ${clip(str(args.pattern), 50)}` : "Finding files";
    case "Grep":
      return str(args.pattern) ? `Searching for “${clip(str(args.pattern), 50)}”` : "Searching the code";
    case "WebFetch":
      return str(args.url) ? `Reading ${host(str(args.url))}` : "Reading a web page";
    case "WebSearch":
      return str(args.query) ? `Searching the web: “${clip(str(args.query), 60)}”` : "Searching the web";
    case "TodoWrite":
      return "Planning the steps";
    case "Task":
      return str(args.description)
        ? `Working on a sub-task: ${clip(str(args.description), 60)}`
        : "Working on a sub-task";
    case "AskUserQuestion":
      return "Asking you a question";
    case "ToolSearch":
    case "EnterPlanMode":
    case "ExitPlanMode":
    case "Skill":
      return null;
    default:
      // A connected service's tool (mcp__figma__get_design_context) reads
      // "Using Figma: get design context"; our own server's tools produce
      // their own UI and stay silent.
      if (name.startsWith("mcp__")) return mcpToolLabel(name);
      return clip(name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), 60);
  }
}

// --- bridge ------------------------------------------------------------------

interface Block {
  kind: "text" | "tool_use" | "thinking" | "other";
  id?: string;
  name?: string;
  json: string;
  text: string;
  tap?: ToolArgTap;
}

interface RunState {
  tool: string; // mapped OPNinfer name
  agentTool: string; // Claude Code name
  args: Record<string, unknown>;
  startedAt: number;
  execAnnounced: boolean;
}

function normaliseUsage(m: Record<string, unknown> | undefined): AgentUsage {
  const n = (k: string) => (typeof m?.[k] === "number" ? (m![k] as number) : 0);
  return {
    inputTokens: n("inputTokens"),
    outputTokens: n("outputTokens"),
    cacheReadTokens: n("cacheReadInputTokens"),
    cacheWriteTokens: n("cacheCreationInputTokens"),
  };
}

/** tool_result content arrives as a string or as [{type:"text", text}] . */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function countLines(s: string): number {
  return s.length === 0 ? 0 : s.split("\n").length;
}

/**
 * Feed every SDK message in order; collect the events. One instance per
 * query. Never throws: anything unrecognised or malformed is ignored, because
 * a translation hiccup must not end a run that is otherwise working.
 */
export class AgentBridge {
  private blocks = new Map<number, Block>();
  private runs = new Map<string, RunState>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  feed(raw: unknown): AgentEvent[] {
    try {
      return this.feedUnsafe(raw);
    } catch {
      return [];
    }
  }

  private feedUnsafe(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== "object") return [];
    const msg = raw as Record<string, any>;
    // Sub-agent traffic (parent_tool_use_id set) is collapsed to the Task
    // tool's own status line — its inner steps would render as a second,
    // interleaved run with no owner.
    if (msg.parent_tool_use_id) return [];

    switch (msg.type) {
      case "system":
        return this.onSystem(msg);
      case "stream_event":
        return this.onStreamEvent(msg.event);
      case "user":
        return this.onUser(msg);
      case "rate_limit_event":
        return msg.rate_limit_info ? [{ type: "rate_limit", info: msg.rate_limit_info }] : [];
      case "result":
        return this.onResult(msg);
      default:
        return [];
    }
  }

  private onSystem(msg: Record<string, any>): AgentEvent[] {
    switch (msg.subtype) {
      case "init":
        return [
          {
            type: "session",
            sessionId: String(msg.session_id ?? ""),
            model: String(msg.model ?? ""),
            tools: Array.isArray(msg.tools) ? msg.tools.map(String) : [],
          },
        ];
      case "api_retry":
        return [
          {
            type: "retry",
            attempt: Number(msg.attempt ?? 0),
            maxRetries: Number(msg.max_retries ?? 0),
            delayMs: Number(msg.retry_delay_ms ?? 0),
            ...(msg.error ? { reason: String(msg.error) } : {}),
          },
        ];
      case "compact_boundary":
        return [{ type: "compact", preTokens: Number(msg.compact_metadata?.pre_tokens ?? 0) }];
      default:
        return [];
    }
  }

  private onStreamEvent(ev: Record<string, any> | undefined): AgentEvent[] {
    if (!ev) return [];
    const out: AgentEvent[] = [];
    switch (ev.type) {
      case "message_start":
        // A fresh assistant message: block indices restart at 0.
        this.blocks.clear();
        break;

      case "content_block_start": {
        const cb = ev.content_block ?? {};
        const index = Number(ev.index ?? 0);
        if (cb.type === "tool_use") {
          const name = String(cb.name ?? "");
          const id = String(cb.id ?? "");
          const map = RUN_MAP[name];
          const block: Block = { kind: "tool_use", id, name, json: "", text: "" };
          if (map && id) {
            block.tap = new ToolArgTap(name, { codeKey: map.codeKey, fileKey: map.fileKey });
            this.runs.set(id, {
              tool: map.tool,
              agentTool: name,
              args: {},
              startedAt: this.now(),
              execAnnounced: false,
            });
            // The tool NAME is known before a single argument byte — open the
            // card now, exactly what makes the UI feel alive.
            out.push({ type: "run_start", id, tool: map.tool });
          }
          this.blocks.set(index, block);
        } else if (cb.type === "text") {
          this.blocks.set(index, { kind: "text", json: "", text: "" });
        } else if (cb.type === "thinking") {
          this.blocks.set(index, { kind: "thinking", json: "", text: "" });
        } else {
          this.blocks.set(index, { kind: "other", json: "", text: "" });
        }
        break;
      }

      case "content_block_delta": {
        const block = this.blocks.get(Number(ev.index ?? 0));
        if (!block) break;
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && block.kind === "text") {
          block.text += String(d.text ?? "");
        } else if (d.type === "input_json_delta" && block.kind === "tool_use") {
          const partial = String(d.partial_json ?? "");
          block.json += partial;
          if (block.tap && block.id) {
            for (const e of block.tap.feed(partial)) {
              if (e.kind === "file") {
                out.push({ type: "run_code", id: block.id, delta: "", file: displayPath(e.name) });
              } else {
                out.push({ type: "run_code", id: block.id, delta: e.delta });
              }
            }
          }
        }
        break;
      }

      case "content_block_stop": {
        const index = Number(ev.index ?? 0);
        const block = this.blocks.get(index);
        if (!block) break;
        if (block.kind === "text") {
          // Narration → an activity line (owner decision), never reply prose.
          const t = block.text.trim();
          if (t) out.push({ type: "status", label: clip(t.replace(/\s+/g, " "), 200) });
        } else if (block.kind === "tool_use" && block.name) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(block.json || "{}");
          } catch {
            /* partial/garbled — labels degrade gracefully */
          }
          const run = block.id ? this.runs.get(block.id) : undefined;
          if (run) {
            run.args = args;
            // A run whose deltas never streamed (defensive): backfill the
            // code so the block isn't empty when the result lands.
            if (!block.json.length) {
              const map = RUN_MAP[block.name];
              const file = map.fileKey && str(args[map.fileKey]);
              if (file) out.push({ type: "run_code", id: block.id!, delta: "", file: displayPath(file) });
            }
          } else {
            const label = agentToolLabel(block.name, args);
            if (label) out.push({ type: "status", label });
          }
        }
        this.blocks.delete(index);
        break;
      }
    }
    return out;
  }

  /** Tool results come back as user-role messages keyed by tool_use_id. */
  private onUser(msg: Record<string, any>): AgentEvent[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const out: AgentEvent[] = [];
    for (const item of content) {
      if (!item || item.type !== "tool_result") continue;
      const id = String(item.tool_use_id ?? "");
      const run = this.runs.get(id);
      if (!run) continue;
      this.runs.delete(id);
      const isError = item.is_error === true;
      const text = resultText(item.content);
      const durationMs = Math.max(0, this.now() - run.startedAt);

      if (run.agentTool === "Bash") {
        // The structured twin, when present, separates stdout/stderr; the
        // text content is the model-facing merge and is what we show.
        const structured = msg.tool_use_result;
        const command = str(run.args.command);
        if (!run.execAnnounced) {
          out.push({ type: "run_exec", id, command });
          run.execAnnounced = true;
        }
        const output =
          structured && typeof structured === "object"
            ? [str(structured.stdout), str(structured.stderr)].filter(Boolean).join("\n") || text
            : text;
        if (output) out.push({ type: "run_out", id, delta: output });
        out.push({
          type: "run_done",
          id,
          exec: {
            durationMs,
            // Claude Code reports failure via is_error, not a numeric code;
            // 1 is the honest translation of "it failed".
            exitCode: isError ? 1 : 0,
            lines: countLines(output),
            ...(structured && typeof structured === "object" && structured.interrupted ? { timedOut: true } : {}),
          },
          ...(isError ? { error: clip(text, 300) } : {}),
        });
        continue;
      }

      if (isError) {
        out.push({ type: "run_done", id, error: clip(text, 300) });
        continue;
      }
      if (run.agentTool === "Write") {
        const body = raw(run.args.content);
        out.push({
          type: "run_done",
          id,
          diff: { added: countLines(body), removed: 0, created: true },
        });
      } else if (run.agentTool === "Edit") {
        const stat = lineDiffStat(raw(run.args.old_string), raw(run.args.new_string));
        out.push({ type: "run_done", id, diff: stat });
      } else {
        out.push({ type: "run_done", id });
      }
    }
    return out;
  }

  private onResult(msg: Record<string, any>): AgentEvent[] {
    const byModel: Record<string, AgentUsage> = {};
    const total: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const mu = msg.modelUsage;
    if (mu && typeof mu === "object") {
      for (const [model, u] of Object.entries(mu as Record<string, Record<string, unknown>>)) {
        const n = normaliseUsage(u);
        byModel[model] = n;
        total.inputTokens += n.inputTokens;
        total.outputTokens += n.outputTokens;
        total.cacheReadTokens += n.cacheReadTokens;
        total.cacheWriteTokens += n.cacheWriteTokens;
      }
    }
    const subtype = String(msg.subtype ?? "unknown");
    const errors = Array.isArray(msg.errors) ? msg.errors.map(String).join("\n") : "";
    return [
      {
        type: "result",
        ok: subtype === "success" && msg.is_error !== true,
        subtype,
        text: typeof msg.result === "string" ? msg.result : errors,
        numTurns: Number(msg.num_turns ?? 0),
        durationMs: Number(msg.duration_ms ?? 0),
        costUsd: Number(msg.total_cost_usd ?? 0),
        usage: total,
        byModel,
        permissionDenials: Array.isArray(msg.permission_denials) ? msg.permission_denials.length : 0,
      },
    ];
  }

  /** Runs the agent opened but never reported on (the query died mid-tool).
   *  The caller emits run_done for these so no live block spins forever. */
  danglingRuns(): string[] {
    return [...this.runs.keys()];
  }
}
