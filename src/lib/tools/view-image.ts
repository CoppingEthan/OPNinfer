import "server-only";
import { db } from "@/lib/db";
import { loadImageForVision } from "@/lib/file-tools";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx, ToolOutput } from "./types";

/**
 * view_image (v0.3 step 4) — token-efficient vision: instead of re-inlining
 * every image into every turn, the model pulls a specific image from the
 * conversation pool ON DEMAND. The image rides back as a native vision part
 * (the loop attaches it as a user turn; Anthropic merges it into the
 * tool-result turn to keep roles alternating).
 */

export const VIEW_IMAGE_DEF: ToolDef = {
  name: "view_image",
  description:
    "Look at an image from this conversation's files (uploaded or generated) by exact filename. The image is attached for you to see. Use whenever you need to (re-)examine an image's contents.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact image filename from the file list (e.g. photo.png).",
      },
    },
    required: ["name"],
  },
};

export async function executeViewImage(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string | ToolOutput> {
  const name = String(args.name ?? "").trim();
  if (!name) return "Error: name is required.";
  const loaded = await loadImageForVision(ctx.conversationId, name);
  if (typeof loaded === "string") return loaded; // friendly error
  // The viewed image joins the reply's sources so the user sees what was read.
  const row = await db.file.findFirst({
    where: { conversationId: ctx.conversationId, filename: name },
    select: { id: true },
  });
  return {
    text: `Attached "${name}" (${loaded.mimeType}) — it follows this message for you to view.`,
    images: [loaded],
    ...(row
      ? { sources: [{ kind: "file" as const, fileId: row.id, url: `/api/files/${row.id}`, title: name }] }
      : {}),
  };
}
