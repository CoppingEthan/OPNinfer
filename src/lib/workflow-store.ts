import "server-only";
import { db } from "@/lib/db";
import {
  MAX_LISTED,
  appendNote,
  clipBody,
  disambiguate,
  newBody,
  normaliseDescription,
  normaliseName,
  roleFor,
  type WorkflowRole,
  type WorkflowSummary,
} from "@/lib/workflows";

/**
 * Workflows — the database half. The rules and the text handling are in
 * `workflows.ts` (pure, tested); this is the part that talks to Prisma.
 *
 * Access follows shared chats: one document, plus `workflow_members` rows that
 * ARE the sharing. Every read here is scoped by `visibleTo`, so there is one
 * definition of "may this person see it" rather than a condition repeated at
 * each call site — the mistake that shared chats had to unpick across ~40
 * places.
 */

/** Everything this person may see: their own, plus anything shared with them. */
export function visibleTo(userId: string) {
  return { OR: [{ userId }, { members: { some: { userId } } }] };
}

const SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  userId: true,
  updatedAt: true,
  lastUsedAt: true,
  notedAt: true,
  user: { select: { name: true, email: true } },
  members: { select: { userId: true } },
} as const;

export interface WorkflowListItem extends WorkflowSummary {
  mine: boolean;
  shared: boolean;
  memberCount: number;
  updatedAt: string;
  lastUsedAt: string | null;
  notedAt: string | null;
}

function ownerLabel(u: { name: string | null; email: string }): string {
  return u.name?.trim() || u.email.split("@")[0];
}

/**
 * The person's workflows, most recently used first, with display names already
 * made unique — the model addresses these by name, so two the same would be an
 * unresolvable instruction.
 */
export async function listWorkflows(userId: string): Promise<WorkflowListItem[]> {
  const rows = await db.workflow.findMany({
    where: visibleTo(userId),
    orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }],
    select: SUMMARY_SELECT,
  });

  const summaries: WorkflowSummary[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    sharedBy: r.userId === userId ? null : ownerLabel(r.user),
  }));
  const named = new Map(disambiguate(summaries).map((w) => [w.id, w.name]));

  return rows.map((r) => ({
    id: r.id,
    name: named.get(r.id) ?? r.name,
    description: r.description,
    sharedBy: r.userId === userId ? null : ownerLabel(r.user),
    mine: r.userId === userId,
    shared: r.members.length > 0,
    memberCount: r.members.length,
    updatedAt: r.updatedAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    notedAt: r.notedAt?.toISOString() ?? null,
  }));
}

/** The L1 list the chat route injects every turn. */
export async function workflowSummaries(userId: string): Promise<WorkflowSummary[]> {
  const list = await listWorkflows(userId);
  return list.slice(0, MAX_LISTED).map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    sharedBy: w.sharedBy,
  }));
}

/**
 * Find one by the name the MODEL was shown, which may be a disambiguated
 * "… (from Priya)" rather than the stored name. Case-insensitive, because a
 * model that retypes a name rarely matches its capitals.
 */
export async function resolveWorkflow(
  userId: string,
  name: string,
): Promise<{ id: string; displayName: string } | null> {
  const wanted = normaliseName(name).toLowerCase();
  const list = await listWorkflows(userId);
  const hit =
    list.find((w) => w.name.toLowerCase() === wanted) ??
    // A model that drops the "(from …)" suffix still means the right one, as
    // long as only one candidate carries that stored name.
    (list.filter((w) => w.name.toLowerCase().startsWith(`${wanted} (from `)).length === 1
      ? list.find((w) => w.name.toLowerCase().startsWith(`${wanted} (from `))
      : undefined);
  return hit ? { id: hit.id, displayName: hit.name } : null;
}

export async function accessFor(
  workflowId: string,
  userId: string,
): Promise<{ role: WorkflowRole; body: string; name: string } | null> {
  const w = await db.workflow.findUnique({
    where: { id: workflowId },
    select: { userId: true, name: true, body: true, members: { select: { userId: true } } },
  });
  if (!w) return null;
  const role = roleFor(w, userId);
  return role ? { role, body: w.body, name: w.name } : null;
}

/** Read the body, and stamp that it was used — "used 3 days ago" in the list
 *  is what tells someone a playbook has gone stale. */
