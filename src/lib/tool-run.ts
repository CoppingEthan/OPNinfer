/**
 * Live tool-run feedback (sandbox family) — the pure core.
 *
 * When the model writes code (write_file / run_script / edit_file /
 * execute_command), the providers stream the tool-call ARGUMENTS token by
 * token. `ToolArgTap` is an incremental JSON lexer that extracts the code
 * string (and the filename) from that partial-JSON stream as it arrives, so
 * the UI can show a live 5-line "watching it type" preview; `ToolRunTracker`
 * turns taps into ordered pipeline events. `lineDiffStat` produces the
 * +N −M chip shown once the write lands.
 *
 * Pure module (no imports, no server-only): shared by the pipeline (server),
 * the chat components (client), and unit tests.
 */

/** The tools whose activity renders as a rich run block, not a status line. */
export const RUN_TOOLS = new Set(["write_file", "edit_file", "run_script", "execute_command"]);

/** Which argument holds "the code being written", per tool. */
const CODE_KEY: Record<string, string> = {
  write_file: "content",
  run_script: "content",
  edit_file: "replace",
  execute_command: "command",
};

/** Which argument names the file being touched (execute_command has none). */
const FILE_KEY: Record<string, string> = {
  write_file: "name",
  run_script: "name",
  edit_file: "name",
};

// --- shared result shapes (persisted in messages.meta.toolRuns) --------------

/** +N −M line stats for a file mutation. */
export interface RunDiff {
  added: number;
  removed: number;
  /** The file didn't exist before this write. */
  created?: boolean;
}

/** How an execution went (execute_command / run_script). */
export interface RunExec {
  durationMs: number;
  exitCode: number;
  /** Console output line count (stdout + stderr). */
  lines: number;
  timedOut?: boolean;
  oomKilled?: boolean;
}

/** One tool run as persisted on the reply (meta.toolRuns) — lets the
 *  collapsed chips (and their expandable code/console) survive reloads. */
export interface ToolRunRecord {
  id: string;
  tool: string;
  file?: string;
  command?: string;
  /** The streamed source/command text (capped by the route). */
  code?: string;
  /** The streamed console output (capped by the route). */
  output?: string;
  diff?: RunDiff;
  exec?: RunExec;
  /** User-facing error text when the tool failed outright. */
  error?: string;
}

// --- events ----------------------------------------------------------------

/** Mid-execution events a tool pushes UP to the pipeline (console streaming). */
export type RunToolEvent =
  | { kind: "exec"; command: string }
  | { kind: "out"; delta: string };

/** Pipeline→UI events for one run block's lifecycle. */
export type RunPipelineEvent =
  | { type: "run_start"; id: string; tool: string; file?: string }
  | { type: "run_code"; id: string; delta: string; file?: string }
  | { type: "run_exec"; id: string; command: string }
  | { type: "run_out"; id: string; delta: string }
  | { type: "run_done"; id: string; diff?: RunDiff; exec?: RunExec; error?: string };

// --- incremental arg tap ------------------------------------------------------

export type TapEvent = { kind: "file"; name: string } | { kind: "code"; delta: string };

type TapMode = "seek" | "key" | "colon" | "value" | "string" | "literal" | "nested";

/**
 * Incremental extractor for one tool call's streaming JSON arguments. Feed it
 * raw `partial_json` / `arguments` deltas; it emits decoded code text as it
 * arrives and the filename once its string closes. Handles tokens split at
 * ANY byte boundary (keys, escapes, `\uXXXX` sequences). Nested object/array
 * values are skipped wholesale, so a key named "content" inside some other
 * value can never false-trigger.
 */
export class ToolArgTap {
  private readonly codeKey: string;
  private readonly fileKey: string | null;

  private mode: TapMode = "seek";
  private esc = false;
  /** Non-null while decoding a `\uXXXX` escape (accumulates hex digits). */
  private uni: string | null = null;
  private keyBuf = "";
  private curKey = "";
  /** What the current string value feeds: emitted code, the file name, or nothing. */
  private target: "code" | "file" | null = null;
  private fileBuf = "";
  private depth = 0;
  private nestedInString = false;
  private nestedEsc = false;

  /**
   * `keys` overrides the built-in per-tool argument names — the Sandbox agent
   * tier streams Claude Code's own tools, whose args are named differently
   * (`content`/`file_path` for Write, `command` for Bash, `new_string` for
   * Edit) but want the very same live preview. Omit it for OPNinfer's tools.
   */
  constructor(tool: string, keys?: { codeKey: string; fileKey?: string }) {
    this.codeKey = keys?.codeKey ?? CODE_KEY[tool] ?? "";
    this.fileKey = keys ? (keys.fileKey ?? null) : (FILE_KEY[tool] ?? null);
  }

