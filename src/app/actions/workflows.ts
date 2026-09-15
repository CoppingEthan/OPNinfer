"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-helpers";
import {
  MAX_BODY_CHARS,
  canEdit,
  canLeave,
  canManage,
  clipBody,
  newBody,
  normaliseDescription,
  normaliseName,
  roleFor,
} from "@/lib/workflows";
import { ensureDefaults, listWorkflows, visibleTo, type WorkflowListItem } from "@/lib/workflow-store";

/**
 * Workflows — the actions behind the Workflows page.
 *
 * Sharing mirrors chats: the owner adds and removes people, a member leaves,
 * and everyone with access can edit the body. There is only ever ONE document,
 * so an edit is seen by everyone — which is why saving carries a stale-write
 * guard rather than last-writer-wins.
 */

export type Result = { error?: string; success?: string; id?: string };

const nameSchema = z.string().trim().min(1, "Give it a name.").max(60);
const bodySchema = z.string().max(MAX_BODY_CHARS + 5_000);

async function access(id: string, userId: string) {
  const w = await db.workflow.findUnique({
    where: { id },
    select: { userId: true, updatedAt: true, members: { select: { userId: true } } },
  });
  if (!w) return null;
  const role = roleFor(w, userId);
  return role ? { role, updatedAt: w.updatedAt } : null;
}

export interface WorkflowBrief {
  id: string;
  name: string;
  description: string;
}

/**
 * Just enough for the composer menu. Does NOT seed the defaults — that belongs
 * to the Workflows page, so opening a menu never quietly creates anything.
 */
export async function listMyWorkflowsBrief(): Promise<WorkflowBrief[]> {
  const user = await requireUser();
  const list = await listWorkflows(user.id);
  return list.map((w) => ({ id: w.id, name: w.name, description: w.description }));
}

/** The page's list. Seeds the two examples for someone who has none. */
export async function myWorkflows(): Promise<WorkflowListItem[]> {
  const user = await requireUser();
  await ensureDefaults(user.id);
  return listWorkflows(user.id);
}

export async function readWorkflow(
  id: string,
): Promise<{ body: string; name: string; description: string; updatedAt: string } | null> {
  const user = await requireUser();
  const w = await db.workflow.findFirst({
    where: { id, ...visibleTo(user.id) },
    select: { body: true, name: true, description: true, updatedAt: true },
  });
  return w ? { ...w, updatedAt: w.updatedAt.toISOString() } : null;
}

export async function createWorkflow(rawName: string): Promise<Result> {
  const user = await requireUser();
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const name = normaliseName(parsed.data);

  const clash = await db.workflow.findFirst({
    where: { userId: user.id, name },
    select: { id: true },
  });
  if (clash) return { error: `You already have a workflow called "${name}".` };

  const w = await db.workflow.create({
    data: {
      userId: user.id,
      name,
      description: "What this is for — edit me.",
      body: newBody(`Use this when…\n\n## Rules\n\n1. \n`),
    },
    select: { id: true },
  });
  revalidatePath("/workflows");
  return { success: "Created.", id: w.id };
}

/**
 * Save the body (and description) of a workflow.
 *
 * `seenUpdatedAt` is what the editor loaded. If the stored row has moved on,
 * somebody else — or the assistant, appending a note — has written since, and
 * saving would silently discard their change. A shared document that quietly
 * loses edits is worse than one that occasionally asks you to reload.
 */
export async function saveWorkflow(
  id: string,
  rawBody: string,
  rawDescription: string,
  seenUpdatedAt: string,
): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a || !canEdit(a.role)) return { error: "That workflow is no longer available to you." };

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) return { error: "That is too long to save." };

  if (seenUpdatedAt && a.updatedAt.toISOString() !== seenUpdatedAt) {
    return {
      error:
        "Someone else (or the assistant) changed this while you were editing. " +
        "Reload to see their version — your text is still in the box.",
    };
  }

  await db.workflow.update({
    where: { id },
    data: {
      body: clipBody(parsed.data),
      description: normaliseDescription(rawDescription) || "A saved way of doing a recurring job.",
    },
  });
  revalidatePath("/workflows");
  return { success: "Saved." };
}

