import "server-only";
import type { ToolDef } from "@/lib/providers/types";
import { getSetting } from "@/lib/settings";
import { devLog } from "@/lib/dev-log";
import { loadCapabilityTools } from "@/lib/capabilities/registry";
import { FILE_TOOLS, executeFileTool } from "@/lib/file-tools";
import {
  DATE_TIME_NOW_DEF,
  DATE_TIME_DIFF_DEF,
  executeDateTimeNow,
  executeDateTimeDiff,
} from "./date-time";
import {
  WEB_SEARCH_DEF,
  WEB_SCRAPE_DEF,
  WEB_SEARCH_AND_READ_DEF,
  DOWNLOAD_FILE_DEF,
  executeWebSearch,
  executeWebScrape,
  executeWebSearchAndRead,
  executeDownloadFile,
} from "./web";
import { VIEW_IMAGE_DEF, executeViewImage } from "./view-image";
import { LOAD_SKILL_DEF, executeLoadSkill } from "./skills";
import {
  LOAD_WORKFLOW_DEF,
  NOTE_WORKFLOW_DEF,
  SAVE_WORKFLOW_DEF,
  executeLoadWorkflow,
  executeNoteWorkflow,
  executeSaveWorkflow,
} from "./workflows";
import {
  IMAGE_GENERATION_DEF,
  IMAGE_EDIT_DEF,
  IMAGE_BLEND_DEF,
  executeImageGeneration,
  executeImageEdit,
  executeImageBlend,
} from "./images";
import { PRESENT_FILES_DEF, executePresentFiles } from "./present";
import { ASK_USER_DEF, executeAskUser } from "./ask";
import {
  MEMORY_VIEW_DEF,
  MEMORY_UPDATE_DEF,
  executeMemoryView,
  executeMemoryUpdate,
  getMemoryConfig,
} from "./memory";
import { SEARCH_MY_CHATS_DEF, executeSearchMyChats } from "./chat-search";
import type {
  RegisteredTool,
  ToolCtx,
  ToolGroup,
  ToolOutput,
  ToolStreamEvent,
} from "./types";

/**
 * Central tool registry (v0.3). Adding a tool = one `registerTool` call; the
 * chat route builds a per-turn `Toolset` from here, and the pipeline stays
 * generic. Groups are the unit the (later) tool router classifies on, and the
 * unit admins will toggle on the Tools page.
 */

const REGISTRY = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  if (REGISTRY.has(tool.def.name)) {
    throw new Error(`Duplicate tool registration: ${tool.def.name}`);
  }
  REGISTRY.set(tool.def.name, tool);
}