  feed(chunk: string): TapEvent[] {
    const events: TapEvent[] = [];
    let code = "";
    const put = (ch: string) => {
      if (this.target === "code") code += ch;
      else if (this.target === "file") this.fileBuf += ch;
    };

    for (const c of chunk) {
      switch (this.mode) {
        case "seek":
          if (c === '"') {
            this.mode = "key";
            this.keyBuf = "";
          }
          // {, }, comma, whitespace: structural noise between members.
          break;

        case "key":
          if (this.esc) {
            // Keys in tool args are plain identifiers; decode just enough.
            this.keyBuf += c === "n" ? "\n" : c === "t" ? "\t" : c;
            this.esc = false;
          } else if (c === "\\") this.esc = true;
          else if (c === '"') {
            this.curKey = this.keyBuf;
            this.mode = "colon";
          } else this.keyBuf += c;
          break;

        case "colon":
          if (c === ":") this.mode = "value";
          break;

        case "value":
          if (c === '"') {
            this.mode = "string";
            this.target =
              this.curKey === this.codeKey ? "code" : this.curKey === this.fileKey ? "file" : null;
            if (this.target === "file") this.fileBuf = "";
          } else if (c === "{" || c === "[") {
            this.mode = "nested";
            this.depth = 1;
            this.nestedInString = false;
            this.nestedEsc = false;
          } else if (!/\s/.test(c)) {
            this.mode = "literal"; // number / true / false / null
          }
          break;

        case "literal":
          if (c === "," || c === "}") this.mode = "seek";
          break;

        case "string":
          if (this.uni !== null) {
            this.uni += c;
            if (this.uni.length === 4) {
              const code_ = parseInt(this.uni, 16);
              put(Number.isNaN(code_) ? "�" : String.fromCharCode(code_));
              this.uni = null;
            }
          } else if (this.esc) {
            this.esc = false;
            if (c === "u") this.uni = "";
            else if (c === "n") put("\n");
            else if (c === "t") put("\t");
            else if (c === "r") put("\r");
            else if (c === "b") put("\b");
            else if (c === "f") put("\f");
            else put(c); // ", \, / — literal
          } else if (c === "\\") this.esc = true;
          else if (c === '"') {
            if (this.target === "file" && this.fileBuf) {
              events.push({ kind: "file", name: this.fileBuf });
            }
            this.target = null;
            this.mode = "seek";
          } else put(c);
          break;

        case "nested":
          if (this.nestedInString) {
            if (this.nestedEsc) this.nestedEsc = false;
            else if (c === "\\") this.nestedEsc = true;
            else if (c === '"') this.nestedInString = false;
          } else if (c === '"') this.nestedInString = true;
          else if (c === "{" || c === "[") this.depth++;
          else if (c === "}" || c === "]") {
            if (--this.depth === 0) this.mode = "seek";
          }
          break;
      }
    }

    if (code) events.push({ kind: "code", delta: code });
    return events;
  }
}

// --- run tracker -----------------------------------------------------------------

interface TrackedRun {
  tap: ToolArgTap;
  tool: string;
  started: boolean;
}

/**
 * Per-turn state turning provider arg-deltas into ordered run events. The
 * pipeline feeds every `tool_call_delta`; non-run tools are ignored. If a
 * call's deltas never streamed (defensive — e.g. a provider quirk),
 * `ensureStarted` synthesizes the start + full code from the completed args.
 */
export class ToolRunTracker {
  private runs = new Map<string, TrackedRun>();

  isRun(tool: string): boolean {
    return RUN_TOOLS.has(tool);
  }

  feedDelta(callId: string, tool: string, argsDelta: string): RunPipelineEvent[] {
    if (!RUN_TOOLS.has(tool)) return [];
    let run = this.runs.get(callId);
    if (!run) {
      run = { tap: new ToolArgTap(tool), tool, started: false };
      this.runs.set(callId, run);
    }
    const out: RunPipelineEvent[] = [];
    if (!run.started) {
      run.started = true;
      out.push({ type: "run_start", id: callId, tool });
    }
    for (const e of run.tap.feed(argsDelta)) {
      if (e.kind === "file") out.push({ type: "run_code", id: callId, delta: "", file: e.name });
      else out.push({ type: "run_code", id: callId, delta: e.delta });
    }
    return out;
  }

  /** Fallback for a run tool whose args never streamed as deltas. */
  ensureStarted(callId: string, tool: string, argsJson: string): RunPipelineEvent[] {
    if (!RUN_TOOLS.has(tool) || this.runs.get(callId)?.started) return [];
    this.runs.set(callId, { tap: new ToolArgTap(tool), tool, started: true });
    const out: RunPipelineEvent[] = [{ type: "run_start", id: callId, tool }];
    try {
      const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
      const file = typeof args[FILE_KEY[tool] ?? ""] === "string" ? String(args[FILE_KEY[tool]!]) : undefined;
      const code = typeof args[CODE_KEY[tool] ?? ""] === "string" ? String(args[CODE_KEY[tool]]) : "";
      if (file) out.push({ type: "run_code", id: callId, delta: "", file });
      if (code) out.push({ type: "run_code", id: callId, delta: code });
    } catch {
      /* malformed args — the executor will report the real error */
    }
    return out;
  }
}

// --- diff stats -----------------------------------------------------------------

/**
 * Quick +added/−removed line stats via multiset intersection (unchanged =
 * lines present in both, counted with multiplicity). O(n); moved lines count
 * as unchanged, which is the right feel for a summary chip.
 */
export function lineDiffStat(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 };
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return { added: newLines.length - common, removed: oldLines.length - common };
}
