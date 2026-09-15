/**
 * Workflows — the RULES and the text handling, pure and client-safe.
 *
 * A workflow is a markdown playbook a PERSON owns: "how I want you to take a
 * document and rewrite it in our tone". It is deliberately the same shape as a
 * skill (`tools/skills.ts`) — name plus a one-line description ride every
 * turn, the body is fetched on demand — because that shape is already proven
 * cheap, and proven to get loaded at the right moment. The differences are
 * that a skill ships with the product and a workflow belongs to a user, who
 * can edit it by hand and share it with colleagues.
 *
 * Sharing copies shared chats exactly: ONE document plus rows in
 * `workflow_members`, so an edit by anyone with access is seen by everyone.
 * A copy that drifts would be worse than no sharing at all. The DB half lives
 * in `workflow-store.ts`; this file is the part worth unit-testing.
 */

export type WorkflowRole = "owner" | "member";

export interface WorkflowLike {
  userId: string;
  members?: { userId: string }[];
}

/** Longest a playbook may get. It is instructions, not a document store — and
 *  the body goes to the model verbatim when loaded, so it is also a cost. */
export const MAX_BODY_CHARS = 20_000;
/** The description rides EVERY turn for every workflow, so it stays short. */
export const MAX_DESCRIPTION_CHARS = 160;
export const MAX_NAME_CHARS = 60;
/** One lesson, not an essay. */
export const MAX_NOTE_CHARS = 300;
/** Keep the newest N notes. Without a cap a much-used workflow grows without
 *  bound and eventually crowds out its own instructions. */
export const MAX_NOTES = 20;
/** Bound on the per-turn block, so a hoarder cannot quietly inflate every
 *  prompt they send. */
export const MAX_LISTED = 25;

/** The heading the assistant appends under, and never writes above. */
export const NOTES_HEADING = "## Notes from past runs";

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  /** Set when this one reached you by being shared, for the L1 label. */
  sharedBy?: string | null;
}

/** The person's role, or null when the workflow is not theirs to see. */
export function roleFor(w: WorkflowLike, userId: string): WorkflowRole | null {
  if (w.userId === userId) return "owner";
  if (w.members?.some((m) => m.userId === userId)) return "member";
  return null;
}

/** Shared = at least one membership row, exactly as with chats. */
export function isShared(w: { members?: { userId: string }[] } | WorkflowLike): boolean {
  return (w.members?.length ?? 0) > 0;
}

/** Rename, delete, share, un-share: the owner's alone. */
export function canManage(role: WorkflowRole | null): boolean {
  return role === "owner";
}

/** Leave: members only — the owner deletes instead. */
export function canLeave(role: WorkflowRole | null): boolean {
  return role === "member";
}

/**
 * Read AND edit the body: anyone it is shared with.
 *
 * That is the point of sharing rather than copying — a colleague who spots
 * that step 4 is wrong can fix it for everybody, instead of keeping a private
 * copy that slowly diverges from the original.
 */
export function canEdit(role: WorkflowRole | null): boolean {
  return role !== null;
}

