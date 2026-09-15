import type { ImagePart, ToolDef } from "@/lib/providers/types";
import type { RunDiff, RunExec, RunToolEvent } from "@/lib/tool-run";
import type { AskAnswer, AskQuestion } from "@/lib/ask";
import type { AgentStreamEvent } from "@/lib/agent/bridge";

/**
 * Tool registry types (v0.3 agentic tools). Every tool the assistant can call
 * is registered once with a definition, a GROUP (the unit the tool router
 * classifies on), and an executor. The chat route builds a per-turn toolset
 * from the registry; the pipeline stays generic (ToolDef[] + executeTool).
 */

/**
 * Every tool group, in ONE place — the admin action validates against this list
 * and the Admin → Tools page renders its checkboxes from it.
 *
 * It is a runtime array rather than a bare union because the two used to be
 * kept in step by hand, and weren't: `ask` was added to the type and to the
 * Tools page but never to the action's validator, so unticking "Clarifying
 * questions" was silently discarded — the page said "Saved.", the checkbox
 * stayed unticked until reload, and the assistant kept asking. Derive both
 * from here and that can't recur.
 */
export const TOOL_GROUPS = [
  "files", // list/read/write on the chat's storage pool
  "datetime",
  "web",
  "memory",
  "image",
  "skills",
  "visualize",
  "ask", // pause and ask the user a multiple-choice question
  "workflows", // the person's own saved playbooks (load/note/save)
  "capability", // client-specific capabilities (instance-enabled)
] as const;

/** Routing groups — the classifier picks groups, not individual tools. */
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** A question card the assistant is putting up, mid-execution. Unlike a run
 *  event this one is a REQUEST: the tool then waits for the answer. */
export interface AskToolEvent {
  kind: "ask";
  id: string;
  questions: AskQuestion[];
}

/** A Sandbox agent run's live activity (run blocks, status lines, hand-overs,
 *  usage) — one outer tool call fans out into many inner events. */
export interface AgentToolEvent {
  kind: "agent";
  event: AgentStreamEvent;
}

/** Everything a tool can push UP to the pipeline while it is still running:
 *  the sandbox family's console stream, `ask_user`'s question card, and the
 *  Sandbox agent's whole activity feed. */
export type ToolStreamEvent = RunToolEvent | AskToolEvent | AgentToolEvent;

/** Per-turn execution context threaded into every tool. */
export interface ToolCtx {
  userId: string;
  conversationId: string;
  /** The TURN's abort signal (Stop, a delete racing the reply, the per-turn
   *  hard stop). Tools that WAIT on something external must honour it —
   *  `ask_user` parks on a promise the abort would otherwise never reach.
   *  Absent for non-chat callers (memory chat). */
  signal?: AbortSignal;
  /** How many times THIS tool has been called this turn (1 = first call).
   *  Set by the registry — lets declaration-style tools push back on
   *  pointless repeats (seen live: render_visualization called 4x before
   *  the model emitted anything). */
  turnCallCount?: number;
  /** Push a live event UP to the pipeline mid-execution — the sandbox exec
   *  tools stream their console output through this, and `ask_user` raises its
   *  question card before parking on the answer. Wired per-call by the
   *  pipeline's event bridge; absent for non-chat callers (memory chat), which
   *  is why tools that need it must handle it being missing. */
  emitEvent?: (evt: ToolStreamEvent) => void;
}

/**
 * Separates a tool error's user-facing part from guidance meant only for the
 * MODEL ("tell the user…", "retry with a shorter prompt…"). Tool results are
 * model-facing by nature, but some surfaces (the generated-image placeholder)
 * render the error text directly — found live: the quota refusal's steering
 * instructions appeared verbatim in the image box. Guidance goes after this
 * marker; UI-bound copies are cut at it.
 */
export const ASSISTANT_GUIDANCE_MARKER = "[To the assistant:";

/** The part of a tool error a USER may see: guidance stripped, "Error:"
 *  prefix dropped. */
export function userFacingToolError(text: string): string {
  const cut = text.indexOf(ASSISTANT_GUIDANCE_MARKER);
  return (cut === -1 ? text : text.slice(0, cut)).replace(/^Error:\s*/i, "").trim();
}

/** A resource a tool touched while answering — surfaced to the user as a
 *  clickable "source" under the reply (and persisted with the message).
 *  Web sources open the URL; file sources open the in-app context viewer. */
export interface SourceRef {
  url: string;
  title?: string;
  /** Defaults to "web". */
  kind?: "web" | "file";
  /** files-table id, set when kind is "file". */
  fileId?: string;
}

/** A generated image the assistant produced this turn — surfaced to the UI as
 *  a first-class image (aspect-ratio placeholder → blur-in → download/prompt),
 *  not just a file chip. */
export interface ImageArtifact {
  fileId: string;
  mimeType: string;
  /** e.g. "1:1", "16:9" — drives the placeholder box shape. */
  aspectRatio: string;
  prompt: string;
  operation: "generate" | "edit" | "blend";
  /** Wall-clock generation time (ms) — persisted in the reply's meta.images
   *  (worker-proof, unlike the file meta) so future ETAs learn from it. */
  genMs: number;
}

/** Rich tool output: the text result, plus optional images the loop attaches
 *  for the model to SEE next round (view_image), optional sources the UI shows
 *  the user, and an optional generated-image artifact (image tools). Plain
 *  strings normalize to `{ text }`. */
export interface ToolOutput {
  text: string;
  images?: ImagePart[];
  sources?: SourceRef[];
  artifact?: ImageArtifact;
  /** Run-block summary (sandbox family): the +N −M diff chip and/or the
   *  duration/exit-code chip the UI collapses the live preview into. */
  runMeta?: { diff?: RunDiff; exec?: RunExec };
  /** How an `ask_user` card finished. The route clears the live card on this,
   *  and persists the question + chosen answer on the reply (meta.asks) so the
   *  exchange still reads correctly after a reload. */
  askResult?: {
    id: string;
    status: "answered" | "dismissed" | "expired";
    answers?: AskAnswer[];
    /** Who answered (shared chats — the card shows "Answered by …"). */
    by?: { id: string; name: string };
  };
  /** Pool filenames this call hands over to the USER (present_files, and
   *  download_file's auto-present). The route attaches them to the reply —
   *  images inline, everything else as download cards. */
  presented?: string[];
}

export interface RegisteredTool {
  def: ToolDef;
  group: ToolGroup;
  /** Execute with PARSED args. Return the result fed back to the model —
   *  including error strings (never throw for expected failures). */
  execute(args: Record<string, unknown>, ctx: ToolCtx): Promise<string | ToolOutput>;
}
