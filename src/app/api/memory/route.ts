import { readJsonBounded } from "@/lib/validation";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getMemoryConfig, loadTopics, resetMemory, setTopic } from "@/lib/tools/memory";
import { MEMORY_TOPICS, isTopicKey } from "@/lib/memory-topics";
import { runMemoryChat } from "@/lib/memory-chat";
import { audit } from "@/lib/audit";
import { devLog } from "@/lib/dev-log";

export const dynamic = "force-dynamic";

/**
 * The settings-panel "what the assistant knows about you" surface (memory v2):
 *   GET    — the four notes (+ when each changed), the person's pause switch,
 *            and the admin's settings the panel needs
 *   PATCH  — edit one note in full ({topic, text}) or flip the pause switch
 *            ({paused})
 *   DELETE — forget everything (?topic= to clear one note)
 *   POST   — one memory-chat turn (front-end role + the memory tools) → reply
 *            + the refreshed notes in the same response
 * All scoped to the session user — no cross-user access possible.
 */

async function snapshot(userId: string) {
  const [topics, user, cfg] = await Promise.all([
    loadTopics(userId),
    db.user.findUnique({ where: { id: userId }, select: { memoryPaused: true } }),
    getMemoryConfig(),
  ]);
  return {
    topics: topics.map((t) => {
      const meta = MEMORY_TOPICS.find((m) => m.key === t.key)!;
      return {
        key: t.key,
        label: meta.label,
        hint: meta.hint,
        text: t.text,
        updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
      };
    }),
    paused: !!user?.memoryPaused,
    adminPaused: cfg.paused,
    topicChars: cfg.topicChars,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await snapshot(session.user.id));
}

const patchSchema = z.union([
  z.object({ topic: z.string(), text: z.string().max(20_000) }),
  z.object({ paused: z.boolean() }),
]);

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await readJsonBounded(req));
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  if ("paused" in body) {
    await db.user.update({ where: { id: userId }, data: { memoryPaused: body.paused } });
    await audit(body.paused ? "memory.pause" : "memory.resume", { userId });
  } else {
    if (!isTopicKey(body.topic)) return Response.json({ error: "Unknown topic." }, { status: 400 });
    await setTopic(userId, body.topic, body.text);
    devLog("info", "memory", "note edited in settings", { userId, topic: body.topic, chars: body.text.length });
  }
  return Response.json(await snapshot(userId));
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  const topic = new URL(req.url).searchParams.get("topic");
  if (topic) {
    if (!isTopicKey(topic)) return Response.json({ error: "Unknown topic." }, { status: 400 });
    await setTopic(userId, topic, "");
  } else {
    const n = await resetMemory(userId);
    await audit("memory.reset", { userId, details: { notes: n } });
  }
  return Response.json(await snapshot(userId));
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  let history: { role: "user" | "assistant"; content: string }[];
  try {
    const body = (await readJsonBounded(req)) as { messages?: { role?: string; content?: string }[] };
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 24) {
      throw new Error("bad shape");
    }
    history = body.messages.map((m) => {
      const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
      const content = String(m.content ?? "").slice(0, 4_000);
      if (!role || !content.trim()) throw new Error("bad message");
      return { role, content } as const;
    });
    if (history[history.length - 1].role !== "user") throw new Error("last message must be the user");
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    const { reply } = await runMemoryChat(userId, history);
    return Response.json({ reply, ...(await snapshot(userId)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Memory chat failed.";
    devLog("error", "memory-chat", "turn failed", { userId, error: message });
    return Response.json({ error: message }, { status: 502 });
  }
}
