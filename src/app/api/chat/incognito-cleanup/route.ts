import { readJsonBounded } from "@/lib/validation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { purgeConversationStorage } from "@/lib/storage";
import { abortTurn } from "@/lib/turn-stream";
import { clearQueued } from "@/lib/chat-queue";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/incognito-cleanup — delete an incognito conversation when the
 * user leaves it or closes the tab (spec §10). Called via navigator.sendBeacon,
 * so the body is plain text JSON: { id }. Only deletes conversations that are
 * (a) owned by the caller and (b) actually flagged incognito. As with any
 * delete, billing/audit records survive.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 204 });

  let id: string | undefined;
  try {
    const parsed = await readJsonBounded(req);
    id = typeof parsed?.id === "string" ? parsed.id : undefined;
  } catch {
    return new Response(null, { status: 204 });
  }
  if (!id) return new Response(null, { status: 204 });

  // Capture the pool contents before the cascade removes the file rows, so
  // the incognito chat's uploads are wiped from disk too.
  const convo = await db.conversation.findFirst({
    where: { id, userId: session.user.id, incognito: true },
    select: { id: true, files: { select: { storagePath: true } } },
  });
  if (!convo) return new Response(null, { status: 204 });

  // A reply may still be generating (turns run detached from the client) —
  // abort it before the cascade so its save doesn't FK-fail into the void.
  abortTurn(convo.id);
  clearQueued(convo.id);
  await db.conversation.delete({ where: { id: convo.id } });
  await purgeConversationStorage([convo]);
  await audit("conversation.incognito_wipe", {
    userId: session.user.id,
    details: { id },
  });
  return new Response(null, { status: 204 });
}