/** Load it, and let the assistant append notes to it. */
export function canUse(role: WorkflowRole | null): boolean {
  return role !== null;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Tidy a name: one line, trimmed, capped. A name addresses the workflow in
 *  the model's tool calls, so runs of whitespace collapse rather than
 *  survive. */
export function normaliseName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

export function normaliseDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Make every name in one person's view unique.
 *
 * The model addresses a workflow BY NAME, so two called "Rewrite a document" —
 * your own and one a colleague shared — would be an unresolvable instruction.
 * Yours keeps the plain name; a shared clash is suffixed with whoever shared
 * it, which is also the more useful label. A clash that survives that (two
 * colleagues called Sam) falls back to a number rather than silently
 * colliding.
 */
export function disambiguate(list: WorkflowSummary[]): WorkflowSummary[] {
  const seen = new Set<string>();
  const out: WorkflowSummary[] = [];
  // Own workflows first, so they are the ones that keep the plain name.
  const ordered = [...list].sort((a, b) => Number(!!a.sharedBy) - Number(!!b.sharedBy));
  for (const w of ordered) {
    let name = w.name;
    if (seen.has(name.toLowerCase())) {
      const first = (w.sharedBy ?? "").trim().split(/\s+/)[0];
      if (first) name = `${w.name} (from ${first})`;
    }
    let n = 1;
    const base = name;
    while (seen.has(name.toLowerCase())) {
      n += 1;
      name = `${base} ${n}`;
    }
    seen.add(name.toLowerCase());
    out.push({ ...w, name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-turn block (L1)
// ---------------------------------------------------------------------------

/**
 * What the model sees every turn: just enough to recognise that a request
 * matches one of this person's playbooks. The body costs a tool call.
 *
 * Null when they have none, so an instance nobody uses this on pays nothing.
 */
export function buildWorkflowsBlock(list: WorkflowSummary[]): string | null {
  const shown = disambiguate(list).slice(0, MAX_LISTED);
  if (shown.length === 0) return null;
  return (
    "WORKFLOWS — this person's own playbooks for jobs they repeat. If the " +
    "request matches one, call load_workflow FIRST and follow it: their way " +
    "of doing a thing beats your default way of doing it.\n" +
    "Do this even when the task looks small enough to just do — a short " +
    "rewrite is still a rewrite, and the workflow exists precisely because " +
    "their version differs from the obvious one. Match on the KIND of job, " +
    "not the size of it. Loading one costs a single call; getting it wrong " +
    "costs them the thing they wrote the workflow to avoid.\n" +
    shown
      .map((w) => `- ${w.name}: ${w.description}${w.sharedBy ? ` (shared by ${w.sharedBy})` : ""}`)
      .join("\n")
  );
}

// ---------------------------------------------------------------------------
// Notes — how a workflow learns
// ---------------------------------------------------------------------------

/**
 * Append one lesson under the notes heading, creating the section if needed.
 *
 * This is a SEPARATE operation from rewriting the body, and the split is the
 * whole safety story. A workflow is the user's own writing; an assistant that
 * can rewrite it wholesale in order to record "they prefer British spelling"
 * is one confused turn away from destroying instructions somebody carefully
 * wrote. Appending under a heading it owns can lose at most the notes.
 *
 * Oldest notes fall off at MAX_NOTES, so the section cannot outgrow the
 * playbook it is attached to.
 */
export function appendNote(body: string, note: string, when: Date = new Date()): string {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
  if (!clean) return body;
  const line = `- ${when.toISOString().slice(0, 10)} — ${clean}`;

  const idx = body.indexOf(NOTES_HEADING);
  if (idx === -1) return `${body.trimEnd()}\n\n${NOTES_HEADING}\n\n${line}\n`;

  const head = body.slice(0, idx);
  const rest = body.slice(idx + NOTES_HEADING.length);
  // The section runs to the next heading of the same level or higher.
  const next = rest.search(/\n#{1,2} /);
  const section = next === -1 ? rest : rest.slice(0, next);
  const tail = next === -1 ? "" : rest.slice(next);

  const notes = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
  notes.push(line);

  return `${head}${NOTES_HEADING}\n\n${notes.slice(-MAX_NOTES).join("\n")}\n${tail}`;
}

/** Trim a body to the cap on a line boundary, so a save never ends mid-word. */
export function clipBody(raw: string): string {
  if (raw.length <= MAX_BODY_CHARS) return raw;
  const cut = raw.slice(0, MAX_BODY_CHARS);
  const nl = cut.lastIndexOf("\n");
  return (nl > MAX_BODY_CHARS * 0.8 ? cut.slice(0, nl) : cut).trimEnd();
}

/** What a brand-new, model-created workflow looks like before anyone edits
 *  it — the heading is there from the start so the first note has a home. */
export function newBody(steps: string): string {
  return `${steps.trim()}\n\n${NOTES_HEADING}\n`;
}
