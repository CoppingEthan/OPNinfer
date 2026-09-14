import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { devLog } from "@/lib/dev-log";
import type { ToolDef } from "@/lib/providers/types";
import type { ToolCtx } from "./types";

/**
 * `search_my_chats` (memory v2, 0.5.1): let the assistant look things up in the
 * person's OWN past conversations — "what did we decide about the pricing
 * page last month?" — instead of expecting memory to hold everything. This
 * is Claude.ai's split: memory is a few notes, history is searched.
 *
 * Postgres full-text search over the messages of every chat the person owns
 * or is a member of, never incognito, never the chat they are in (that is
 * already in context). No vector store: a few thousand chats per person is
 * well within what `to_tsvector` handles in tens of milliseconds, and the
 * tool's contract (dated snippets with links) would not change if one were
 * added later.
 */

export const SEARCH_MY_CHATS_DEF: ToolDef = {
  name: "search_my_chats",
  description:
    "Search this user's OWN earlier conversations with you (not the current one) and get dated snippets with links. " +
    "Use it when they refer to something discussed or decided before — \"what did we agree about X\", \"the plan from last week\", \"that email you drafted for me\" — or when their question clearly depends on an earlier chat. " +
    "Matches ANY of the words you give and ranks by how many match, so use a handful of plain keywords (the topic, a name, a product, a date word) rather than a sentence; if the first try finds nothing relevant, try once more with different words. " +
    "Cite what you use by the chat's title and date, and ALWAYS give a markdown link to it using the path provided, e.g. [Team bio drafting](/chat/…). Not for general knowledge, files (use the file tools), or anything already in this conversation.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A few plain keywords — any of them may match. E.g. \"pricing page launch\", \"Acme contract\", \"week unwell\"." },
      limit: { type: "number", description: "How many matching chats to return (1–8, default 5)." },
    },
    required: ["query"],
  },
};

interface Hit {
  conversation_id: string;
  title: string;
  updated_at: Date;
  role: string;
  created_at: Date;
  snippet: string;
  rank: number;
}

export async function executeSearchMyChats(
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  const query = String(args.query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (query.length < 2) return "Error: give a query of at least two characters.";
  const limit = Math.min(8, Math.max(1, Math.trunc(Number(args.limit)) || 5));

  // ANY of the words, ranked by how many match — `plainto_tsquery` ANDs every
  // word, and a model guessing at phrasing ("ailment sick unwell this week")
  // then finds nothing when the chat said "hay fever". OR-ing the terms and
  // letting ts_rank sort keeps the strongest matches first.
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (terms.length === 0) return "Error: give a query with at least one word.";
  const tsq = terms.map((w) => `${w}:*`).join(" | ");

  // Own chats + chats shared with them; never incognito; never this chat.
  const rows = await db.$queryRaw<Hit[]>(Prisma.sql`
    with mine as (
      select c.id, c.title, c.updated_at
      from conversations c
      where c.incognito = false
        and c.id::text <> ${ctx.conversationId}
        and (c.user_id = ${ctx.userId}::uuid
             or exists (select 1 from conversation_members cm where cm.conversation_id = c.id and cm.user_id = ${ctx.userId}::uuid))
    ),
    q as (select to_tsquery('english', ${tsq}) as tsq)
    select m.conversation_id::text as conversation_id, mine.title, mine.updated_at, m.role::text as role, m.created_at,
           ts_headline('english', m.content, q.tsq,
                       'MaxWords=40, MinWords=20, MaxFragments=1, StartSel=«, StopSel=»') as snippet,
           ts_rank(to_tsvector('english', m.content), q.tsq) as rank
    from messages m
    join mine on mine.id = m.conversation_id
    cross join q
    where m.role in ('user', 'assistant')
      and to_tsvector('english', m.content) @@ q.tsq
    order by rank desc, m.created_at desc
    limit 40
  `);

  if (rows.length === 0) {
    // Keyword search can only find words that were actually used. Hand the
    // model the person's most recent chats instead, so it can search again
    // with words from a likely title or tell them where to look.
    const recent = await db.conversation.findMany({
      where: {
        incognito: false,
        id: { not: ctx.conversationId },
        OR: [{ userId: ctx.userId }, { members: { some: { userId: ctx.userId } } }],
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, title: true, updatedAt: true },
    });
    devLog("debug", "memory", "search_my_chats: no hits", { userId: ctx.userId, query, recent: recent.length });
    const list = recent
      .map((c) => `• "${c.title}" — ${new Date(c.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, link: /chat/${c.id}`)
      .join("\n");
    return (
      `No earlier chat of theirs contains any of the words "${query}". The search only matches words that were actually written, so try once more with different words if the topic might have been phrased another way. ` +
      (list ? `Their most recent chats, newest first:\n${list}` : "They have no other chats yet.")
    );
  }

  // Best snippet per chat, most relevant chats first, then by recency.
  const byChat = new Map<string, Hit[]>();
  for (const r of rows) {
    const list = byChat.get(r.conversation_id) ?? [];
    if (list.length < 2) list.push(r);
    byChat.set(r.conversation_id, list);
  }
  const chats = [...byChat.values()]
    .sort((a, b) => b[0].rank - a[0].rank || +b[0].updated_at - +a[0].updated_at)
    .slice(0, limit);

  const fmtDate = (d: Date) =>
    new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const out = chats
    .map((hits) => {
      const h = hits[0];
      // ts_headline needs non-empty markers (an empty StartSel is a syntax
      // error); they are stripped here so the model sees plain text.
      const lines = hits.map(
        (x) => `  ${x.role === "user" ? "They said" : "You said"} (${fmtDate(x.created_at)}): ${x.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}`,
      );
      return `• "${h.title}" — chat from ${fmtDate(h.updated_at)}, link: /chat/${h.conversation_id}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  devLog("debug", "memory", "search_my_chats", { userId: ctx.userId, query, chats: chats.length });
  return `${chats.length} earlier chat${chats.length === 1 ? "" : "s"} of theirs mention "${query}" (most relevant first). Cite by title and date; link with the path.\n\n${out}`;
}
