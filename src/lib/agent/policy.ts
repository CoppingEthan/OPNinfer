import { parseAskQuestions, type AskAnswer, type AskQuestion } from "@/lib/ask";
import { AGENT_WORKSPACE } from "./bridge";
import { MCP_RESERVED_NAMES, mcpServerOf } from "./mcp";

/**
 * The Sandbox agent's permission policy and prompt — the pure, tested half of
 * the `sandbox_task` tool. Every rule the agent runs under is a plain
 * function here, so "what would happen if the agent tried X" is a unit test
 * rather than a live run.
 */

export const AGENT_TOOL_NAME = "sandbox_task";

/**
 * Claude Code tools approved WITHOUT consulting the permission callback.
 * Read-only or harmless inside the container. (A bare name in allowedTools
 * auto-approves the whole tool before canUseTool is consulted — the spike
 * proved that — so nothing that can write goes in this list.)
 */
export const AGENT_AUTO_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ToolSearch",
  "Skill",
  "TaskOutput",
  "mcp__opninfer__present_files",
];

/**
 * Claude Code tools removed from the agent entirely. These belong to an
 * interactive developer session — cron jobs, worktrees, messaging other
 * sessions, scheduling wake-ups — and have no meaning inside a chat's
 * sandbox. Removing rather than denying keeps them out of the model's
 * context altogether.
 */
export const AGENT_DISALLOWED_TOOLS: readonly string[] = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "SendMessage",
  "EnterWorktree",
  "ExitWorktree",
  "ReportFindings",
  "DesignSync",
  "EnterPlanMode",
  "ExitPlanMode",
  "Monitor",
  "RemoteTrigger",
  "PushNotification",
];

export type PolicyDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  /** Route to the user's question card; the caller waits and answers. */
  | { behavior: "ask_user" };

/** Which argument names a file path, per writing tool. */
const PATH_KEY: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * Decide one tool use.
 *
 * The only hard rule is WORKSPACE CONTAINMENT for writes: acceptEdits
 * auto-approves edits inside cwd, so a write reaching the callback is one
 * outside it — and with a blanket allow the agent wrote its deliverable to
 * /tmp: task reported done, nothing in the user's pool, no error anywhere.
 * Everything else is allowed: the container is the security boundary, and
 * Bash inside it is the agent's whole point.
 */
export function decideToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string = AGENT_WORKSPACE,
  /** Connected services (MCP) set up for THIS instance. When given, a tool
   *  from any other server is refused — whatever the CLI happened to load.
   *  A subscription login carries the operator's claude.ai connectors
   *  (Gmail, Calendar…); strict mode keeps them out of a run, and this is
   *  the second lock in case a CLI update ever changes that. */
  mcpAllow?: ReadonlySet<string>,
): PolicyDecision {
  if (toolName === "AskUserQuestion") return { behavior: "ask_user" };
  const server = mcpServerOf(toolName);
  if (server && mcpAllow && !MCP_RESERVED_NAMES.has(server) && !mcpAllow.has(server)) {
    return {
      behavior: "deny",
      message: `The "${server}" service isn't set up for this portal, so its tools can't be used here. Carry on without it.`,
    };
  }
  const pathKey = PATH_KEY[toolName];
  if (pathKey) {
    const p = typeof input[pathKey] === "string" ? (input[pathKey] as string) : "";
    // A path check, not a string prefix (audit 2026-09-05):
    // `/workspace/../home/sandbox/.claude-shared/x` began with the prefix.
    if (!p.startsWith(workspace + "/") || !normalisedInside(p, workspace)) {
      return {
        behavior: "deny",
        message: `Write inside ${workspace} only — that is this chat's workspace, and files anywhere else are lost when the run ends. Use a path under ${workspace}.`,
      };
    }
  }
  return { behavior: "allow" };
}

/**
 * The agent's AskUserQuestion input is structurally the same shape as our
 * ask card's questions, so the existing validator does the translation.
 * Null = malformed (the caller denies with guidance rather than parking on
 * a card that can't render).
 */
export function askQuestionsFromAgent(input: Record<string, unknown>): AskQuestion[] | null {
  const parsed = parseAskQuestions(input.questions);
  return "error" in parsed ? null : parsed.questions;
}

/**
 * What AskUserQuestion expects back: the same input plus `answers`, keyed by
 * the question text, valued by the chosen option label(s). A skipped
 * question gets an explicit instruction rather than an empty string, so the
 * agent picks a default instead of stalling.
 */
export function askAnswersForAgent(
  input: Record<string, unknown>,
  questions: AskQuestion[],
  answers: AskAnswer[],
): Record<string, unknown> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = answers.find((x) => x.question === q.question);
    out[q.question] =
      a && a.chosen.length > 0
        ? a.chosen.join(", ")
        : "No answer given — choose the most sensible default and carry on.";
  }
  return { ...input, answers: out };
}

/**
 * Appended to Claude Code's own system prompt. Short on purpose: the agent
 * already knows how to code; what it doesn't know is where it is, who it's
 * working for, and how a file reaches the user.
 */
