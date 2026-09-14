import { auth } from "@/auth";
import { db } from "@/lib/db";
import { chatWhereFor } from "@/lib/chat-access";

export const dynamic = "force-dynamic";

/** Extract a ~100-char window around the first match for a result preview. */
function makeSnippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  if (idx === -1) return flat(content.slice(0, 100));
  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + q.length + 60);
  let s = flat(content.slice(start, end));
  if (start > 0) s = `… ${s}`;
  if (end < content.length) s = `${s} …`;
  return s;
}

/**
 * GET /api/search?q= — search the current user's conversations by title AND
 * message content (case-insensitive), newest first. Returns up to 30 hits with
 * a snippet of the first matching message. Scoped to the session user.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ results: [] });

  // Your own chats AND the ones shared with you (v0.5).
  const convos = await db.conversation.findMany({
    where: {
      AND: [chatWhereFor(userId)],
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        {
          messages: {
            some: {
              content: { contains: q, mode: "insensitive" },
              role: { in: ["user", "assistant"] },
            },
          },
        },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      messages: {
        where: {
          content: { contains: q, mode: "insensitive" },
          role: { in: ["user", "assistant"] },
        },
        select: { content: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  const results = convos.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
    snippet: c.messages[0] ? makeSnippet(c.messages[0].content, q) : undefined,
  }));

  return Response.json({ results });
}