export function registeredGroups(): ToolGroup[] {
  return [...new Set([...REGISTRY.values()].map((t) => t.group))];
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------

// Files — the storage-pool tools from 0.2.0, now registry citizens. Their
// executor takes raw JSON (it predates the registry), so re-serialize.
for (const def of FILE_TOOLS) {
  registerTool({
    def,
    group: "files",
    execute: (args, ctx) =>
      executeFileTool(ctx.conversationId, def.name, JSON.stringify(args)),
  });
}

registerTool({ def: DATE_TIME_NOW_DEF, group: "datetime", execute: (a) => executeDateTimeNow(a) });
registerTool({ def: DATE_TIME_DIFF_DEF, group: "datetime", execute: (a) => executeDateTimeDiff(a) });

// Web — Tavily search/scrape run app-side; download_file streams into the
// conversation pool (SSRF-guarded) and rides the ingestion pipeline.
registerTool({ def: WEB_SEARCH_DEF, group: "web", execute: (a) => executeWebSearch(a) });
registerTool({ def: WEB_SCRAPE_DEF, group: "web", execute: (a) => executeWebScrape(a) });
registerTool({ def: WEB_SEARCH_AND_READ_DEF, group: "web", execute: (a) => executeWebSearchAndRead(a) });
registerTool({ def: DOWNLOAD_FILE_DEF, group: "web", execute: executeDownloadFile });

// Image viewing — pull any pool image back into the model's sight on demand.
registerTool({ def: VIEW_IMAGE_DEF, group: "image", execute: executeViewImage });

// Image creation — Gemini only (honest errors, no fallback backend); outputs
// are kind=generated pool files with per-user weekly quotas.
registerTool({ def: IMAGE_GENERATION_DEF, group: "image", execute: executeImageGeneration });
registerTool({ def: IMAGE_EDIT_DEF, group: "image", execute: executeImageEdit });
registerTool({ def: IMAGE_BLEND_DEF, group: "image", execute: executeImageBlend });

// Skills — progressive disclosure: L1 list rides the system prompt, the full
// body loads on demand (assets staged into the pool, non-overwriting).
registerTool({ def: LOAD_SKILL_DEF, group: "skills", execute: executeLoadSkill });

// Workflows — the user's OWN playbooks, same L1/L2 shape as skills. The three
// tools are deliberately split so that "what I learned" (note) can never take
// the path that rewrites "what you told me to do" (save).
registerTool({ def: LOAD_WORKFLOW_DEF, group: "workflows", execute: executeLoadWorkflow });
registerTool({ def: NOTE_WORKFLOW_DEF, group: "workflows", execute: executeNoteWorkflow });
registerTool({ def: SAVE_WORKFLOW_DEF, group: "workflows", execute: executeSaveWorkflow });

// Visualisation: NO tool since 2026-07-13 — the marker protocol is taught by
// a system block (tools/visualize.ts VIZ_PROTOCOL_BLOCK, injected by the chat
// route unless the "visualize" group is admin-disabled) and the model emits
// @@@VIZ markers directly. The group id lives on in tools_config toggles.

// The old one-command-at-a-time sandbox family (write_file / edit_file /
// delete_file / execute_command / run_script) was RETIRED in v0.4: the
// Sandbox capability's `sandbox_task` (a full agent in a container) replaces
// it. Their names live on only as the run-block UI's vocabulary, which the
// agent bridge maps Claude Code's tools onto.
//
// Presentation stays: pool files are the assistant's WORKSPACE (invisible to
// the user) and this is the deliberate hand-over of deliverables — the agent
// presents through its own host-side copy of this tool mid-run, and the
// conversation model can present an earlier turn's file later ("give me the
// script"). In the files group, so it's offered whenever the chat has files.
registerTool({ def: PRESENT_FILES_DEF, group: "files", execute: executePresentFiles });

// Asking the user — pauses the reply on a multiple-choice card and resumes it
// with the answer. Its own group so an admin can switch the behaviour off
// instance-wide, and deliberately NOT deferred (disclosure.ts): the model has
// to be able to reach for it the moment it's unsure, and its schema is small.
registerTool({ def: ASK_USER_DEF, group: "ask", execute: executeAskUser });

// Memory v2 (0.5.1) — four notes per person, auto-injected each turn; the
// remember tool REWRITES a note in full. Excluded in incognito and shared
// chats (the turn passes excludeGroups), withheld when the person paused
// (excludeTools), never context-curated. `search_my_chats` looks things up
// in the person's own earlier conversations — gated by the admin's memory
// settings (chatSearch), not by a group of its own.
registerTool({ def: MEMORY_VIEW_DEF, group: "memory", execute: executeMemoryView });
registerTool({ def: MEMORY_UPDATE_DEF, group: "memory", execute: executeMemoryUpdate });
registerTool({ def: SEARCH_MY_CHATS_DEF, group: "memory", execute: executeSearchMyChats });

// ---------------------------------------------------------------------------
// Per-turn toolset
// ---------------------------------------------------------------------------

export interface Toolset {
  tools: ToolDef[];
  /** Distinct groups represented in `tools`. */
  groups: ToolGroup[];
  /** Every active tool with its group — progressive disclosure partitions on this. */
  entries: { group: ToolGroup; def: ToolDef }[];
  /** Admin-disabled groups (Tools page) — lets the route gate NON-tool
   *  features that share the group model (the viz protocol block). */
  disabledGroups: ToolGroup[];
  /** `emit` (optional) receives live events mid-execution — the sandbox exec
   *  tools stream console output through it, `ask_user` raises its question
   *  card through it (ToolCtx.emitEvent). */
  executeTool(name: string, argsJson: string, emit?: (evt: ToolStreamEvent) => void): Promise<ToolOutput>;
}

export interface ToolsetOptions {
  /** Offer the storage-pool tools (a chat with no files skips their schema). */
  includeFiles: boolean;
  /** Hard-exclude groups (e.g. memory in incognito chats). Wins over groups. */
  excludeGroups?: ToolGroup[];
  /** Hard-exclude single tools (memory_update while the person's memory is paused). */
  excludeTools?: string[];
  /** Restrict to these groups (the tool router's output). Omit = all. */
  groups?: ToolGroup[];
}

/** Admin toggles (Tools page): groups switched off instance-wide. */
interface ToolsConfig {
  disabledGroups?: ToolGroup[];
}

/** Build the toolset for one turn: built-in registry + enabled capabilities,
 *  minus admin-disabled groups. Execution is ctx-bound and defensive:
 *  unknown names and bad JSON become error STRINGS the model can react to. */
export async function buildToolset(ctx: ToolCtx, opts: ToolsetOptions): Promise<Toolset> {
  const disabled = new Set(
    ((await getSetting<ToolsConfig>("tools_config"))?.disabledGroups ?? []) as ToolGroup[],
  );
  const candidates: RegisteredTool[] = [
    ...REGISTRY.values(),
    ...(disabled.has("capability") ? [] : await loadCapabilityTools()),
  ];

  const chatSearchOn = disabled.has("memory") ? false : (await getMemoryConfig()).chatSearch;

  const active = new Map<string, RegisteredTool>();
  for (const tool of candidates) {
    if (disabled.has(tool.group)) continue;
    if (tool.group === "files" && !opts.includeFiles) continue;
    if (opts.excludeGroups?.includes(tool.group)) continue;
    if (opts.excludeTools?.includes(tool.def.name)) continue;
    if (opts.groups && !opts.groups.includes(tool.group)) continue;
    if (tool.def.name === "search_my_chats" && !chatSearchOn) continue;
    active.set(tool.def.name, tool);
  }

  // Per-turn call tally (the toolset is built fresh each turn) — lets tools
  // detect repeats, e.g. render_visualization being re-declared instead of
  // the model emitting its markers.
  const callCounts = new Map<string, number>();

  return {
    tools: [...active.values()].map((t) => t.def),
    groups: [...new Set([...active.values()].map((t) => t.group))],
    entries: [...active.values()].map((t) => ({ group: t.group, def: t.def })),
    disabledGroups: [...disabled],
    executeTool: async (name, argsJson, emit) => {
      const tool = active.get(name);
      if (!tool) {
        devLog("warn", "tool", `unknown tool "${name}"`, { conversationId: ctx.conversationId });
        return { text: `Error: unknown tool "${name}".` };
      }
      const turnCallCount = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, turnCallCount);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsJson || "{}");
      } catch {
        devLog("warn", "tool", `${name}: bad JSON args`, { argsJson });
        return { text: "Error: tool arguments were not valid JSON." };
      }
      devLog("debug", "tool", `→ ${name}`, { conversationId: ctx.conversationId, args });
      const t0 = Date.now();
      try {
        const out = await tool.execute(args, { ...ctx, turnCallCount, emitEvent: emit });
        const norm = typeof out === "string" ? { text: out } : out;
        const isErr = norm.text.startsWith("Error:");
        devLog(isErr ? "warn" : "debug", "tool", `← ${name} (${Date.now() - t0}ms)`, {
          resultPreview: norm.text.slice(0, 600),
          images: norm.images?.length ?? 0,
          sources: norm.sources?.length ?? 0,
        });
        return norm;
      } catch (e) {
        devLog("error", "tool", `✖ ${name} threw (${Date.now() - t0}ms)`, {
          conversationId: ctx.conversationId,
          error: e instanceof Error ? e.message : String(e),
        });
        return { text: `Error: tool ${name} failed: ${e instanceof Error ? e.message : e}` };
      }
    },
  };
}