export async function renameWorkflow(id: string, rawName: string): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a || !canManage(a.role)) return { error: "Only the owner can rename this." };
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const name = normaliseName(parsed.data);
  const clash = await db.workflow.findFirst({
    where: { userId: user.id, name, NOT: { id } },
    select: { id: true },
  });
  if (clash) return { error: `You already have a workflow called "${name}".` };

  await db.workflow.update({ where: { id }, data: { name } });
  revalidatePath("/workflows");
  return { success: "Renamed." };
}

export async function deleteWorkflow(id: string): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a) return { error: "That workflow is no longer available to you." };
  if (!canManage(a.role)) return { error: "Only the owner can delete this. You can leave it instead." };
  await db.workflow.delete({ where: { id } });
  revalidatePath("/workflows");
  return { success: "Deleted." };
}

// ---------------------------------------------------------------------------
// Sharing — the same rules as a chat
// ---------------------------------------------------------------------------

export interface WorkflowPerson {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export async function workflowPeople(
  id: string,
): Promise<{ owner: WorkflowPerson; members: WorkflowPerson[] } | null> {
  const user = await requireUser();
  const w = await db.workflow.findFirst({
    where: { id, ...visibleTo(user.id) },
    select: {
      userId: true,
      user: { select: { id: true, name: true, email: true, image: true } },
      members: {
        select: { user: { select: { id: true, name: true, email: true, image: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!w) return null;
  return {
    owner: w.user,
    // The owner has a member row too once shared (as with chats), so filter
    // them out of the "shared with" list rather than showing them twice.
    members: w.members.map((m) => m.user).filter((u) => u.id !== w.userId),
  };
}

export async function searchWorkflowPeople(id: string, rawQuery: string): Promise<WorkflowPerson[]> {
  const user = await requireUser();
  const q = String(rawQuery ?? "").trim().slice(0, 80);
  const a = await access(id, user.id);
  if (!a || !canManage(a.role)) return [];
  const already = await db.workflowMember.findMany({
    where: { workflowId: id },
    select: { userId: true },
  });
  const exclude = new Set([user.id, ...already.map((m) => m.userId)]);
  return db.user.findMany({
    where: {
      disabled: false,
      id: { notIn: [...exclude] },
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ name: "asc" }, { email: "asc" }],
    take: 8,
    select: { id: true, name: true, email: true, image: true },
  });
}

export async function shareWorkflow(id: string, userIds: string[]): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a || !canManage(a.role)) return { error: "Only the owner can share this." };
  if (userIds.length === 0) return { error: "Nobody selected." };

  const people = await db.user.findMany({
    where: { id: { in: userIds }, disabled: false },
    select: { id: true },
  });
  if (people.length === 0) return { error: "Those people are no longer available." };

  await db.$transaction(async (tx) => {
    // The owner gets a row too, the first time it is shared — "shared" is
    // then simply "has rows", exactly as with conversation_members.
    const rows = [user.id, ...people.map((p) => p.id)].map((uid) => ({
      workflowId: id,
      userId: uid,
      invitedById: uid === user.id ? null : user.id,
    }));
    await tx.workflowMember.createMany({ data: rows, skipDuplicates: true });
  });

  revalidatePath("/workflows");
  return { success: people.length === 1 ? "Shared." : `Shared with ${people.length} people.` };
}

export async function unshareWorkflow(id: string, userId: string): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a || !canManage(a.role)) return { error: "Only the owner can remove people." };
  await db.workflowMember.deleteMany({ where: { workflowId: id, userId } });

  // Last person out: drop the owner's own row so it reads as private again.
  const left = await db.workflowMember.count({ where: { workflowId: id, NOT: { userId: user.id } } });
  if (left === 0) await db.workflowMember.deleteMany({ where: { workflowId: id } });

  revalidatePath("/workflows");
  return { success: "Removed." };
}

export async function leaveWorkflow(id: string): Promise<Result> {
  const user = await requireUser();
  const a = await access(id, user.id);
  if (!a) return { error: "That workflow is no longer available to you." };
  if (!canLeave(a.role)) return { error: "You own this one — delete it instead." };
  await db.workflowMember.deleteMany({ where: { workflowId: id, userId: user.id } });
  revalidatePath("/workflows");
  return { success: "Left." };
}
