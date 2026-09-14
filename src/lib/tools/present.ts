import "server-only";
import { db } from "@/lib/db";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx, ToolOutput } from "./types";

/**
 * File presentation (owner ask, 2026-07-19): the conversation pool is the
 * assistant's WORKSPACE — files it writes there are invisible to the user by
 * default. This tool is the deliberate hand-over: presented files attach to
 * the CURRENT reply (images render inline like generated images; everything
 * else becomes a download card). Before this, every file a turn created was
 * auto-attached — a 10-script task flooded the chat with 11 cards when the
 * user only wanted results.csv.
 *
 * Presentation is per-message and repeatable: the user can ask for the
 * hidden script later and the model presents it onto that reply.
 */

export const PRESENT_FILES_DEF: ToolDef = {
  name: "present_files",
  description:
    "Show files from this conversation's workspace to the USER — files you create are NOT visible to them until presented. Present the deliverable(s) the user actually asked for (results, documents, charts), not your working files (scripts, intermediates) unless they want those too. Images render inline in the chat; other files become download cards. Can present any existing file, including ones from earlier turns.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Filenames to present, e.g. [\"results.csv\"].",
      },
    },
    required: ["names"],
  },
};

export async function executePresentFiles(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolOutput> {
  const names = Array.isArray(args.names)
    ? [...new Set(args.names.map((n) => String(n).trim()).filter(Boolean))]
    : [];
  if (names.length === 0) return { text: "Error: names must be a non-empty array of filenames." };

  const rows = await db.file.findMany({
    where: { conversationId: ctx.conversationId, filename: { in: names } },
    select: { filename: true },
  });
  const found = new Set(rows.map((r) => r.filename));
  const presented = names.filter((n) => found.has(n));
  const missing = names.filter((n) => !found.has(n));

  const parts: string[] = [];
  if (presented.length) {
    parts.push(`Presented to the user: ${presented.join(", ")}. They can now see and download ${presented.length === 1 ? "it" : "them"} — no need to describe the contents in detail or repeat them as text.`);
  }
  if (missing.length) {
    parts.push(`Error: no file named ${missing.map((n) => `"${n}"`).join(", ")} in this conversation — check list_files for exact names.`);
  }
  return { text: parts.join("\n"), ...(presented.length ? { presented } : {}) };
}