export async function loadWorkflowBody(workflowId: string): Promise<string | null> {
  const w = await db.workflow.findUnique({ where: { id: workflowId }, select: { body: true } });
  if (!w) return null;
  await db.workflow.update({ where: { id: workflowId }, data: { lastUsedAt: new Date() } });
  return w.body;
}

/** Create, or replace the body of one that already exists under that name. */
export async function upsertWorkflow(input: {
  userId: string;
  name: string;
  description: string;
  body: string;
  /** Model-written bodies get a notes heading; a hand-edit keeps what it has. */
  fromModel?: boolean;
}): Promise<{ id: string; name: string; created: boolean }> {
  const name = normaliseName(input.name);
  const description = normaliseDescription(input.description);
  const body = clipBody(input.fromModel ? newBody(input.body) : input.body);

  const existing = await db.workflow.findFirst({
    where: { name, ...visibleTo(input.userId) },
    select: { id: true, userId: true, members: { select: { userId: true } } },
  });
  if (existing && roleFor(existing, input.userId)) {
    await db.workflow.update({ where: { id: existing.id }, data: { description, body } });
    return { id: existing.id, name, created: false };
  }
  const made = await db.workflow.create({
    data: { userId: input.userId, name, description, body },
    select: { id: true },
  });
  return { id: made.id, name, created: true };
}

/**
 * Append one lesson. Deliberately NOT the same call as rewriting the body —
 * see the note on `appendNote` for why the assistant must not be able to
 * rewrite somebody's instructions in order to record what it learned.
 */
export async function noteWorkflow(workflowId: string, note: string): Promise<boolean> {
  const w = await db.workflow.findUnique({ where: { id: workflowId }, select: { body: true } });
  if (!w) return false;
  const body = appendNote(w.body, note);
  if (body === w.body) return false;
  await db.workflow.update({
    where: { id: workflowId },
    data: { body: clipBody(body), notedAt: new Date() },
  });
  return true;
}

// ---------------------------------------------------------------------------
// The two a new person starts with
// ---------------------------------------------------------------------------

/**
 * Seeded on a person's first visit to the Workflows page — never on a chat
 * turn, so nobody is given workflows they did not ask for and never look at.
 * They are examples as much as tools: the shape is what teaches someone how to
 * write their own.
 */
export const DEFAULT_WORKFLOWS = [
  {
    name: "Rewrite a document",
    description:
      "Rewrite or tighten anything already written — a document, a page, an email, a paragraph — in our tone.",
    body: `Use this whenever I hand you a document and ask for it to be rewritten,
tightened, or put into our tone.

## Ask first, once

- Who is going to read it?
- Should it stay the same length, or get shorter?

Ask both in one question. Don't ask anything else — make a sensible call and
tell me what you assumed.

## Rules

1. **Facts, names, figures and quotes are never changed.** If something looks
   wrong, rewrite it as-is and flag it underneath.
2. Plain British English. No "leverage", "utilise", "robust", "seamless".
3. Short sentences. One idea each.
4. Keep the original's structure unless it is genuinely getting in the way.
5. Anything you cut that might matter goes in a short list at the end so I can
   put it back.

## Give me back

The rewritten document in full, then a few bullets on what changed and why.

## Notes from past runs
`,
  },
  {
    name: "Reply to an email",
    description: "Draft a reply to an email I paste in, in my voice.",
    body: `Use this when I paste an email and ask for a reply.

## Rules

1. Work out what they actually want before writing anything. If the email asks
   three things, the reply answers three things.
2. Match their formality, one notch warmer.
3. No preamble. Don't open with "Thank you for reaching out".
4. If it needs a decision I haven't given you, don't invent one — leave a
   clearly marked gap like [decision needed: date] and tell me.
5. Short. If it runs past three paragraphs, ask whether a call would be better.

## Give me back

The reply, ready to send. Then one line on anything I need to check first.

## Notes from past runs
`,
  },
] as const;

/** Idempotent: only creates what is missing, so it is safe to call on every
 *  page load and a deleted default stays deleted. */
export async function ensureDefaults(userId: string): Promise<void> {
  const existing = await db.workflow.count({ where: { userId } });
  if (existing > 0) return;
  const shared = await db.workflowMember.count({ where: { userId } });
  if (shared > 0) return; // they already have workflows, just not their own
  for (const w of DEFAULT_WORKFLOWS) {
    await db.workflow
      .create({ data: { userId, name: w.name, description: w.description, body: w.body } })
      .catch(() => {
        /* a race on first load is fine — the other one won */
      });
  }
}