export function buildAgentSystemAppend(opts: {
  /** The assistant's identity + the admin's standing instructions. */
  assistantBlock: string;
  workspace?: string;
  /** Connected services (MCP) the agent is signed in to, as one line
   *  (`describeMcpServers`); empty = no section. */
  services?: string;
}): string {
  const ws = opts.workspace ?? AGENT_WORKSPACE;
  const services = opts.services?.trim()
    ? [
        "## Connected services",
        `You are signed in to these services through MCP and can use their tools directly (they may sit behind ToolSearch — search by the service's name): ${opts.services.trim()}. When the user's request involves one of them, use it rather than saying you have no access.`,
        "",
      ]
    : [];
  return [
    "## Where you are",
    `You are the Sandbox: an autonomous agent working inside ONE chat of a private company AI portal. Your working directory ${ws} is this chat's private workspace — the user's uploaded files are already there, and it is the ONLY place your work survives. Write every file under ${ws}.`,
    "",
    "## What is already installed",
    "Python 3 and Node with the common libraries, fonts, OCR, and Playwright WITH a headless Chromium already in place for both Python and Node (at $PLAYWRIGHT_BROWSERS_PATH), plus `html2png` for rendering HTML to an image. Never run `playwright install`, `apt-get`, or `sudo` — the root filesystem is read-only and a browser download hangs, spending the run's time budget on nothing. If a README or script tells you to install a browser, skip that step and check what is present instead (`pip show <pkg>`, `python3 -c 'import x'`, `ls $PLAYWRIGHT_BROWSERS_PATH`).",
    "",
    "## Handing work over",
    "The user cannot see your terminal or your files. When a file is a finished deliverable (a report, a spreadsheet, an image, a script they asked for), call the `present_files` tool with its filename — that is what puts it in front of them. Present the deliverables they asked for, not your scratch files.",
    "",
    "## Finishing",
    "The user will read a short summary written by the portal's conversation model from your final message — so end with a clear, plain-English account of what you did, what you produced (by filename), and anything you couldn't do or had to assume. No need to repeat file contents.",
    "",
    ...services,
    "## Who you work for",
    opts.assistantBlock,
  ].join("\n");
}

/**
 * Why a subscription-mode run failed, when it is the SUBSCRIPTION's fault
 * rather than the task's. These two are the cases an admin must hear about
 * by email (they stop every user's Sandbox until fixed) and the cases a run
 * should fail over to the organisation's API key for, if one is configured.
 *
 *  - `signed_out`: the login in the credential volume is gone or expired —
 *    the CLI says "Not logged in · Please run /login" (or an auth error).
 *  - `rate_limit`: the plan's session/weekly window is spent — the CLI's
 *    result carries a usage-limit / rate-limit error, or the plan reported
 *    `status: "rejected"`.
 */
export type SubscriptionFailure = "signed_out" | "rate_limit" | null;

/** Resolve `.`/`..` segments (POSIX) and say whether the result still sits
 *  under `root`. Pure, so the policy stays testable without node:path. */
export function normalisedInside(p: string, root: string): boolean {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return false;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const norm = `/${out.join("/")}`;
  return norm === root || norm.startsWith(`${root}/`);
}

export function classifySubscriptionFailure(
  resultText: string,
  planStatus?: "allowed" | "allowed_warning" | "rejected" | null,
): SubscriptionFailure {
  const t = resultText.toLowerCase();
  if (/not logged in|please run \/login|authentication_error|invalid.*(token|credential)|token.*expired|login.*expired|oauth/.test(t)) {
    return "signed_out";
  }
  if (planStatus === "rejected") return "rate_limit";
  if (/rate.?limit|usage.?limit|limit.*reached|too many requests|\b429\b|quota/.test(t)) {
    return "rate_limit";
  }
  return null;
}

/** The tool result handed back to the conversation model. */
export function summariseAgentRun(opts: {
  ok: boolean;
  text: string;
  presented: string[];
  numTurns: number;
  durationMs: number;
  denials: number;
  subtype: string;
}): string {
  const secs = Math.round(opts.durationMs / 1000);
  const body = opts.text.trim().slice(0, 6_000) || "(the agent finished without a final message)";
  // NB: mid-run user messages are deliberately NOT relayed here. They reach
  // the conversation model as genuine user turns via the interject mailbox
  // (drained by the pipeline the moment this tool returns) — a note inside a
  // tool result saying "the user also said…" was, correctly, treated by the
  // model as a likely injection and ignored.
  if (!opts.ok) {
    return (
      `Error: the Sandbox run did not complete (${opts.subtype}). ` +
      `Its last words: ${body} ` +
      "[To the assistant: tell the user plainly what happened; you may retry with a narrower task if that would help.]"
    );
  }
  const lines = [body];
  if (opts.presented.length) {
    lines.push(
      `\nFiles presented to the user (already visible to them — don't repeat their contents): ${opts.presented.join(", ")}`,
    );
  } else {
    lines.push(
      "\n(No files were presented. If the user was expecting a file, say so — the agent may have described the work without handing anything over.)",
    );
  }
  lines.push(`\n[Sandbox run: ${opts.numTurns} steps in ${secs}s${opts.denials ? `, ${opts.denials} blocked action(s)` : ""}]`);
  return lines.join("");
}
