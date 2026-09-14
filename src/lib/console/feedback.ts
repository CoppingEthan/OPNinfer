import "server-only";
import { fanOut } from "./db";

/**
 * Every thumbs-rated reply across every portal.
 *
 * `message_feedback` is a permanent snapshot table — it survives the chat
 * being deleted — so this is the one view of quality that stays honest over
 * time. The AI "why" analysis each row carries is written by the portal's own
 * front-end model at rating time; the console just reads it.
 */

export interface ConsoleFeedback {
  portal: string;
  portalLabel: string;
  id: string;
  rating: "up" | "down" | string;
  model: string | null;
  provider: string | null;
  user: string | null;
  conversationTitle: string | null;
  userText: string;
  assistantText: string;
  summary: string | null;
  createdAt: string;
}

export interface FeedbackView {
  entries: ConsoleFeedback[];
  counts: { up: number; down: number };
  /** Per portal, so a single client's dip is visible rather than averaged away. */
  byPortal: { portal: string; label: string; up: number; down: number }[];
  errors: { portal: string; error: string }[];
}

/** How many rated exchanges to pull per portal. */
const LIMIT = 100;

export async function getFeedback(filter: "all" | "up" | "down" = "all"): Promise<FeedbackView> {
  const results = await fanOut(async (db, instance) => {
    const where = filter === "all" ? {} : { rating: filter };
    const [rows, counts] = await Promise.all([
      db.messageFeedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: LIMIT,
        include: { user: { select: { email: true } } },
      }),
      db.messageFeedback.groupBy({ by: ["rating"], _count: true }),
    ]);
    return {
      entries: rows.map(
        (r): ConsoleFeedback => ({
          portal: instance.name,
          portalLabel: instance.label,
          id: r.id,
          rating: r.rating,
          model: r.model,
          provider: r.provider,
          user: r.user?.email ?? null,
          conversationTitle: r.conversationTitle,
          userText: r.userText,
          assistantText: r.assistantText,
          summary: r.summary,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
      up: counts.find((c) => c.rating === "up")?._count ?? 0,
      down: counts.find((c) => c.rating === "down")?._count ?? 0,
    };
  });

  const entries = results
    .flatMap((r) => r.data?.entries ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    entries,
    counts: {
      up: results.reduce((n, r) => n + (r.data?.up ?? 0), 0),
      down: results.reduce((n, r) => n + (r.data?.down ?? 0), 0),
    },
    byPortal: results
      .filter((r) => r.data)
      .map((r) => ({
        portal: r.instance.name,
        label: r.instance.label,
        up: r.data!.up,
        down: r.data!.down,
      })),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ portal: r.instance.label, error: r.error! })),
  };
}
