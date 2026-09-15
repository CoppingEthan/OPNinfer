import "server-only";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx } from "./types";
import {
  accessFor,
  listWorkflows,
  loadWorkflowBody,
  noteWorkflow,
  resolveWorkflow,
  upsertWorkflow,
} from "@/lib/workflow-store";
import { canEdit, canUse } from "@/lib/workflows";

/**
 * The workflow tools — the L2 half of the same progressive disclosure skills
 * use: the names and descriptions ride every turn, the body costs a call.
 *
 * There are three, and the split between the last two is the design:
 *
 *   load_workflow  read the playbook
 *   note_workflow  append ONE lesson under the notes heading
 *   save_workflow  write or replace the instructions themselves
 *
 * `note_workflow` exists so that "remember they prefer British spelling" never
 * has to go through a whole-document rewrite. A workflow is the user's own
 * writing; the worst a stray note can do is add a bullet, whereas the worst a
 * stray rewrite can do is delete instructions somebody spent an afternoon on.
 * The descriptions below say so in terms, because this is exactly the kind of
 * distinction a model will collapse if left to infer it.
 */

export const LOAD_WORKFLOW_DEF: ToolDef = {
  name: "load_workflow",
  description:
    "Load one of the person's own workflows by name (from the WORKFLOWS list) and follow it. " +
    "Call this BEFORE starting the task, not after — the workflow usually changes how the task should be done.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact name from the WORKFLOWS list." },
    },
    required: ["name"],
  },
};

export const NOTE_WORKFLOW_DEF: ToolDef = {
  name: "note_workflow",
  description:
    "Append ONE short lesson to a workflow, after doing the job — something that would make the next run better. " +
    "Good notes are corrections the person actually gave you ('they wanted it a third shorter', 'keep the client's own product names'). " +
    "Use this rather than save_workflow for anything you LEARNED: it adds a line and cannot damage their instructions. " +
    "Do not note the obvious, do not note the same thing twice, and do not note anything about the person themselves — that is what memory is for.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact name from the WORKFLOWS list." },
      note: { type: "string", description: "One sentence. What to do differently next time." },
    },
    required: ["name", "note"],
  },
};

export const SAVE_WORKFLOW_DEF: ToolDef = {
  name: "save_workflow",
  description:
    "Create a workflow, or replace the instructions of one that exists, when the person ASKS you to — " +
    "'save that as a workflow', 'remember this as how I want X done', 'change step 3'. " +
    "Never call this to record something you learned (use note_workflow) and never call it unprompted: " +
    "it replaces what they wrote. Write the body as short markdown instructions addressed to you.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short name, 2-5 words, sentence case, naming the JOB ('Rewrite a document'). Reuse the exact existing name to replace one.",
      },
      description: {
        type: "string",
        description: "One line, under 160 characters, saying when this workflow applies.",
      },
      body: {
        type: "string",
        description: "The instructions, as markdown. Steps, rules, and what to hand back.",
      },
    },
    required: ["name", "description", "body"],
  },
};

export const WORKFLOW_DEFS = [LOAD_WORKFLOW_DEF, NOTE_WORKFLOW_DEF, SAVE_WORKFLOW_DEF];

async function notFound(userId: string, name: string): Promise<string> {
  const available = (await listWorkflows(userId)).map((w) => w.name);
  return (
    `Error: no workflow named "${name}". ` +
    (available.length
      ? `Available: ${available.join(", ")}.`
      : "This person has no workflows yet — use save_workflow only if they ask you to create one.")
  );
}

export async function executeLoadWorkflow(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const name = String(args.name ?? "").trim();
  const hit = await resolveWorkflow(ctx.userId, name);
  if (!hit) return notFound(ctx.userId, name);

  const access = await accessFor(hit.id, ctx.userId);
  if (!access || !canUse(access.role)) return notFound(ctx.userId, name);

  const body = await loadWorkflowBody(hit.id);
  if (body === null) return notFound(ctx.userId, name);
  return (
    `WORKFLOW "${hit.displayName}" — the person's own instructions for this job. ` +
    `Follow them over your default approach; where they are silent, use your judgement.\n\n${body}`
  );
}

export async function executeNoteWorkflow(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const name = String(args.name ?? "").trim();
  const note = String(args.note ?? "").trim();
  if (!note) return "Error: note is empty.";

  const hit = await resolveWorkflow(ctx.userId, name);
  if (!hit) return notFound(ctx.userId, name);
  const access = await accessFor(hit.id, ctx.userId);
  if (!access || !canEdit(access.role)) return notFound(ctx.userId, name);

  const ok = await noteWorkflow(hit.id, note);
  return ok
    ? `Noted on "${hit.displayName}". It will be there next time this workflow runs.`
    : `Error: could not add that note to "${hit.displayName}".`;
}

export async function executeSaveWorkflow(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const name = String(args.name ?? "").trim();
  const description = String(args.description ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!name || !body) return "Error: a workflow needs a name and a body.";

  // Replacing one that is shared with you is allowed — that is the point of
  // sharing — but replacing one you cannot see is not, and would otherwise
  // silently create a second workflow with a colleague's name on it.
  const existing = await resolveWorkflow(ctx.userId, name);
  if (existing) {
    const access = await accessFor(existing.id, ctx.userId);
    if (!access || !canEdit(access.role)) return notFound(ctx.userId, name);
  }

  const saved = await upsertWorkflow({
    userId: ctx.userId,
    name,
    description: description || "A saved way of doing a recurring job.",
    body,
    fromModel: true,
  });
  return saved.created
    ? `Saved a new workflow, "${saved.name}". They can edit or share it from Workflows in the sidebar.`
    : `Updated the workflow "${saved.name}".`;
}
